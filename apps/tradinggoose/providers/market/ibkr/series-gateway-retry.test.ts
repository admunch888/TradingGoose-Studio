/**
 * @vitest-environment node
 *
 * The user-facing path, end to end: `fetchIbkrSeries` for a 300-500 bar window
 * while the gateway is refusing. Before the pacing/retry wiring this call threw
 * `Broker request failed with status 429` and the whole 'Historical Data ->
 * Kronos Forecast' run died; the live log held ~37 of those in 10 seconds.
 *
 * Only the two gateway reads that stand between the request and the HTTP call
 * are stubbed (the session handshake and the conid lookup); the provider's own
 * request is driven against a stubbed global fetch, so the retry under test is
 * the real one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/providers/trading/ibkr/session', () => ({
  ensureIbkrSession: vi.fn(async () => undefined),
}))

vi.mock('@/providers/trading/ibkr/symbols', () => ({
  resolveIbkrConidFromApi: vi.fn(async () => ({ conid: 265598, conidSpec: 'STK' })),
}))

vi.mock('@/providers/market/utils', () => ({
  resolveProviderSymbol: () => 'AAPL',
  resolveListingContext: async () => ({
    listing: { symbol: 'AAPL' },
    base: 'AAPL',
    quote: 'USD',
    marketCode: 'XNAS',
    assetClass: 'stock',
    timeZoneName: 'America/New_York',
  }),
}))

import { resetIbkrPacingForTests } from '@/providers/market/ibkr/pacing'
import { fetchIbkrSeries } from '@/providers/market/ibkr/series'

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const request = {
  listing: { symbol: 'AAPL' },
  start: Date.UTC(2025, 0, 1),
  end: Date.UTC(2026, 0, 1),
  interval: '1d',
} as never

beforeEach(() => {
  // Keep the shared pacer's real sleeps negligible: these assertions are about
  // the retry happening at all, not about the exact backoff (that is pinned
  // with an injected clock in pacing.test.ts).
  process.env.IBKR_MARKET_MIN_INTERVAL_MS = '0'
  process.env.IBKR_MARKET_RETRY_BASE_MS = '1'
  process.env.IBKR_MARKET_RETRY_MAX_MS = '2'
  process.env.IBKR_MARKET_RETRY_MAX_ATTEMPTS = '4'
  process.env.IBKR_MARKET_RETRY_BUDGET_MS = '5000'
  resetIbkrPacingForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const key of [
    'IBKR_MARKET_MIN_INTERVAL_MS',
    'IBKR_MARKET_RETRY_BASE_MS',
    'IBKR_MARKET_RETRY_MAX_MS',
    'IBKR_MARKET_RETRY_MAX_ATTEMPTS',
    'IBKR_MARKET_RETRY_BUDGET_MS',
  ]) {
    delete process.env[key]
  }
  resetIbkrPacingForTests()
})

describe('fetchIbkrSeries against a refusing gateway', () => {
  it('retries a 429 and returns the requested bars', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'Pacing violation: repeated request' }, 429))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ t: Date.UTC(2026, 0, 2) / 1000, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }],
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    const series = await fetchIbkrSeries(request)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(series.bars).toHaveLength(1)
    expect(series.bars[0]?.close).toBe(1.5)
  })

  it('retries a 503 the same way', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'Service Unavailable' }, 503))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ t: Date.UTC(2026, 0, 2) / 1000, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }],
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    const series = await fetchIbkrSeries(request)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(series.bars).toHaveLength(1)
  })

  it('keeps bar prices as IBKR sends them when the response carries a priceFactor', async () => {
    // IBKR's documented AAPL history response: `priceFactor` 100 scales only the
    // encoded `high`/`low` envelope strings, not the bars.
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        symbol: 'AAPL',
        priceFactor: 100,
        high: '21394/266616.18/1440',
        low: '20425/0/8640',
        data: [{ t: 1747229400000, o: 212.43, h: 213.94, l: 210.58, c: 212.33, v: 266616.18 }],
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const series = await fetchIbkrSeries(request)

    expect(series.bars[0]).toMatchObject({ open: 212.43, high: 213.94, low: 210.58, close: 212.33 })
  })

  it('fails fast on a 401 without a single retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'not authenticated' }, 401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchIbkrSeries(request)).rejects.toThrow(/401/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
