/**
 * @vitest-environment node
 */

import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForecastRequestSchema, type ForecastResponse } from '@/lib/kronos/types'

const mocks = vi.hoisted(() => ({
  checkAuth: vi.fn(),
  callKronosForecast: vi.fn(),
}))

vi.mock('@/lib/auth/hybrid', () => ({
  AuthType: { SESSION: 'session', API_KEY: 'api_key', INTERNAL_JWT: 'internal_jwt' },
  checkSessionOrInternalAuth: (...args: unknown[]) => mocks.checkAuth(...args),
}))

vi.mock('@/lib/kronos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kronos')>()
  return {
    ...actual,
    callKronosForecast: (...args: unknown[]) => mocks.callKronosForecast(...args),
  }
})

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}))

vi.mock('@/lib/utils', () => ({
  generateRequestId: vi.fn(() => 'kronos-forecast-test-1'),
}))

import { KRONOS_MISSING_LISTING_MESSAGE, POST } from '@/app/api/providers/kronos/forecast/route'
import { kronosForecastTool } from '@/tools/kronos/forecast'

// The listing payload the Historical Data block emits and Kronos blocks pass through.
const listing = {
  listing_id: 'AAPL',
  base_id: '',
  quote_id: '',
  listing_type: 'default',
}

const BASE_TS = Date.parse('2026-01-05T14:30:00.000Z')
const INTERVAL_MS = 5 * 60 * 1000

const buildMarketSeries = (barCount: number) => ({
  listing,
  timezone: 'America/New_York',
  normalizationMode: 'raw',
  bars: Array.from({ length: barCount }, (_, index) => ({
    timeStamp: new Date(BASE_TS + index * INTERVAL_MS).toISOString(),
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 1000 + index,
    turnover: 50_000 + index,
  })),
})

// Exactly the body tools/kronos/forecast.ts + blocks/blocks/kronos_forecast.ts send.
const buildBlockPayload = (overrides: Record<string, unknown> = {}) => ({
  listing,
  marketSeries: buildMarketSeries(40),
  interval: '5m',
  timezone: 'America/New_York',
  normalizationMode: 'raw',
  horizonBars: 12,
  parameters: { temperature: 1, topP: 0.9 },
  ...overrides,
})

const buildForecastResponse = (): ForecastResponse => ({
  requestId: 'kronos-forecast-test-1',
  forecast: [
    {
      timestamp: '2026-01-05T17:50:00.000Z',
      open: 140,
      high: 141,
      low: 139,
      close: 140.5,
      volume: 1040,
      amount: 50_040,
    },
  ],
  model: {
    name: 'kronos-small',
    sourceRevision: 'source-rev',
    modelRevision: 'model-rev',
    tokenizerRevision: 'tokenizer-rev',
    device: 'cpu',
    maxContext: 512,
  },
  input: {
    listing: { listingId: 'AAPL', listingType: 'default' },
    interval: '5m',
    timezone: 'America/New_York',
    normalizationMode: 'raw',
    barCount: 40,
    lastCompletedBarTimestamp: '2026-01-05T17:45:00.000Z',
  },
  parameters: { temperature: 1, topP: 0.9, sampleCount: 1 },
  diagnostics: {
    volumeImputed: false,
    amountImputed: false,
    candleReconciliationCount: 0,
    warnings: [],
  },
  timingMs: { queue: 1, inference: 2, total: 3 },
})

const buildRequest = (body: unknown, query = '?workspaceId=workspace-1') =>
  new NextRequest(`http://localhost/api/providers/kronos/forecast${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('kronos forecast route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('KRONOS_ENABLED', 'true')
    vi.stubEnv('KRONOS_INTERNAL_URL', 'http://kronos:8000')
    vi.stubEnv('KRONOS_INTERNAL_TOKEN', 'this-is-a-test-token-thats-long-enough-32')
    mocks.checkAuth.mockResolvedValue({ success: true, userId: 'user-1' })
    mocks.callKronosForecast.mockResolvedValue(buildForecastResponse())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('accepts the payload the kronos_forecast block sends', async () => {
    const response = await POST(buildRequest(buildBlockPayload()))

    expect(response.status).toBe(200)
    expect(mocks.callKronosForecast).toHaveBeenCalledTimes(1)
  })

  describe('the listing defaults to the one the market series carries', () => {
    const forwardedListing = () =>
      (mocks.callKronosForecast.mock.calls[0] as [{ listing: unknown }, unknown])[0].listing

    it('uses the series listing when Listing is empty, null or omitted', async () => {
      for (const listingValue of [undefined, null, '', '   ']) {
        mocks.callKronosForecast.mockClear()

        const response = await POST(buildRequest(buildBlockPayload({ listing: listingValue })))

        expect(response.status).toBe(200)
        expect(forwardedListing()).toEqual({ listingId: 'AAPL', listingType: 'default' })
      }
    })

    it('forecasts an IBKR listing supplied by identity from the series', async () => {
      const ibkrListing = {
        listing_id: 'MESZ26',
        base_id: '',
        quote_id: '',
        listing_type: 'default',
        manual: { assetClass: 'future', marketCode: 'CME' },
      }

      const response = await POST(
        buildRequest(
          buildBlockPayload({
            listing: undefined,
            marketSeries: { ...buildMarketSeries(40), listing: ibkrListing },
          })
        )
      )

      expect(response.status).toBe(200)
      expect(forwardedListing()).toEqual({ listingId: 'MESZ26', listingType: 'default' })
    })

    it('keeps an explicit listing over the one in the series', async () => {
      const response = await POST(
        buildRequest(buildBlockPayload({ listing: { ...listing, listing_id: 'MSFT' } }))
      )

      expect(response.status).toBe(200)
      expect(forwardedListing()).toEqual({ listingId: 'MSFT', listingType: 'default' })
    })

    it('rejects a forecast with no listing anywhere with 400', async () => {
      const { listing: _listing, ...seriesWithoutListing } = buildMarketSeries(40)

      const response = await POST(
        buildRequest(buildBlockPayload({ listing: '', marketSeries: seriesWithoutListing }))
      )

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: KRONOS_MISSING_LISTING_MESSAGE })
      expect(mocks.callKronosForecast).not.toHaveBeenCalled()
    })

    it('declares listing optional on the tool', () => {
      expect(kronosForecastTool.params.listing.required).toBe(false)
    })
  })

  it('accepts the exact body produced by the kronos_forecast tool', async () => {
    const body = kronosForecastTool.request.body?.({
      listing,
      marketSeries: buildMarketSeries(40),
      interval: '5m',
      timezone: 'America/New_York',
      normalizationMode: 'raw',
      horizonBars: 12,
      parameters: { temperature: undefined, topP: undefined },
    })

    // Mirror what tools/index.ts does with the tool body before sending it.
    const response = await POST(buildRequest(JSON.parse(JSON.stringify(body))))

    expect(response.status).toBe(200)
    expect(mocks.callKronosForecast).toHaveBeenCalledTimes(1)
    const [request] = mocks.callKronosForecast.mock.calls[0] as [
      { parameters: { temperature: number; topP: number; sampleCount: number } },
      unknown,
    ]
    expect(request.parameters).toEqual({ temperature: 1, topP: 0.9, sampleCount: 1 })
  })

  it('assembles a ForecastRequest that satisfies the request schema', async () => {
    const response = await POST(buildRequest(buildBlockPayload()))
    expect(response.status).toBe(200)

    const [request] = mocks.callKronosForecast.mock.calls[0] as [unknown, unknown]

    const parsed = ForecastRequestSchema.safeParse(request)
    if (!parsed.success) {
      throw new Error(
        `assembled forecast request failed validation: ${JSON.stringify(parsed.error.issues)}`
      )
    }
    expect(parsed.success).toBe(true)
    expect(parsed.data.requestId).toBe('kronos-forecast-test-1')
    expect(parsed.data.listing).toEqual({ listingId: 'AAPL', listingType: 'default' })
    expect(parsed.data.interval).toBe('5m')
    expect(parsed.data.timezone).toBe('America/New_York')
    expect(parsed.data.normalizationMode).toBe('raw')
    expect(parsed.data.history).toHaveLength(40)
    expect(parsed.data.futureTimestamps).toHaveLength(12)
    expect(parsed.data.history[0]).toMatchObject({ open: 100, close: 100.5, volume: 1000 })
    expect(parsed.data.history[39]).toMatchObject({ amount: 50_039 })
  })

  it('derives future timestamps by advancing the last history bar by the interval', async () => {
    const response = await POST(buildRequest(buildBlockPayload()))
    expect(response.status).toBe(200)

    const [request] = mocks.callKronosForecast.mock.calls[0] as [
      { history: Array<{ timestamp: string }>; futureTimestamps: string[] },
      unknown,
    ]

    const lastHistory = request.history[request.history.length - 1].timestamp
    expect(lastHistory).toBe('2026-01-05T17:45:00.000Z')
    expect(request.futureTimestamps[0]).toBe('2026-01-05T17:50:00.000Z')
    expect(request.futureTimestamps[11]).toBe('2026-01-05T18:45:00.000Z')
    for (let index = 1; index < request.futureTimestamps.length; index++) {
      const previous = Date.parse(request.futureTimestamps[index - 1])
      const current = Date.parse(request.futureTimestamps[index])
      expect(current - previous).toBe(INTERVAL_MS)
    }
  })

  it('passes the workspace query param through to the client context', async () => {
    await POST(buildRequest(buildBlockPayload(), '?workspaceId=workspace-9&workflowId=wf-1'))

    const [, context] = mocks.callKronosForecast.mock.calls[0] as [
      unknown,
      { workspaceId?: string; workflowId?: string; userId?: string },
    ]
    expect(context.workspaceId).toBe('workspace-9')
    expect(context.workflowId).toBe('wf-1')
    expect(context.userId).toBe('user-1')
  })

  it('advances month intervals using UTC calendar months', async () => {
    const response = await POST(
      buildRequest(buildBlockPayload({ interval: '1mo', horizonBars: 3 }))
    )
    expect(response.status).toBe(200)

    const [request] = mocks.callKronosForecast.mock.calls[0] as [{ futureTimestamps: string[] }]
    expect(request.futureTimestamps).toEqual([
      '2026-02-05T17:45:00.000Z',
      '2026-03-05T17:45:00.000Z',
      '2026-04-05T17:45:00.000Z',
    ])
  })

  it('omits volume and amount for every bar when the series has none', async () => {
    const marketSeries = buildMarketSeries(40)
    const barsWithoutVolume = marketSeries.bars.map(({ volume, turnover, ...bar }) => bar)

    const response = await POST(
      buildRequest(
        buildBlockPayload({ marketSeries: { ...marketSeries, bars: barsWithoutVolume } })
      )
    )
    expect(response.status).toBe(200)

    const [request] = mocks.callKronosForecast.mock.calls[0] as [
      { history: Array<{ volume?: number; amount?: number }> },
    ]
    expect(request.history.every((bar) => bar.volume === undefined)).toBe(true)
    expect(request.history.every((bar) => bar.amount === undefined)).toBe(true)
    expect(ForecastRequestSchema.safeParse(request).success).toBe(true)
  })

  it('rejects a payload without market series history with 400 (not 502)', async () => {
    const response = await POST(buildRequest(buildBlockPayload({ marketSeries: { bars: [] } })))

    expect(response.status).toBe(400)
    expect(mocks.callKronosForecast).not.toHaveBeenCalled()
  })

  it('rejects an unsupported interval with 400 (not 502)', async () => {
    const response = await POST(buildRequest(buildBlockPayload({ interval: '7s' })))

    expect(response.status).toBe(400)
    expect(mocks.callKronosForecast).not.toHaveBeenCalled()
  })

  it('rejects a horizon above the schema maximum with 400 (not 502)', async () => {
    const response = await POST(buildRequest(buildBlockPayload({ horizonBars: 40 })))

    expect(response.status).toBe(400)
    expect(mocks.callKronosForecast).not.toHaveBeenCalled()
  })

  /**
   * The wire shape that produced the live failure on a podman deployment: the stored
   * `short-input` value reaches the route as a string, and the tool dispatch boundary
   * (tools/index.ts -> coerceParametersToDeclaredTypes) is what turns it into a number.
   * When it cannot be coerced the route must keep reporting the same error.
   */
  it('rejects a stored horizonBars string with the schema error shape from the live failure', async () => {
    const response = await POST(buildRequest(buildBlockPayload({ horizonBars: '12' })))
    const payload = (await response.json()) as { error: string; details: unknown[] }

    expect(response.status).toBe(400)
    expect(payload.error).toBe('Invalid request data')
    expect(payload.details).toEqual([
      expect.objectContaining({
        code: 'invalid_type',
        path: ['horizonBars'],
        message: expect.stringMatching(/expected number, received string/i),
      }),
    ])
    expect(mocks.callKronosForecast).not.toHaveBeenCalled()
  })

  describe('future timestamps follow the trading calendar in the history', () => {
    const DAY_MS = 86_400_000

    const buildSeriesAt = (timestamps: number[]) => ({
      listing,
      timezone: 'America/New_York',
      normalizationMode: 'raw',
      bars: timestamps.map((timestamp, index) => ({
        timeStamp: new Date(timestamp).toISOString(),
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100.5 + index,
        volume: 1000 + index,
      })),
    })

    const forecastTimestamps = () =>
      (mocks.callKronosForecast.mock.calls[0] as [{ futureTimestamps: string[] }])[0]
        .futureTimestamps

    it('skips the weekend for daily bars and keeps local midnight across DST', async () => {
      // Weekday daily bars at 00:00 New York (05:00Z in EST), ending Friday 2026-03-06.
      const timestamps: number[] = []
      for (let cursor = Date.parse('2026-03-06T05:00:00.000Z'); timestamps.length < 40; ) {
        const weekday = new Date(cursor).getUTCDay()
        if (weekday !== 0 && weekday !== 6) timestamps.unshift(cursor)
        cursor -= DAY_MS
      }

      const response = await POST(
        buildRequest(
          buildBlockPayload({
            marketSeries: buildSeriesAt(timestamps),
            interval: '1d',
            horizonBars: 3,
          })
        )
      )

      expect(response.status).toBe(200)
      // Monday next; New York moves to EDT on 2026-03-08, so midnight is 04:00Z.
      expect(forecastTimestamps()).toEqual([
        '2026-03-09T04:00:00.000Z',
        '2026-03-10T04:00:00.000Z',
        '2026-03-11T04:00:00.000Z',
      ])
    })

    it('rolls intraday bars from the session close to the next trading day open', async () => {
      // Two full regular sessions of 5m bars, 09:30-15:55 New York, Thursday and Friday.
      const timestamps: number[] = []
      for (const day of ['2026-01-08', '2026-01-09']) {
        const open = Date.parse(`${day}T14:30:00.000Z`)
        for (let bar = 0; bar < 78; bar++) timestamps.push(open + bar * INTERVAL_MS)
      }

      const response = await POST(
        buildRequest(
          buildBlockPayload({
            marketSeries: buildSeriesAt(timestamps),
            interval: '5m',
            horizonBars: 2,
          })
        )
      )

      expect(response.status).toBe(200)
      expect(forecastTimestamps()).toEqual(['2026-01-12T14:30:00.000Z', '2026-01-12T14:35:00.000Z'])
    })

    it('keeps weekends for a listing whose history trades them', async () => {
      // Consecutive daily bars (crypto), ending Friday 2026-01-09.
      const end = Date.parse('2026-01-09T00:00:00.000Z')
      const timestamps = Array.from({ length: 40 }, (_, index) => end - (39 - index) * DAY_MS)

      const response = await POST(
        buildRequest(
          buildBlockPayload({
            marketSeries: buildSeriesAt(timestamps),
            interval: '1d',
            timezone: 'UTC',
            horizonBars: 2,
          })
        )
      )

      expect(response.status).toBe(200)
      expect(forecastTimestamps()).toEqual(['2026-01-10T00:00:00.000Z', '2026-01-11T00:00:00.000Z'])
    })

    describe('a CME future takes its calendar from the series sessions', () => {
      const MINUTE_MS = 60_000

      // Sun 18:00 ET -> Mon 17:00 ET and so on, as the market-hours API returns them.
      const globexSessions = [
        { start: '2026-01-04T23:00:00.000Z', end: '2026-01-05T22:00:00.000Z' },
        { start: '2026-01-05T23:00:00.000Z', end: '2026-01-06T22:00:00.000Z' },
        { start: '2026-01-06T23:00:00.000Z', end: '2026-01-07T22:00:00.000Z' },
        { start: '2026-01-07T23:00:00.000Z', end: '2026-01-08T22:00:00.000Z' },
        { start: '2026-01-08T23:00:00.000Z', end: '2026-01-09T22:00:00.000Z' },
      ]

      /** 15-minute bars across every session, which is the MES history shape. */
      const globexBars = () => {
        const bars: number[] = []
        for (const session of globexSessions) {
          const end = Date.parse(session.end)
          for (let ms = Date.parse(session.start); ms < end; ms += 15 * MINUTE_MS) bars.push(ms)
        }
        return bars
      }

      const seriesUpTo = (lastBarIso: string) => {
        const last = Date.parse(lastBarIso)
        const bars = globexBars().filter((ms) => ms <= last)
        return { ...buildSeriesAt(bars.slice(-480)), marketSessions: globexSessions }
      }

      const forecastFrom = async (lastBarIso: string, horizonBars: number) => {
        const response = await POST(
          buildRequest(
            buildBlockPayload({
              marketSeries: seriesUpTo(lastBarIso),
              interval: '15m',
              horizonBars,
            })
          )
        )
        expect(response.status).toBe(200)
        return forecastTimestamps()
      }

      it('steps over the 17:00-18:00 ET break instead of forecasting inside it', async () => {
        // Last bar Tue 16:45 ET. Inferring the calendar from the bars gives a
        // session of 00:00-23:45, so the next three bars landed at 17:00, 17:15
        // and 17:30 - an hour the exchange is shut.
        expect(await forecastFrom('2026-01-06T21:45:00.000Z', 3)).toEqual([
          '2026-01-06T23:00:00.000Z', // Tue 18:00 ET
          '2026-01-06T23:15:00.000Z',
          '2026-01-06T23:30:00.000Z',
        ])
      })

      it('jumps the weekend from Friday 16:45 to Sunday 18:00', async () => {
        // The Sunday-evening bars in the history used to read as "trades
        // weekends", so these three landed on Saturday morning.
        expect(await forecastFrom('2026-01-09T21:45:00.000Z', 3)).toEqual([
          '2026-01-11T23:00:00.000Z', // Sun 18:00 ET
          '2026-01-11T23:15:00.000Z',
          '2026-01-11T23:30:00.000Z',
        ])
      })

      it('runs straight through midnight inside a session', async () => {
        expect(await forecastFrom('2026-01-06T04:45:00.000Z', 2)).toEqual([
          '2026-01-06T05:00:00.000Z', // Tue 00:00 ET
          '2026-01-06T05:15:00.000Z',
        ])
      })
    })

    it('keeps inferring the calendar when the series carries no sessions', async () => {
      // Every provider that does not resolve market hours still works exactly as
      // before: two regular sessions of 5m bars, rolling to the next weekday open.
      const timestamps: number[] = []
      for (const day of ['2026-01-08', '2026-01-09']) {
        const open = Date.parse(`${day}T14:30:00.000Z`)
        for (let bar = 0; bar < 78; bar++) timestamps.push(open + bar * INTERVAL_MS)
      }

      const response = await POST(
        buildRequest(
          buildBlockPayload({
            marketSeries: { ...buildSeriesAt(timestamps), marketSessions: [] },
            interval: '5m',
            horizonBars: 1,
          })
        )
      )

      expect(response.status).toBe(200)
      expect(forecastTimestamps()).toEqual(['2026-01-12T14:30:00.000Z'])
    })

    it('rejects an unknown timezone with 400 (not 502)', async () => {
      const response = await POST(
        buildRequest(buildBlockPayload({ timezone: 'Mars/Olympus_Mons' }))
      )

      expect(response.status).toBe(400)
      expect(mocks.callKronosForecast).not.toHaveBeenCalled()
    })
  })
})
