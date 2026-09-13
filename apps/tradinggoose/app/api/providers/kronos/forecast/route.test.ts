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

import { POST } from '@/app/api/providers/kronos/forecast/route'
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
})
