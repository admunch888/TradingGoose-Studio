/**
 * @vitest-environment node
 *
 * The Kronos Signal route: auth, body validation, the VIX context it fetches for itself,
 * and the flat signal it returns.
 *
 * The route has no service to call - the decision is pure - so what is worth pinning
 * down here is the boundary: what it refuses (a malformed series is a wiring error, a
 * bad threshold is a bad threshold), what it fetches, and what it answers instead of
 * refusing (a series too short to estimate volatility from, a forecast with no ensemble,
 * a VIX that could not be fetched: a flat signal with the reason, which is what an
 * operator wired into a workflow needs to read).
 */
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkAuth: vi.fn(),
  fetchVolatilityContext: vi.fn(),
}))

vi.mock('@/lib/auth/hybrid', () => ({
  AuthType: { SESSION: 'session', API_KEY: 'api_key', INTERNAL_JWT: 'internal_jwt' },
  checkSessionOrInternalAuth: (...args: unknown[]) => mocks.checkAuth(...args),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}))

// Only the fetch is mocked: `isStale` and the rest of the module are the real ones, so
// the freshness rule the signal applies here is the rule production applies.
vi.mock('@/lib/market/volatility', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/market/volatility')>()),
  fetchVolatilityContext: (...args: unknown[]) => mocks.fetchVolatilityContext(...args),
}))

import { deriveKronosSignal } from '@/lib/kronos/signal'
import { POST } from '@/app/api/providers/kronos/signal/route'

const ANCHOR = 5000
const BAR_MS = 5 * 60 * 1000
const LAST_BAR_MS = Date.parse('2026-03-02T12:15:00.000Z')
const NORMAL_VIX = 18.5

/**
 * A VIX complex stamped against the wall clock, because the route reads no clock of its
 * own: `isStale` in the decision layer compares the quote's `asOf` against the real
 * `now`, so a fixture pinned to a fixed date would be decades stale by the time it ran.
 */
const buildVixContext = ({
  vix = NORMAL_VIX,
  ageMs = 0,
}: {
  vix?: number
  ageMs?: number
} = {}) => {
  const asOf = new Date(Date.now() - ageMs).toISOString()
  return {
    vix: { symbol: 'VIX', last: vix, open: vix - 0.5, asOf, source: 'yahoo' },
    vix3m: { symbol: 'VIX3M', last: vix + 1, open: vix + 0.5, asOf, source: 'yahoo' },
  }
}

const buildMarketSeries = (barCount = 40) => ({
  listing: { listing_type: 'default', listing_id: 'MES', base_id: '', quote_id: '' },
  interval: '5m',
  bars: Array.from({ length: barCount }, (_, index) => {
    const close = ANCHOR - (barCount - 1 - index) * 2.5
    return {
      timeStamp: new Date(LAST_BAR_MS - (barCount - 1 - index) * BAR_MS).toISOString(),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
    }
  }),
})

/** A multi-sample forecast: a band on every point and the ensemble's split. */
const buildForecast = ({ shareUp = 0.8, bars = 4 } = {}) => ({
  forecast: Array.from({ length: bars }, (_, index) => ({
    timestamp: new Date(LAST_BAR_MS + (index + 1) * BAR_MS).toISOString(),
    open: ANCHOR,
    high: ANCHOR + 6,
    low: ANCHOR - 1,
    close: ANCHOR + (ANCHOR * 0.01 * (index + 1)) / bars,
    band: { low: ANCHOR - 1, high: ANCHOR + 6 },
  })),
  ensemble: { sampleCount: 8, shareUp },
})

// Exactly the body tools/kronos/signal.ts + blocks/blocks/kronos_signal.ts send.
const buildBlockPayload = (overrides: Record<string, unknown> = {}) => ({
  forecast: buildForecast(),
  marketSeries: buildMarketSeries(),
  ...overrides,
})

const buildRequest = (body: unknown, query = '?workspaceId=workspace-1') =>
  new NextRequest(`http://localhost/api/providers/kronos/signal${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('kronos signal route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.checkAuth.mockResolvedValue({ success: true, userId: 'user-1' })
    // What the route's own fetch answers with, unless a test says otherwise: a fresh VIX
    // in the normal band. Every test that does not carry a context of its own exercises
    // the fetch path this way.
    mocks.fetchVolatilityContext.mockResolvedValue(buildVixContext())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('accepts the payload the kronos_signal block sends', async () => {
    const response = await POST(buildRequest(buildBlockPayload()))
    expect(response.status).toBe(200)

    const signal = await response.json()
    expect(signal.direction).toBe('up')
    expect(signal.action).toBe('buy')
    expect(signal.agreement).toBe(0.8)
    expect(signal.terminalReturnTicks).toBeCloseTo(200, 6)
    // The normal regime's floor is the plan's flat default, so this is the same number
    // the signal produced before the regime existed.
    expect(signal.minAgreement).toBe(0.6)
    expect(signal.regime).toBe('normal')
  })

  it('returns every field the decision layer produces, and nothing nested', async () => {
    const response = await POST(buildRequest(buildBlockPayload()))
    const signal = await response.json()

    // The block declares these as `<kronos_signal_1.field>` outputs; a field missing
    // here resolves to undefined downstream.
    expect(Object.keys(signal).sort()).toEqual(
      Object.keys(
        deriveKronosSignal({
          forecast: buildForecast(),
          closes: buildMarketSeries().bars.map((bar) => bar.close),
        })
      ).sort()
    )

    for (const [field, value] of Object.entries(signal)) {
      expect(['string', 'number', 'boolean'].includes(typeof value) || value === null, field).toBe(
        true
      )
    }
  })

  it('uses the VIX context the body carries, and does not fetch one', async () => {
    // The fetch is told to answer with a stressed tape, so a normal result can only have
    // come from the body's own context.
    mocks.fetchVolatilityContext.mockResolvedValue(buildVixContext({ vix: 35 }))

    const response = await POST(
      buildRequest(buildBlockPayload({ volatility: buildVixContext({ vix: NORMAL_VIX }) }))
    )
    const signal = await response.json()

    expect(response.status).toBe(200)
    expect(mocks.fetchVolatilityContext).not.toHaveBeenCalled()
    expect(signal.regime).toBe('normal')
    expect(signal.vix).toBe(NORMAL_VIX)
    expect(signal.action).toBe('buy')
  })

  it('fetches its own VIX context when the body carries none', async () => {
    const response = await POST(buildRequest(buildBlockPayload()))
    const signal = await response.json()

    expect(response.status).toBe(200)
    expect(mocks.fetchVolatilityContext).toHaveBeenCalledTimes(1)
    expect(signal.regime).toBe('normal')
    expect(signal.vix).toBe(NORMAL_VIX)
    expect(signal.vixStale).toBe(false)
    expect(signal.action).toBe('buy')
  })

  it('stands aside rather than erroring when the fetch returns nothing', async () => {
    mocks.fetchVolatilityContext.mockResolvedValue({ vix: null, vix3m: null })

    const response = await POST(buildRequest(buildBlockPayload()))
    const signal = await response.json()

    expect(response.status).toBe(200)
    expect(signal.regime).toBe('unknown')
    expect(signal.vixStale).toBe(true)
    expect(signal.vix).toBeNull()
    expect(signal.action).toBe('no_trade')
    expect(signal.impliedMovePoints).toBeNull()
    expect(signal.stopPoints).toBeNull()
    expect(signal.reason).toMatch(/the VIX context carried no readable vix quote/)
  })

  it('stands aside rather than erroring when the fetch itself fails', async () => {
    mocks.fetchVolatilityContext.mockRejectedValue(new Error('gateway down'))

    const response = await POST(buildRequest(buildBlockPayload()))
    const signal = await response.json()

    expect(response.status).toBe(200)
    expect(signal.regime).toBe('unknown')
    expect(signal.action).toBe('no_trade')
    expect(signal.reason).toMatch(/no readable vix quote/)
  })

  it('stands aside when the fetched VIX quote is stale', async () => {
    mocks.fetchVolatilityContext.mockResolvedValue(buildVixContext({ ageMs: 30 * 60_000 }))

    const response = await POST(buildRequest(buildBlockPayload()))
    const signal = await response.json()

    expect(signal.regime).toBe('unknown')
    expect(signal.vixStale).toBe(true)
    // The print is reported and flagged: the operator sees the quote that was refused.
    expect(signal.vix).toBe(NORMAL_VIX)
    expect(signal.action).toBe('no_trade')
    expect(signal.reason).toMatch(/the VIX quote is stale/)
  })

  it('blocks a new entry on a stressed tape the body reported', async () => {
    const response = await POST(
      buildRequest(buildBlockPayload({ volatility: buildVixContext({ vix: 35 }) }))
    )
    const signal = await response.json()

    expect(signal.regime).toBe('stressed')
    expect(signal.action).toBe('no_trade')
    expect(signal.reason).toMatch(/the VIX regime is stressed/)
    expect(signal.stopPoints).toBeNull()
    expect(signal.targetTicks).toBeNull()
  })

  it('honours the thresholds it is given', async () => {
    const refused = await POST(buildRequest(buildBlockPayload({ config: { minAgreement: 0.9 } })))
    const refusedSignal = await refused.json()
    expect(refused.status).toBe(200)
    expect(refusedSignal.action).toBe('no_trade')
    expect(refusedSignal.reason).toMatch(/sample agreement 0.800 is below the minimum 0.9/)

    const underTickFloor = await POST(
      buildRequest(buildBlockPayload({ config: { minTerminalReturnTicks: 250 } }))
    )
    expect((await underTickFloor.json()).action).toBe('no_trade')
  })

  it('stands aside on a forecast that carried no ensemble, saying so', async () => {
    const response = await POST(
      buildRequest(
        buildBlockPayload({
          forecast: { forecast: buildForecast().forecast.map(({ band, ...point }) => point) },
        })
      )
    )
    const signal = await response.json()

    expect(response.status).toBe(200)
    expect(signal.agreement).toBeNull()
    expect(signal.action).toBe('no_trade')
    expect(signal.reason).toMatch(/agreement gate was not applied/)
  })

  it('stands aside on a series too short to estimate volatility from', async () => {
    const response = await POST(
      buildRequest(buildBlockPayload({ marketSeries: buildMarketSeries(10) }))
    )
    const signal = await response.json()

    expect(response.status).toBe(200)
    expect(signal.action).toBe('no_trade')
    expect(signal.reason).toMatch(/fewer than the 32 required/)
  })

  it('refuses a series that is not one, the way the forecast route does', async () => {
    const response = await POST(
      buildRequest(buildBlockPayload({ marketSeries: { bars: [{ close: 'high' }] } }))
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/bars\[0\]\.close must be a positive finite/)
  })

  it('refuses a quoted threshold rather than reading it as zero', async () => {
    const response = await POST(
      buildRequest(buildBlockPayload({ config: { minTerminalReturnTicks: '20' } }))
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toBe('Invalid request data')
    expect(JSON.stringify(body.details)).toMatch(/minTerminalReturnTicks/)
  })

  it('refuses a threshold it does not know', async () => {
    const response = await POST(
      buildRequest(buildBlockPayload({ config: { minAgreementRatio: 0.6 } }))
    )

    expect(response.status).toBe(400)
    expect(JSON.stringify((await response.json()).details)).toMatch(/minAgreementRatio/)
  })

  it('refuses a body that is not JSON', async () => {
    const response = await POST(buildRequest('not json'))

    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('Invalid request data')
  })

  it('refuses an unauthenticated caller', async () => {
    mocks.checkAuth.mockResolvedValue({ success: false, error: 'No session' })

    const response = await POST(buildRequest(buildBlockPayload()))
    expect(response.status).toBe(401)
    expect((await response.json()).error).toBe('No session')
  })
})
