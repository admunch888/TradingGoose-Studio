/**
 * @vitest-environment node
 *
 * A market request must never answer with something that is not a market error:
 * the widget reads this body as the user-visible reason a chart failed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getEffectiveDecryptedEnv: vi.fn(),
  getSession: vi.fn(),
  executeProviderRequest: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}))

vi.mock('@/providers/market', () => ({
  executeProviderRequest: (...args: unknown[]) => mocks.executeProviderRequest(...args),
}))

vi.mock('@/lib/auth', () => ({
  getSession: (...args: unknown[]) => mocks.getSession(...args),
}))

vi.mock('@/lib/environment/utils', () => ({
  getEffectiveDecryptedEnv: (...args: unknown[]) => mocks.getEffectiveDecryptedEnv(...args),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: () => mocks.logger,
}))

/** What providers/trading/portfolio-utils.ts fetchBrokerJson throws on a refused connection. */
const brokerConnectionRefused = () =>
  Object.assign(new TypeError('Unable to connect. Is the computer able to access the url?'), {
    name: 'TradingBrokerRequestError',
    providerId: 'ibkr',
    // The shared helper reports a transport failure as status 0, which is not
    // an HTTP status and must never be forwarded as one.
    status: 0,
    url: 'http://127.0.0.1:5000/v1/api/iserver/secdef/search',
  })

const brokerHttpError = (status: number) =>
  Object.assign(new Error(`Broker request failed with status ${status}`), {
    name: 'TradingBrokerRequestError',
    providerId: 'ibkr',
    status,
    url: 'http://127.0.0.1:5000/v1/api/iserver/accounts',
    payload: { error: `broker rejected the request with ${status}` },
  })

const marketSeriesBody = {
  provider: 'ibkr',
  kind: 'series' as const,
  workspaceId: 'ws-1',
  listing: {
    listing_id: 'AAPL',
    base_id: '',
    quote_id: '',
    listing_type: 'default' as const,
  },
  interval: '1d',
  windows: [{ mode: 'bars' as const, barCount: 100 }],
}

const handleMarketRequest = async (body: unknown) => {
  const { handleMarketProviderRequest } = await import('./handler')
  return handleMarketProviderRequest({
    body: body as never,
    providerId: 'ibkr',
    requestId: 'market-handler-test-1',
    startTime: Date.now(),
  })
}

describe('handleMarketProviderRequest error responses', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } })
    mocks.getEffectiveDecryptedEnv.mockResolvedValue({})
  })

  it('answers a refused connection with a market error instead of an invalid status', async () => {
    mocks.executeProviderRequest.mockRejectedValue(brokerConnectionRefused())

    const response = await handleMarketRequest(marketSeriesBody)

    expect(response.status).toBe(502)
    const payload = (await response.json()) as { error?: Record<string, unknown> }
    expect(payload.error).toMatchObject({
      code: 'PROVIDER ERROR',
      message: 'Unable to connect. Is the computer able to access the url?',
      provider: 'ibkr',
    })
  })

  it.each([
    ['a zero status', 0],
    ['a status above the HTTP range', 700],
    ['a negative status', -1],
  ])('refuses to emit %s', async (_label, status) => {
    mocks.executeProviderRequest.mockRejectedValue(brokerHttpError(status))

    const response = await handleMarketRequest(marketSeriesBody)

    expect(response.status).toBe(502)
    const payload = (await response.json()) as { error?: Record<string, unknown> }
    expect(payload.error?.code).toBe('PROVIDER ERROR')
  })

  it('still carries a real broker status through', async () => {
    mocks.executeProviderRequest.mockRejectedValue(brokerHttpError(401))

    const response = await handleMarketRequest(marketSeriesBody)

    expect(response.status).toBe(401)
    const payload = (await response.json()) as { error?: Record<string, unknown> }
    expect(payload.error?.code).toBe('PROVIDER ERROR')
    expect(String(payload.error?.message)).toContain('log in at the gateway URL')
  })

  it('keeps a market-defined status as-is', async () => {
    const { MarketProviderError } = await import('@/providers/market/errors')
    mocks.executeProviderRequest.mockRejectedValue(
      new MarketProviderError({
        code: 'LISTING RESOLVE FAILED',
        message: 'Listing could not be resolved',
        provider: 'ibkr',
        status: 422,
      })
    )

    const response = await handleMarketRequest(marketSeriesBody)

    expect(response.status).toBe(422)
    const payload = (await response.json()) as { error?: Record<string, unknown> }
    expect(payload.error?.code).toBe('LISTING RESOLVE FAILED')
  })
})

/**
 * A listing supplied BY IDENTITY (no catalogue row: measured for IBKR futures
 * MES) has to survive the request boundary untouched - the provider is what
 * decides whether the symbol resolves, and its own error is what the operator
 * reads when it does not.
 */
describe('handleMarketProviderRequest listings supplied by identity', () => {
  const manualListing = {
    listing_id: 'MESZ26',
    base_id: '',
    quote_id: '',
    listing_type: 'default' as const,
    manual: { assetClass: 'future' as const, marketCode: 'CME' },
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } })
    mocks.getEffectiveDecryptedEnv.mockResolvedValue({})
  })

  it('hands the manual identity to the provider exactly as the chart built it', async () => {
    mocks.executeProviderRequest.mockResolvedValue({ bars: [] })

    const response = await handleMarketRequest({ ...marketSeriesBody, listing: manualListing })

    expect(response.status).toBe(200)
    expect(mocks.executeProviderRequest).toHaveBeenCalledTimes(1)
    expect(mocks.executeProviderRequest.mock.calls[0][1]).toMatchObject({ listing: manualListing })
  })

  it('surfaces the provider error for an unresolvable identity and charts nothing', async () => {
    const { MarketProviderError } = await import('@/providers/market/errors')
    // The real message IBKR produces for a contract month it does not list.
    mocks.executeProviderRequest.mockRejectedValue(
      new MarketProviderError({
        code: 'PROVIDER ERROR',
        message:
          'MESZ25 is not a contract month IBKR offers for MES. Available: SEP26, DEC26. ' +
          'December 2025 is in the past - the contract has expired.',
        provider: 'ibkr',
        status: 502,
      })
    )

    const response = await handleMarketRequest({ ...marketSeriesBody, listing: manualListing })

    expect(response.status).toBe(502)
    const payload = (await response.json()) as {
      error?: Record<string, unknown>
      bars?: unknown[]
    }
    expect(payload.error?.message).toContain('Available: SEP26, DEC26')
    expect(payload.bars).toBeUndefined()
  })
})
