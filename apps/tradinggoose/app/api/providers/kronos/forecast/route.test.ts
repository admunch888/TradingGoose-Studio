/**
 * @vitest-environment node
 */

import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callKronosForecast } from '@/lib/kronos/client'
import {
  type ForecastRequest,
  ForecastRequestSchema,
  type ForecastResponse,
  ForecastResponseSchema,
  KronosErrorCode,
} from '@/lib/kronos/types'

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

// `sampleCount` above 1 is the ensemble: the service returns the median path and puts a
// 10th/90th percentile band on every point. At one sample the key is absent, not null,
// which is why the default fixture below carries none.
const BAND = { low: 139.5, high: 141.5 }

const buildForecastResponse = ({
  sampleCount = 1,
}: {
  sampleCount?: number
} = {}): ForecastResponse => ({
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
      ...(sampleCount > 1 ? { band: BAND } : {}),
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
  parameters: { temperature: 1, topP: 0.9, sampleCount },
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

/** A request the client accepts, so the only thing left to refuse is the sample count. */
const kronosRequest = (sampleCount: number): ForecastRequest => ({
  requestId: 'kronos-forecast-test-1',
  listing: { listingId: 'AAPL', listingType: 'default' },
  interval: '5m',
  timezone: 'America/New_York',
  normalizationMode: 'raw',
  history: Array.from({ length: 32 }, (_, index) => ({
    timestamp: new Date(BASE_TS + index * INTERVAL_MS).toISOString(),
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
  })),
  futureTimestamps: [new Date(BASE_TS + 32 * INTERVAL_MS).toISOString()],
  parameters: { temperature: 1, topP: 0.9, sampleCount },
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

  it('carries a sampleCount from the tool body through to the service request', async () => {
    const body = kronosForecastTool.request.body?.({
      listing,
      marketSeries: buildMarketSeries(40),
      interval: '5m',
      timezone: 'America/New_York',
      normalizationMode: 'raw',
      horizonBars: 12,
      parameters: { temperature: 1, topP: 0.9, sampleCount: 4 },
    })

    const response = await POST(buildRequest(JSON.parse(JSON.stringify(body))))

    expect(response.status).toBe(200)
    const [request] = mocks.callKronosForecast.mock.calls[0] as [
      { parameters: { sampleCount: number } },
      unknown,
    ]
    expect(request.parameters.sampleCount).toBe(4)
  })

  describe('the sample ceiling', () => {
    it('takes a sampleCount up to KRONOS_MAX_SAMPLES and forwards it', async () => {
      vi.stubEnv('KRONOS_MAX_SAMPLES', '4')

      const response = await POST(
        buildRequest(buildBlockPayload({ parameters: { sampleCount: 4 } }))
      )

      expect(response.status).toBe(200)
      const [request] = mocks.callKronosForecast.mock.calls[0] as [
        { parameters: { sampleCount: number } },
        unknown,
      ]
      expect(request.parameters.sampleCount).toBe(4)
    })

    it('refuses one above it with 422, naming the cap, without calling the service', async () => {
      // The service answers 422 for the same request; refusing it here gives the same
      // answer without the round trip.
      vi.stubEnv('KRONOS_MAX_SAMPLES', '4')

      const response = await POST(
        buildRequest(buildBlockPayload({ parameters: { sampleCount: 5 } }))
      )

      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({
        error: 'sampleCount must be at most 4 (KRONOS_MAX_SAMPLES), got 5',
      })
      expect(mocks.callKronosForecast).not.toHaveBeenCalled()
    })

    it('defaults to 16 when KRONOS_MAX_SAMPLES is not set', async () => {
      const at = await POST(buildRequest(buildBlockPayload({ parameters: { sampleCount: 16 } })))
      const above = await POST(buildRequest(buildBlockPayload({ parameters: { sampleCount: 17 } })))

      expect(at.status).toBe(200)
      expect(above.status).toBe(422)
    })

    it('refuses it in the client too, the layer the horizon cap is enforced at', async () => {
      // The route answers before the client sees the request, so this is the only path
      // that reaches the client's own check - the same one KRONOS_MAX_HORIZON uses.
      vi.stubEnv('KRONOS_MAX_SAMPLES', '4')

      await expect(callKronosForecast(kronosRequest(5))).rejects.toMatchObject({
        code: KronosErrorCode.SAMPLE_LIMIT_EXCEEDED,
      })
    })
  })

  describe('the response wire', () => {
    it('keeps the band optional, so a service that returns none still validates', async () => {
      // One sample: the key is absent, not null (response_model_exclude_none).
      mocks.callKronosForecast.mockResolvedValue(buildForecastResponse())
      const withoutBand = await POST(buildRequest(buildBlockPayload()))

      mocks.callKronosForecast.mockResolvedValue(buildForecastResponse({ sampleCount: 4 }))
      const withBand = await POST(
        buildRequest(buildBlockPayload({ parameters: { sampleCount: 4 } }))
      )

      const noBand = ForecastResponseSchema.safeParse(await withoutBand.json())
      const banded = ForecastResponseSchema.safeParse(await withBand.json())

      expect(noBand.success).toBe(true)
      expect(banded.success).toBe(true)
      expect(banded.data?.forecast[0].band).toEqual(BAND)
      expect(banded.data?.parameters.sampleCount).toBe(4)
    })

    it('strips an unknown key rather than refusing the response', () => {
      // Not `.strict()`: a newer service's extra field must not break an older app.
      const parsed = ForecastResponseSchema.safeParse({
        ...buildForecastResponse({ sampleCount: 4 }),
        ensemble: { method: 'median' },
      })

      expect(parsed.success).toBe(true)
      expect(parsed.data).not.toHaveProperty('ensemble')
    })
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

    it('rejects an unknown timezone with 400 (not 502)', async () => {
      const response = await POST(
        buildRequest(buildBlockPayload({ timezone: 'Mars/Olympus_Mons' }))
      )

      expect(response.status).toBe(400)
      expect(mocks.callKronosForecast).not.toHaveBeenCalled()
    })
  })
})
