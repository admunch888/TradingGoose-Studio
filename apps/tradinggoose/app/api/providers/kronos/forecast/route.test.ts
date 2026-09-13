/**
 * The Kronos route contract the boundary has to satisfy.
 *
 * The workflow "Historical Data -> Kronos Forecast" failed with:
 *
 *   [Tools] Internal API error for kronos_forecast: {"status":400,"errorData":{"error":"Invalid request data","details":[{"expected":"number","code":"invalid_type","path":["horizonBars"],"message":"Invalid input: expected number, received string"}]}}
 *
 * `horizonBars` arrives as a string whenever the block transform did not type it, so the
 * tool dispatch boundary coerces it (tools/utils.ts) before the body is built. These tests
 * pin both halves: a number passes, and a value that cannot be coerced still fails with the
 * route's own error shape rather than being silently defaulted.
 */
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'

const kronosMocks = vi.hoisted(() => ({
  isKronosEnabled: vi.fn(),
  callKronosForecast: vi.fn(),
  checkSessionOrInternalAuth: vi.fn(),
}))

vi.mock('@/lib/auth/hybrid', () => ({
  checkSessionOrInternalAuth: kronosMocks.checkSessionOrInternalAuth,
}))

vi.mock('@/lib/kronos', () => ({
  isKronosEnabled: kronosMocks.isKronosEnabled,
  callKronosForecast: kronosMocks.callKronosForecast,
  KronosError: class KronosError extends Error {
    code = 'UNKNOWN'
  },
  KronosErrorCode: {
    DISABLED: 'disabled',
    UNAVAILABLE: 'unavailable',
    TIMEOUT: 'timeout',
    HORIZON_EXCEEDED: 'horizon_exceeded',
    TOO_FEW_BARS: 'too_few_bars',
    TOO_MANY_BARS: 'too_many_bars',
  },
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}))

const LISTING = {
  listing_type: 'default',
  listing_id: 'AAPL',
  base_id: '',
  quote_id: '',
}

const bars = Array.from({ length: 40 }, (_, index) => ({
  timestamp: new Date(Date.UTC(2024, 0, 1, 0, index * 5)).toISOString(),
  open: 100 + index,
  high: 101 + index,
  low: 99 + index,
  close: 100 + index,
}))

const body = (horizonBars: unknown) => ({
  listing: LISTING,
  marketSeries: {
    listing: LISTING,
    bars,
  },
  interval: '5m',
  timezone: 'America/New_York',
  normalizationMode: 'raw',
  parameters: { temperature: 1, topP: 0.9, sampleCount: 1 },
  horizonBars,
})

const request = (payload: unknown) =>
  new NextRequest('http://localhost/api/providers/kronos/forecast', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => {
  vi.clearAllMocks()
  kronosMocks.isKronosEnabled.mockReturnValue(true)
  kronosMocks.checkSessionOrInternalAuth.mockResolvedValue({
    success: true,
    userId: 'user-1',
    workspaceId: 'workspace-1',
  })
  kronosMocks.callKronosForecast.mockResolvedValue({ forecast: [], model: {}, timingMs: {} })
})

describe('POST /api/providers/kronos/forecast horizonBars contract', () => {
  it('accepts the number the dispatch boundary produces for a stored "12"', async () => {
    const response = await POST(request(body(12)) as any)
    const payload = await response.json()

    expect(response.status, JSON.stringify(payload)).toBe(200)
    expect(kronosMocks.callKronosForecast).toHaveBeenCalledWith(
      expect.objectContaining({ futureTimestamps: expect.any(Array) }),
      expect.anything()
    )
  })

  it('still rejects an uncoercible horizonBars with the route error shape from the live failure', async () => {
    const response = await POST(request(body('abc')) as any)
    const payload = await response.json()

    expect(response.status).toBe(400)
    expect(payload.error).toBe('Invalid request data')
    expect(payload.details).toEqual([
      expect.objectContaining({
        code: 'invalid_type',
        path: ['horizonBars'],
        message: expect.stringMatching(/expected number, received string/i),
      }),
    ])
    expect(kronosMocks.callKronosForecast).not.toHaveBeenCalled()
  })

  it('still rejects the raw stored string (the pre-fix wire shape) unchanged', async () => {
    const response = await POST(request(body('12')) as any)
    const payload = await response.json()

    expect(response.status).toBe(400)
    expect(payload.error).toBe('Invalid request data')
    expect(payload.details[0]).toMatchObject({
      code: 'invalid_type',
      path: ['horizonBars'],
    })
  })
})
