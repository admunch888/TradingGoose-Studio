/**
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  fetchMock,
  mockReadServerJsonCache,
  mockResolveMarketApiServiceConfig,
  mockWriteServerJsonCache,
} = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  mockReadServerJsonCache: vi.fn(),
  mockResolveMarketApiServiceConfig: vi.fn(),
  mockWriteServerJsonCache: vi.fn(),
}))

vi.mock('@/lib/cache/server-json-cache', () => ({
  readServerJsonCache: (...args: unknown[]) => mockReadServerJsonCache(...args),
  writeServerJsonCache: (...args: unknown[]) => mockWriteServerJsonCache(...args),
}))

vi.mock('@/lib/system-services/runtime', () => ({
  resolveMarketApiServiceConfig: (...args: unknown[]) => mockResolveMarketApiServiceConfig(...args),
}))

describe('TradingGoose Market request gate', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    mockResolveMarketApiServiceConfig.mockResolvedValue({
      apiKey: 'market-secret',
      baseUrl: 'https://market.example.com',
    })
  })

  it('returns cached search responses before fetching upstream', async () => {
    mockReadServerJsonCache.mockResolvedValue({
      body: '{"data":[]}',
      headers: [['content-type', 'application/json']],
      status: 200,
    })

    const { requestTradingGooseMarket } = await import('./request-gate')
    const response = await requestTradingGooseMarket('/api/search?version=v1')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [] })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockWriteServerJsonCache).not.toHaveBeenCalled()
  })

  it('uses a global cache key independent of caller headers and query param order', async () => {
    mockReadServerJsonCache.mockResolvedValue(null)
    fetchMock.mockImplementation(
      () =>
        new Response('{"data":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )

    const { requestTradingGooseMarket } = await import('./request-gate')
    await requestTradingGooseMarket('/api/search?b=2&a=1', {
      headers: { 'x-user-id': 'user-1' },
    })
    await requestTradingGooseMarket('/api/search?a=1&b=2', {
      headers: { 'x-user-id': 'user-2' },
    })

    expect(mockReadServerJsonCache.mock.calls[0]?.[0]).toBe(
      mockReadServerJsonCache.mock.calls[1]?.[0]
    )
    expect(mockWriteServerJsonCache.mock.calls[0]?.[0]).toBe(
      mockWriteServerJsonCache.mock.calls[1]?.[0]
    )
  })

  it('deduplicates concurrent identical get misses in the current process', async () => {
    mockReadServerJsonCache.mockResolvedValue(null)
    let resolveFetch: (value: Response) => void = () => {}
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
    )

    const { requestTradingGooseMarket } = await import('./request-gate')
    const first = requestTradingGooseMarket('/api/get/listing?id=AAPL')
    const second = requestTradingGooseMarket('/api/get/listing?id=AAPL')

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    resolveFetch(
      new Response('{"data":{"id":"AAPL"}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )

    const [firstResponse, secondResponse] = await Promise.all([first, second])
    expect(await firstResponse.json()).toEqual({ data: { id: 'AAPL' } })
    expect(await secondResponse.json()).toEqual({ data: { id: 'AAPL' } })
    const freshWrites = mockWriteServerJsonCache.mock.calls.filter(([key]) =>
      String(key).startsWith('market:request:v1:')
    )
    expect(freshWrites).toHaveLength(1)
  })

  it('does not read or write cache for update requests', async () => {
    mockReadServerJsonCache.mockResolvedValue({
      body: '{"cached":true}',
      headers: [['content-type', 'application/json']],
      status: 200,
    })
    fetchMock.mockResolvedValue(
      new Response('{"fresh":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )

    const { requestTradingGooseMarket } = await import('./request-gate')
    const response = await requestTradingGooseMarket('/api/update/listing-rank', {
      body: '{"listing_id":"AAPL"}',
      method: 'POST',
    })

    expect(mockReadServerJsonCache).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await response.json()).toEqual({ fresh: true })
    expect(mockWriteServerJsonCache).not.toHaveBeenCalled()
  })

  it('does not cache validate-key requests', async () => {
    mockReadServerJsonCache.mockResolvedValue({
      body: '{"cached":true}',
      headers: [['content-type', 'application/json']],
      status: 200,
    })
    fetchMock.mockResolvedValue(
      new Response('{"fresh":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )

    const { requestTradingGooseMarket } = await import('./request-gate')
    const response = await requestTradingGooseMarket('/api/validate-key/get-api-keys', {
      body: '{"userId":"user-1"}',
      method: 'POST',
    })

    expect(mockReadServerJsonCache).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await response.json()).toEqual({ fresh: true })
    expect(mockWriteServerJsonCache).not.toHaveBeenCalled()
  })

  it('injects the central TradingGoose-Market service credential', async () => {
    mockReadServerJsonCache.mockResolvedValue(null)
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))

    const { requestTradingGooseMarket } = await import('./request-gate')
    await requestTradingGooseMarket('/api/search?version=v1', {
      headers: { 'x-api-key': 'caller-key' },
    })

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('x-api-key')).toBe('market-secret')
  })

  it('caches listing rows for hours and keeps a last good copy', async () => {
    mockReadServerJsonCache.mockResolvedValue(null)
    fetchMock.mockResolvedValue(new Response('{"data":{"id":"AAPL"}}', { status: 200 }))

    const { requestTradingGooseMarket } = await import('./request-gate')
    await requestTradingGooseMarket('/api/get/listing?listing_id=AAPL')

    const writes = mockWriteServerJsonCache.mock.calls.map(([key, , ttl]) => [
      String(key).split(':').slice(0, 3).join(':'),
      ttl,
    ])
    expect(writes).toEqual([
      ['market:request:v1', 60 * 60 * 6],
      ['market:request:stale', 60 * 60 * 24 * 7],
    ])
  })

  it('stops calling the catalogue after a rate-limit refusal until Retry-After passes', async () => {
    mockReadServerJsonCache.mockResolvedValue(null)
    fetchMock.mockImplementation(
      () =>
        new Response('{"error":"Free tier rate limit exceeded. Max 100 requests per minute."}', {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '30' },
        })
    )

    const { requestTradingGooseMarket } = await import('./request-gate')
    const first = await requestTradingGooseMarket('/api/search?search_query=MES')
    const second = await requestTradingGooseMarket('/api/search?search_query=MESZ26')
    const update = await requestTradingGooseMarket('/api/update/listing-rank', {
      body: '{}',
      method: 'POST',
    })

    expect(first.status).toBe(429)
    expect(second.status).toBe(429)
    expect(update.status).toBe(429)
    expect(await second.json()).toEqual({
      error: 'Free tier rate limit exceeded. Max 100 requests per minute.',
    })
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mockWriteServerJsonCache).not.toHaveBeenCalled()
  })

  it('serves the last good listing row while the catalogue refuses', async () => {
    const stale = {
      body: '{"data":{"id":"AAPL"}}',
      headers: [['content-type', 'application/json']],
      status: 200,
    }
    mockReadServerJsonCache.mockImplementation(async (key: string) =>
      key.startsWith('market:request:stale:') ? stale : null
    )
    fetchMock.mockResolvedValue(
      new Response('{"error":"rate limited"}', { status: 429, headers: { 'retry-after': '60' } })
    )

    const { requestTradingGooseMarket } = await import('./request-gate')
    const refused = await requestTradingGooseMarket('/api/get/listing?listing_id=AAPL')
    const cooling = await requestTradingGooseMarket('/api/get/listing?listing_id=AAPL')

    expect(refused.status).toBe(200)
    expect(await cooling.json()).toEqual({ data: { id: 'AAPL' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reads Retry-After as seconds or a date, within bounds', async () => {
    const { parseRetryAfterMs } = await import('./request-gate')
    const now = Date.parse('2026-09-13T12:00:00Z')

    expect(parseRetryAfterMs('30', now)).toBe(30_000)
    expect(parseRetryAfterMs(null, now)).toBe(60_000)
    expect(parseRetryAfterMs('nonsense', now)).toBe(60_000)
    expect(parseRetryAfterMs('3600', now)).toBe(5 * 60_000)
    expect(parseRetryAfterMs('Sun, 13 Sep 2026 12:00:45 GMT', now)).toBe(45_000)
  })
})
