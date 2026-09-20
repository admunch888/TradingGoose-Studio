/**
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  fetchMock,
  mockBuildIbkrApiUrl,
  mockEnsureIbkrSession,
  mockFetchIbkrMarketJson,
  mockResolveIbkrConidFromApi,
} = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  mockBuildIbkrApiUrl: vi.fn((path: string) => `https://gateway.local/v1/api${path}`),
  mockEnsureIbkrSession: vi.fn(),
  mockFetchIbkrMarketJson: vi.fn(),
  mockResolveIbkrConidFromApi: vi.fn(),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('@/providers/market/ibkr/pacing', () => ({
  fetchIbkrMarketJson: (...args: unknown[]) => mockFetchIbkrMarketJson(...args),
}))

vi.mock('@/providers/trading/ibkr/auth', () => ({
  buildIbkrAuthHeaders: () => ({ Accept: 'application/json' }),
  isIbkrHostedApi: () => false,
}))

vi.mock('@/providers/trading/ibkr/client', () => ({
  buildIbkrApiUrl: (...args: unknown[]) => mockBuildIbkrApiUrl(...(args as [string])),
}))

vi.mock('@/providers/trading/ibkr/session', () => ({
  ensureIbkrSession: (...args: unknown[]) => mockEnsureIbkrSession(...args),
}))

vi.mock('@/providers/trading/ibkr/symbols', () => ({
  resolveIbkrConidFromApi: (...args: unknown[]) => mockResolveIbkrConidFromApi(...args),
}))

import { fetchVolatilityContext, isStale, type VolatilityQuote } from '@/lib/market/volatility'
import { yahooRequestPolicy } from '@/providers/market/yahoo-finance/request-policy'

const VIX_CONID = 13455763
const VIX3M_CONID = 13455764

const VIX_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=1d&interval=5m'
const VIX3M_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX3M?range=1d&interval=5m'

/** 2026-09-18T20:15:01Z - the `regularMarketTime` of the captured payloads. */
const CAPTURED_QUOTE_EPOCH_SECONDS = 1789762501
const CAPTURED_QUOTE_ISO = '2026-09-18T20:15:01.000Z'

/**
 * A trimmed capture of
 * `curl 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=1d&interval=5m'`
 * taken 2026-09-18. The meta block is verbatim apart from the fields dropped;
 * the bar arrays keep the first two bars and the last one (`15.07` open, a
 * 14.81 close) rather than all 157. `chartPreviousClose` 15.44 is kept because
 * it is the field NOT to mistake for today's open.
 */
const capturedVixPayload = {
  chart: {
    result: [
      {
        meta: {
          currency: 'USD',
          symbol: '^VIX',
          exchangeName: 'CXI',
          fullExchangeName: 'Cboe Indices',
          instrumentType: 'INDEX',
          regularMarketTime: CAPTURED_QUOTE_EPOCH_SECONDS,
          regularMarketPrice: 14.81,
          regularMarketChangePercent: -4.08,
          regularMarketDayHigh: 15.63,
          regularMarketDayLow: 14.8,
          chartPreviousClose: 15.44,
          previousClose: 15.44,
          longName: 'CBOE Volatility Index',
          shortName: 'CBOE Volatility Index',
          currentTradingPeriod: {
            regular: {
              timezone: 'CDT',
              start: 1789714800,
              end: 1789762500,
            },
          },
        },
        timestamp: [1789715700, 1789716000, 1789762500],
        indicators: {
          quote: [
            {
              open: [15.069999694824219, 15.0600004196167, 14.8100004196167],
              high: [15.079999923706055, 15.069999694824219, 14.8100004196167],
              low: [15.0600004196167, 15.0600004196167, 14.8100004196167],
              close: [15.0600004196167, 15.0600004196167, 14.8100004196167],
              volume: [0, 0, 0],
            },
          ],
        },
      },
    ],
    error: null,
  },
}

/** The same capture for `%5EVIX3M`, whose prices are the 3-month leg's. */
const capturedVix3mPayload = {
  chart: {
    result: [
      {
        meta: {
          currency: 'USD',
          symbol: '^VIX3M',
          exchangeName: 'WCB',
          instrumentType: 'INDEX',
          regularMarketTime: CAPTURED_QUOTE_EPOCH_SECONDS,
          regularMarketPrice: 18.24,
          chartPreviousClose: 18.55,
          previousClose: 18.55,
          longName: 'CBOE 3-Month Volatility Index',
        },
        timestamp: [1789738200, 1789738500, 1789761600],
        indicators: {
          quote: [
            {
              open: [18.469999313354492, 18.440000534057617, 18.239999771118164],
              high: [18.5, 18.449999809265137, 18.239999771118164],
              low: [18.440000534057617, 18.43000030517578, 18.239999771118164],
              close: [18.440000534057617, 18.43000030517578, 18.239999771118164],
              volume: [0, 0, 0],
            },
          ],
        },
      },
    ],
    error: null,
  },
}

const jsonResponse = (payload: unknown) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(payload),
})

/**
 * A refusal from Yahoo.
 *
 * The policy reads `Retry-After` off a retryable status, so the header
 * container is part of the fixture. `retry-after: 0` is what keeps a test
 * ABOUT the fallback from waiting out the policy's real backoff; the backoff
 * itself is pinned by the retry test below.
 */
const errorResponse = (status: number, headers: Record<string, string> = {}) => ({
  ok: false,
  status,
  headers: new Headers(headers),
  json: () => Promise.resolve({}),
})

/** Yahoo is asked for the same URL once per attempt, so attempts are counted. */
const attemptsPerUrl = (): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const call of fetchMock.mock.calls) {
    const url = urlOf(call)
    counts.set(url, (counts.get(url) ?? 0) + 1)
  }
  return counts
}

/** The fetch body is only needed by the caller, so typing it loosely is enough. */
const urlOf = (call: unknown[] | undefined): string => String(call?.[0] ?? '')

const initOf = (call: unknown[] | undefined): RequestInit => (call?.[1] ?? {}) as RequestInit

/** Every URL the module asked for, in order. */
const requestedUrls = (): string[] => fetchMock.mock.calls.map((call) => urlOf(call))

const ibkrRow = (fields: Record<string, string | number>) => ({
  conid: VIX_CONID,
  _updated: CAPTURED_QUOTE_EPOCH_SECONDS * 1000,
  ...fields,
})

describe('fetchVolatilityContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The policy caches a resolved response by URL for 15s, and that cache is
    // process-wide: without this, a test would be answered by the previous
    // test's payload.
    yahooRequestPolicy.clear()
    vi.stubGlobal('fetch', fetchMock)
    // The default: IBKR cannot answer, so a Yahoo test is testing Yahoo. Tests
    // that want the IBKR quote override these.
    mockEnsureIbkrSession.mockResolvedValue(undefined)
    mockResolveIbkrConidFromApi.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5000'))
    mockFetchIbkrMarketJson.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5000'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('Yahoo', () => {
    it('reads last and open from a captured ^VIX payload', async () => {
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('VIX3M')
            ? errorResponse(429, { 'retry-after': '0' })
            : jsonResponse(capturedVixPayload)
        )
      )

      const { vix, vix3m } = await fetchVolatilityContext({
        now: new Date(CAPTURED_QUOTE_ISO),
      })

      expect(vix).toEqual({
        symbol: 'VIX',
        last: 14.81,
        open: 15.069999694824219,
        asOf: CAPTURED_QUOTE_ISO,
        source: 'yahoo',
      })
      // The 3-month leg was refused and did not take the 30-day quote with it.
      expect(vix3m).toBeNull()
      expect(urlOf(fetchMock.mock.calls[0])).toBe(VIX_URL)
      // The refusal is the policy's to retry, so one refused symbol costs it
      // three attempts before the symbol is given up on.
      expect(attemptsPerUrl().get(VIX3M_URL)).toBe(3)
      // The signal fetch is aborted by is the policy's own per-attempt timeout.
      expect(initOf(fetchMock.mock.calls[0]).signal).toBeInstanceOf(AbortSignal)
    })

    it('reads the 3-month leg from its own ticker', async () => {
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          jsonResponse(url.includes('VIX3M') ? capturedVix3mPayload : capturedVixPayload)
        )
      )

      const { vix, vix3m } = await fetchVolatilityContext()

      expect(requestedUrls()).toEqual([VIX_URL, VIX3M_URL])
      expect(vix?.last).toBe(14.81)
      expect(vix3m).toEqual({
        symbol: 'VIX3M',
        last: 18.24,
        open: 18.469999313354492,
        asOf: CAPTURED_QUOTE_ISO,
        source: 'yahoo',
      })
    })

    it('takes the first non-null bar for today open and the last non-null close for last', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          chart: {
            result: [
              {
                meta: { symbol: '^VIX', regularMarketTime: CAPTURED_QUOTE_EPOCH_SECONDS },
                timestamp: [1789715700, 1789716000, 1789716300],
                indicators: {
                  quote: [{ open: [null, null, 15.07], close: [null, 15.1, 14.81] }],
                },
              },
            ],
            error: null,
          },
        })
      )

      const { vix } = await fetchVolatilityContext()

      expect(vix).toEqual({
        symbol: 'VIX',
        last: 14.81,
        open: 15.07,
        asOf: CAPTURED_QUOTE_ISO,
        source: 'yahoo',
      })
    })

    it('reports no quote when the payload carries no price at all', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          chart: {
            result: [
              {
                meta: { symbol: '^VIX' },
                timestamp: [1789715700],
                indicators: { quote: [{ open: [null], close: [null] }] },
              },
            ],
            error: { code: 'Not Found', description: 'No data found' },
          },
        })
      )

      await expect(fetchVolatilityContext()).resolves.toEqual({ vix: null, vix3m: null })
    })

    it('reports no quote on a non-200 rather than throwing', async () => {
      // `retry-after: 0` keeps a test about the fallback out of the policy's
      // backoff; that a refusal which never clears costs three attempts per
      // symbol is part of what the case pins.
      fetchMock.mockResolvedValue(errorResponse(429, { 'retry-after': '0' }))

      await expect(fetchVolatilityContext()).resolves.toEqual({ vix: null, vix3m: null })
      expect(attemptsPerUrl().get(VIX_URL)).toBe(3)
      expect(attemptsPerUrl().get(VIX3M_URL)).toBe(3)
    })

    it('retries a rate limit and takes the answer that follows it', async () => {
      // The two attempts are separated by the policy's own backoff
      // (YAHOO_BACKOFF_MS, 500ms by default), which is fast-forwarded rather
      // than waited out: the fetch mock resolves without a timer of its own, so
      // the clock is the only thing moving.
      vi.useFakeTimers()
      try {
        const seen = new Map<string, number>()
        fetchMock.mockImplementation((url: string) => {
          const attempt = (seen.get(url) ?? 0) + 1
          seen.set(url, attempt)
          return Promise.resolve(
            url === VIX_URL && attempt === 1
              ? errorResponse(429)
              : jsonResponse(url.includes('VIX3M') ? capturedVix3mPayload : capturedVixPayload)
          )
        })

        const pending = fetchVolatilityContext({ now: new Date(CAPTURED_QUOTE_ISO) })
        await vi.advanceTimersByTimeAsync(500)
        const { vix, vix3m } = await pending

        // The answer after the refusal is the quote, so the retry is not merely
        // survived but used - and the symbol never refused was not retried.
        expect(vix).toEqual({
          symbol: 'VIX',
          last: 14.81,
          open: 15.069999694824219,
          asOf: CAPTURED_QUOTE_ISO,
          source: 'yahoo',
        })
        expect(vix3m?.last).toBe(18.24)
        expect(attemptsPerUrl().get(VIX_URL)).toBe(2)
        expect(attemptsPerUrl().get(VIX3M_URL)).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('answers a repeat call from the policy window rather than asking Yahoo again', async () => {
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          jsonResponse(url.includes('VIX3M') ? capturedVix3mPayload : capturedVixPayload)
        )
      )

      const first = await fetchVolatilityContext({ now: new Date(CAPTURED_QUOTE_ISO) })
      const second = await fetchVolatilityContext({ now: new Date(CAPTURED_QUOTE_ISO) })

      expect(second).toEqual(first)
      // One request per symbol for both calls: the second pair never left the
      // policy, which is the budget this module now shares with the rest of the
      // app rather than spending on its own.
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('abandons a request that never answers, on the policy timeout rather than its own', async () => {
      fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
        const signal = init?.signal
        return new Promise((_resolve, reject) => {
          if (!signal) return
          signal.addEventListener(
            'abort',
            () => reject((signal as AbortSignal).reason ?? new Error('aborted')),
            { once: true }
          )
        })
      })

      // The timeout is the policy's now (YAHOO_TIMEOUT_MS, 20s in production)
      // and the policy reads its options when it is constructed, so a fresh
      // module graph built against a 5ms budget exercises the real
      // AbortSignal.timeout without waiting out the production default. A zero
      // backoff keeps the retry immediate for the same reason.
      vi.stubEnv('YAHOO_TIMEOUT_MS', '5')
      vi.stubEnv('YAHOO_BACKOFF_MS', '0')
      vi.stubEnv('YAHOO_MAX_ATTEMPTS', '2')
      vi.resetModules()

      try {
        const { fetchVolatilityContext: underShortPolicy } = await import('@/lib/market/volatility')

        await expect(underShortPolicy()).resolves.toEqual({ vix: null, vix3m: null })
        // The policy retries its own timeout and then gives up, so a stalled
        // Yahoo costs attempts rather than a cycle that never completes.
        expect(attemptsPerUrl().get(VIX_URL)).toBe(2)
      } finally {
        vi.unstubAllEnvs()
        vi.resetModules()
      }
    })
  })

  describe('IBKR', () => {
    beforeEach(() => {
      mockResolveIbkrConidFromApi.mockResolvedValue({ conid: VIX_CONID, conidSpec: 'IND' })
    })

    it('prefers the IBKR snapshot when it has a live print', async () => {
      mockFetchIbkrMarketJson.mockImplementation(({ url }: { url: string }) =>
        Promise.resolve(
          url.includes(String(VIX_CONID))
            ? [ibkrRow({ '31': '14.81', '7295': '15.07' })]
            : [ibkrRow({ '31': '18.24', '7295': '18.47' })]
        )
      )
      mockResolveIbkrConidFromApi.mockImplementation(({ symbol }: { symbol: string }) =>
        Promise.resolve({ conid: symbol === 'VIX' ? VIX_CONID : VIX3M_CONID, conidSpec: 'IND' })
      )

      const { vix, vix3m } = await fetchVolatilityContext()

      expect(vix).toEqual({
        symbol: 'VIX',
        last: 14.81,
        open: 15.07,
        asOf: CAPTURED_QUOTE_ISO,
        source: 'ibkr',
      })
      expect(vix3m?.source).toBe('ibkr')
      // The indices are not catalogue listings, so no venue is invented for them.
      expect(mockResolveIbkrConidFromApi).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: 'VIX', assetClass: 'indice' })
      )
      const snapshotCall = mockFetchIbkrMarketJson.mock.calls[0][0] as {
        url: string
        init: RequestInit
      }
      expect(snapshotCall.url).toContain(`conids=${VIX_CONID}`)
      expect(snapshotCall.url).toContain('fields=31%2C7295')
      expect(snapshotCall.init.signal).toBeInstanceOf(AbortSignal)
      // IBKR answered, so Yahoo was never asked.
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('falls through to Yahoo when IBKR throws', async () => {
      mockFetchIbkrMarketJson.mockRejectedValue(new Error('IBKR gateway refused the request'))
      fetchMock.mockResolvedValue(jsonResponse(capturedVixPayload))

      const { vix, vix3m } = await fetchVolatilityContext()

      expect(vix).toEqual({
        symbol: 'VIX',
        last: 14.81,
        open: 15.069999694824219,
        asOf: CAPTURED_QUOTE_ISO,
        source: 'yahoo',
      })
      expect(vix3m?.source).toBe('yahoo')
    })

    it('falls through to Yahoo when IBKR only has the previous day close', async () => {
      // `C` marks a value that is the previous day's close, not a live print.
      mockFetchIbkrMarketJson.mockResolvedValue([ibkrRow({ '31': 'C15.44', '7295': '15.07' })])
      fetchMock.mockResolvedValue(jsonResponse(capturedVixPayload))

      const { vix } = await fetchVolatilityContext()

      expect(vix?.source).toBe('yahoo')
      expect(vix?.last).toBe(14.81)
    })

    it('abandons an IBKR attempt that answers nothing and still returns the Yahoo quote', async () => {
      mockResolveIbkrConidFromApi.mockReturnValue(new Promise(() => {}))
      fetchMock.mockResolvedValue(jsonResponse(capturedVixPayload))

      // The budget scales with the per-request one, so a small value here keeps
      // the test quick while still exercising the real ceiling.
      const { vix } = await fetchVolatilityContext({ quoteTimeoutMs: 20 })

      expect(vix?.source).toBe('yahoo')
      expect(vix?.last).toBe(14.81)
    })
  })

  describe('failure isolation', () => {
    it('keeps one symbol when the other has no quote from either source', async () => {
      mockFetchIbkrMarketJson.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5000'))
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('VIX3M')
            ? errorResponse(429, { 'retry-after': '0' })
            : jsonResponse(capturedVixPayload)
        )
      )

      const { vix, vix3m } = await fetchVolatilityContext()

      expect(vix?.last).toBe(14.81)
      expect(vix3m).toBeNull()
    })

    it('reports null for a symbol with no quote at all and does not throw', async () => {
      mockFetchIbkrMarketJson.mockRejectedValue(new Error('no gateway'))
      fetchMock.mockRejectedValue(new Error('network down'))

      await expect(fetchVolatilityContext()).resolves.toEqual({ vix: null, vix3m: null })
    })
  })
})

describe('isStale', () => {
  const at = (iso: string, source: VolatilityQuote['source'] = 'yahoo'): VolatilityQuote => ({
    symbol: 'VIX',
    last: 14.81,
    open: 15.07,
    asOf: iso,
    source,
  })

  const now = new Date(CAPTURED_QUOTE_ISO)

  it('is not stale either side of the default allowance', () => {
    const nineMinutesAgo = at(new Date(now.getTime() - 9 * 60_000).toISOString())
    expect(isStale(nineMinutesAgo, now)).toBe(false)

    const elevenMinutesAgo = at(new Date(now.getTime() - 11 * 60_000).toISOString())
    expect(isStale(elevenMinutesAgo, now)).toBe(true)
  })

  it('treats an age exactly at the allowance as still fresh', () => {
    const onTheBoundary = at(new Date(now.getTime() - 600_000).toISOString())
    expect(isStale(onTheBoundary, now, 600_000)).toBe(false)
    expect(isStale(onTheBoundary, new Date(now.getTime() + 1), 600_000)).toBe(true)
  })

  it('honours a caller-supplied allowance', () => {
    const twentySecondsOld = at(new Date(now.getTime() - 20_000).toISOString())
    expect(isStale(twentySecondsOld, now, 60_000)).toBe(false)
    expect(isStale(twentySecondsOld, now, 10_000)).toBe(true)
  })

  it('is stale for a quote stamped today but before the session', () => {
    // 06:00Z is before the index session's own 07:00Z start (the captured
    // payload's currentTradingPeriod.regular.start); 14:00Z is mid-session.
    const beforeTheSession = at('2026-09-18T06:00:00.000Z')
    expect(isStale(beforeTheSession, new Date('2026-09-18T14:00:00.000Z'))).toBe(true)
  })

  it('is stale for a missing or unreadable timestamp', () => {
    expect(isStale(null, now)).toBe(true)
    expect(isStale(at('not-a-date'), now)).toBe(true)
  })
})
