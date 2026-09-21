/**
 * The signal decision layer, without IO.
 *
 * What these pin down, beyond the arithmetic: direction and action are answered
 * separately (a direction with no action behind it is the normal case), the agreement
 * gate is measured against the ensemble rather than the median path, and every way the
 * payload can be unusable ends in a flat signal with a reason rather than a throw. The
 * VIX regime adds the second half of that: a context the decision cannot be anchored to
 * - none, or a stale one - stands aside too, and the floor, the entry permission and the
 * bracket all come from the regime that context decides.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOLATILITY_REGIME_CONFIG,
  impliedMoveFraction,
  impliedMovePoints,
  MIN_AGREEMENT_BY_REGIME,
  sizeBracket,
} from '@/lib/kronos/regime'
import {
  DEFAULT_BARS_PER_YEAR,
  DEFAULT_MIN_AGREEMENT,
  deriveKronosSignal,
  type KronosSignalForecast,
  type KronosSignalForecastPayload,
  type KronosSignalPoint,
  MES_TICK_SIZE,
  MIN_CLOSE_SAMPLES,
} from '@/lib/kronos/signal'
import type { VolatilityContext } from '@/lib/market/volatility'

const NOW = new Date('2026-03-02T14:30:00.000Z')
const ANCHOR = 5000

/** VIX levels that land squarely inside one regime band each. */
const NORMAL_VIX = 18.5
const ELEVATED_VIX = 26
const STRESSED_VIX = 35

/**
 * A VIX complex as `fetchVolatilityContext` returns one, stamped at `NOW` so freshness
 * is a property of the fixture rather than of when the suite runs. Both legs are above
 * their opens by a fraction of a point, which is a small day's change and not a jump.
 */
const vixContext = ({
  vix = NORMAL_VIX,
  vix3m = vix + 1,
  open = vix - 0.5,
  asOf = NOW.toISOString(),
}: {
  vix?: number
  vix3m?: number | null
  open?: number | null
  asOf?: string
} = {}) => ({
  vix: { symbol: 'VIX' as const, last: vix, open, asOf, source: 'yahoo' as const },
  vix3m:
    vix3m === null
      ? null
      : {
          symbol: 'VIX3M' as const,
          last: vix3m,
          open: vix3m - 0.5,
          asOf,
          source: 'yahoo' as const,
        },
})

/** The regime fixture: a fresh, readable, non-inverted VIX in the normal band. */
const VIX = vixContext()

/** A linear ramp ending exactly at `last`, so tick arithmetic is checkable by hand. */
const closesEndingAt = (last: number, count = MIN_CLOSE_SAMPLES) =>
  Array.from({ length: count }, (_, index) => last - (count - 1 - index) * 2.5)

/**
 * A forecast payload whose terminal median is `terminalClose` and whose every point
 * carries a band, as a multi-sample forecast does. `bandLow` bounds the predicted
 * excursion, which is what the drawdown gate reads.
 */
const forecastTo = ({
  terminalClose,
  lastClose = ANCHOR,
  shareUp,
  bandLow,
  bandHigh,
  bars = 4,
  withBand = true,
}: {
  terminalClose: number
  lastClose?: number
  shareUp?: number
  bandLow?: number
  bandHigh?: number
  bars?: number
  withBand?: boolean
}): KronosSignalForecastPayload => {
  const points: KronosSignalPoint[] = Array.from({ length: bars }, (_, index) => {
    const close = lastClose + ((terminalClose - lastClose) * (index + 1)) / bars
    return {
      close,
      ...(withBand
        ? {
            band: {
              low: bandLow ?? Math.min(close, lastClose) - 1,
              high: bandHigh ?? Math.max(close, lastClose) + 1,
            },
          }
        : {}),
    }
  })

  return shareUp === undefined
    ? { forecast: points }
    : { forecast: points, ensemble: { sampleCount: 8, shareUp } }
}

describe('deriveKronosSignal', () => {
  it('reports an up direction and a buy action when every gate passes', () => {
    const result = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.8 }),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
    })

    expect(result.direction).toBe('up')
    expect(result.action).toBe('buy')
    expect(result.agreement).toBe(0.8)
    expect(result.minAgreement).toBe(DEFAULT_MIN_AGREEMENT)
    expect(result.lastClose).toBe(ANCHOR)
    expect(result.predictedClose).toBeCloseTo(ANCHOR * 1.01, 6)
    expect(result.terminalReturn).toBeCloseTo(0.01, 6)
    expect(result.reason).toMatch(/terminal_return=/)
  })

  it('reports a down direction and the ensemble share against it', () => {
    const result = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 0.99, shareUp: 0.25 }),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
    })

    expect(result.direction).toBe('down')
    expect(result.action).toBe('sell')
    expect(result.terminalReturn).toBeCloseTo(-0.01, 6)
    // Three quarters of the ensemble landed below the anchor: that is the agreement
    // for a short, and the quarter that landed above is against it.
    expect(result.agreement).toBeCloseTo(0.75, 6)

    const notEnough = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 0.99, shareUp: 0.65 }),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
    })

    expect(notEnough.direction).toBe('down')
    expect(notEnough.agreement).toBeCloseTo(0.35, 6)
    expect(notEnough.action).toBe('no_trade')
  })

  it('calls a terminal median equal to the anchor flat, and does not trade it', () => {
    const result = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR, shareUp: 0.9 }),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
    })

    expect(result.direction).toBe('flat')
    expect(result.action).toBe('no_trade')
    expect(result.terminalReturn).toBe(0)
    expect(result.reason).toMatch(/below threshold/)
  })

  it('accepts an ensemble at exactly the agreement floor', () => {
    const result = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: DEFAULT_MIN_AGREEMENT }),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
    })

    expect(result.agreement).toBe(DEFAULT_MIN_AGREEMENT)
    expect(result.action).toBe('buy')
  })

  it('stands aside when the ensemble falls just below the floor', () => {
    const result = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.599 }),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
    })

    // The direction is still reported: the forecast said up, the ensemble did not back it.
    expect(result.direction).toBe('up')
    expect(result.action).toBe('no_trade')
    expect(result.agreement).toBe(0.599)
    expect(result.reason).toMatch(/sample agreement 0.599 is below the minimum 0.6/)
  })

  it('honours a lowered agreement floor', () => {
    const result = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.55 }),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
      config: { minAgreement: 0.55 },
    })

    expect(result.action).toBe('buy')
    expect(result.minAgreement).toBe(0.55)
  })

  it('stands aside, saying so, when a single-sample forecast carried no ensemble', () => {
    // What a one-sample forecast actually looks like: no ensemble, and no bands.
    const result = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, withBand: false }),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
    })

    expect(result.agreement).toBeNull()
    expect(result.action).toBe('no_trade')
    expect(result.direction).toBe('up')
    expect(result.reason).toMatch(/agreement gate was not applied/)
    expect(result.reason).toMatch(/carried no ensemble/)
    expect(result.reason).toMatch(/carried no band/)
  })

  it('stands aside when the terminal point carries no band to bound the excursion', () => {
    const result = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.9, withBand: false }),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
    })

    // The ensemble share is there, but nothing bounds the path it was measured against.
    expect(result.agreement).toBe(0.9)
    expect(result.action).toBe('no_trade')
    expect(result.terminalReturnTicks).toBeCloseTo(200, 6)
    expect(result.reason).toMatch(/carried no band/)
  })

  it('converts returns and drawdowns into MES ticks', () => {
    const result = deriveKronosSignal({
      forecast: forecastTo({
        terminalClose: ANCHOR * 1.01,
        shareUp: 0.9,
        bandLow: ANCHOR - 5,
      }),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
    })

    // 1% of 5000 is 50 points: 50 / 0.25.
    expect(result.terminalReturnTicks).toBeCloseTo(200, 6)
    // 5 points of excursion: 5 / 0.25.
    expect(result.predictedDrawdown).toBeCloseTo(0.001, 6)
    expect(result.predictedDrawdownTicks).toBeCloseTo(20, 6)
    expect(MES_TICK_SIZE).toBe(0.25)
  })

  it('reads the tick thresholds it is given, not the fractions they replace', () => {
    const cost = { terminalClose: ANCHOR * 1.01, shareUp: 0.9 }

    const accepted = deriveKronosSignal({
      forecast: forecastTo(cost),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
      // 200 ticks of move against a 100-tick floor.
      config: { minTerminalReturnTicks: 100 },
    })
    expect(accepted.action).toBe('buy')

    const rejected = deriveKronosSignal({
      forecast: forecastTo(cost),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
      // The same move against a 250-tick floor: 0.01 < 0.0125.
      config: { minTerminalReturnTicks: 250 },
    })
    expect(rejected.action).toBe('no_trade')
    expect(rejected.direction).toBe('up')
    expect(rejected.reason).toMatch(/below threshold/)
  })

  it('lets the volatility gate veto a trade the direction supports', () => {
    const result = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.9 }),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
      config: { maxRealizedVolatility: 1e-6 },
    })

    expect(result.direction).toBe('up')
    expect(result.action).toBe('no_trade')
    expect(result.reason).toMatch(/Realized volatility/)
  })

  it('lets the drawdown gate veto a trade on the band low, not the median', () => {
    const medianOnly = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.9, bandLow: ANCHOR - 1 }),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
      config: { maxPredictedDrawdownTicks: 20 },
    })
    expect(medianOnly.action).toBe('buy')

    const deepBand = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.9, bandLow: ANCHOR - 25 }),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
      config: { maxPredictedDrawdownTicks: 20 },
    })
    expect(deepBand.action).toBe('no_trade')
    expect(deepBand.predictedDrawdownTicks).toBeCloseTo(100, 6)
    expect(deepBand.reason).toMatch(/drawdown/)
  })

  it('reports realized volatility annualized, scaled by the bars-per-year it is given', () => {
    const closes = closesEndingAt(ANCHOR)
    const daily = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR, shareUp: 0.9 }),
      closes,
      now: NOW,
      config: { barsPerYear: 252 },
    })
    const minute = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR, shareUp: 0.9 }),
      closes,
      now: NOW,
    })

    expect(daily.realizedVolatilityAnnualized).toBeGreaterThan(0)
    expect(minute.realizedVolatilityAnnualized! / daily.realizedVolatilityAnnualized!).toBeCloseTo(
      Math.sqrt(DEFAULT_BARS_PER_YEAR / 252),
      6
    )
  })

  it('stands aside without throwing when the forecast is empty or unreadable', () => {
    for (const forecast of [[] as KronosSignalPoint[], {} as KronosSignalForecast]) {
      const result = deriveKronosSignal({
        forecast,
        closes: closesEndingAt(ANCHOR),
        now: NOW,
      })

      expect(result.action).toBe('no_trade')
      expect(result.direction).toBe('flat')
      expect(result.predictedClose).toBeNull()
      expect(result.reason).toMatch(/standing aside/)
    }
  })

  it('stands aside without throwing on a short or missing close series', () => {
    const short = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.9 }),
      closes: closesEndingAt(ANCHOR, MIN_CLOSE_SAMPLES - 1),
      now: NOW,
    })

    expect(short.action).toBe('no_trade')
    expect(short.lastClose).toBeNull()
    expect(short.reason).toMatch(/fewer than the 32 required/)

    const missing = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.9 }),
      closes: [],
      now: NOW,
    })

    expect(missing.action).toBe('no_trade')
    expect(missing.reason).toMatch(/carried no realized closes/)
  })

  it('stands aside when a close in the series is not a finite number', () => {
    const closes = closesEndingAt(ANCHOR)
    closes[7] = Number.NaN

    const result = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.9 }),
      closes,
      now: NOW,
    })

    expect(result.action).toBe('no_trade')
    expect(result.reason).toMatch(/not a finite number/)
  })

  it('carries the policy expiry: five minutes for a trade, one for a stand-aside', () => {
    const traded = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.9 }),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
    })
    expect(traded.expiresAt).toBe(new Date(NOW.getTime() + 5 * 60_000).toISOString())

    const stood = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.2 }),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
    })
    expect(stood.expiresAt).toBe(new Date(NOW.getTime() + 60_000).toISOString())

    const unreadable = deriveKronosSignal({ forecast: [], closes: [], now: NOW })
    expect(unreadable.expiresAt).toBe(new Date(NOW.getTime() + 60_000).toISOString())
  })

  it('accepts the bare points array as the forecast', () => {
    const payload = forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.9 })
    const result = deriveKronosSignal({
      forecast: payload.forecast,
      closes: closesEndingAt(ANCHOR),
      now: NOW,
    })

    expect(result.direction).toBe('up')
    // No ensemble field on a bare array, so the gate cannot be applied.
    expect(result.agreement).toBeNull()
    expect(result.action).toBe('no_trade')
  })

  it('passes the account side through to the policy, and defaults it to flat', () => {
    const cost = { terminalClose: ANCHOR * 1.01, shareUp: 0.9 }

    const alreadyLong = deriveKronosSignal({
      forecast: forecastTo(cost),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
      config: { currentPositionSide: 'long', currentPositionQuantity: 2 },
    })

    expect(alreadyLong.direction).toBe('up')
    expect(alreadyLong.action).toBe('no_trade')
    expect(alreadyLong.reason).toMatch(/Already long/)

    // Without a side, the caller is treated as flat: nothing to double up on.
    expect(
      deriveKronosSignal({
        forecast: forecastTo(cost),
        closes: closesEndingAt(ANCHOR),
        volatility: VIX,
        now: NOW,
      }).action
    ).toBe('buy')
  })
})

/**
 * The VIX regime, as it changes the decision end to end.
 *
 * The arithmetic itself is `regime.ts`'s to test. What these pin down is the wiring:
 * which regime reached which gate, that a context the decision cannot be anchored to
 * ends in a stand-aside rather than in a default, and that the geometry the result
 * reports is the geometry the regime module computed.
 */
describe('deriveKronosSignal and the VIX regime', () => {
  const cost = { terminalClose: ANCHOR * 1.01, shareUp: 0.9 }

  const decide = (args: {
    forecast: KronosSignalForecast
    volatility?: VolatilityContext
    config?: Parameters<typeof deriveKronosSignal>[0]['config']
  }) => deriveKronosSignal({ closes: closesEndingAt(ANCHOR), now: NOW, ...args })

  it('reports the regime, the quotes and the geometry the decision used', () => {
    const result = deriveKronosSignal({
      forecast: forecastTo(cost),
      closes: closesEndingAt(ANCHOR),
      volatility: VIX,
      now: NOW,
    })

    expect(result.regime).toBe('normal')
    expect(result.vix).toBe(NORMAL_VIX)
    expect(result.vix3m).toBe(NORMAL_VIX + 1)
    expect(result.vixStale).toBe(false)
    expect(result.impliedMoveFraction).toBeCloseTo(impliedMoveFraction(NORMAL_VIX), 12)
    expect(result.impliedMovePoints).toBeCloseTo(impliedMoveFraction(NORMAL_VIX) * ANCHOR, 6)
  })

  it('raises the floor in an elevated regime: 0.65 trades in normal and stands aside in elevated', () => {
    const marginal = forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.65 })

    const normal = decide({ forecast: marginal, volatility: vixContext({ vix: NORMAL_VIX }) })
    expect(normal.regime).toBe('normal')
    expect(normal.agreement).toBeCloseTo(0.65, 6)
    expect(normal.minAgreement).toBe(MIN_AGREEMENT_BY_REGIME.normal)
    expect(normal.action).toBe('buy')

    // The same forecast, on a tape that asks for more conviction.
    const elevated = decide({ forecast: marginal, volatility: vixContext({ vix: ELEVATED_VIX }) })
    expect(elevated.regime).toBe('elevated')
    expect(elevated.agreement).toBeCloseTo(0.65, 6)
    expect(elevated.minAgreement).toBe(MIN_AGREEMENT_BY_REGIME.elevated)
    expect(elevated.action).toBe('no_trade')
    expect(elevated.reason).toMatch(/sample agreement 0.650 is below the minimum 0.75/)

    // What the elevated tape asks for is still allowed through.
    const convicted = decide({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.8 }),
      volatility: vixContext({ vix: ELEVATED_VIX }),
    })
    expect(convicted.minAgreement).toBe(MIN_AGREEMENT_BY_REGIME.elevated)
    expect(convicted.action).toBe('buy')
  })

  it('blocks new entries in a stressed regime, with the classifier reasons', () => {
    const result = decide({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.95 }),
      // The long end above the short one, so only the level is stressed and the test
      // names one reason rather than the term structure as well.
      volatility: vixContext({ vix: STRESSED_VIX, vix3m: STRESSED_VIX + 1 }),
    })

    expect(result.regime).toBe('stressed')
    // The forecast is still read and reported; it is the entry that is refused.
    expect(result.direction).toBe('up')
    expect(result.action).toBe('no_trade')
    expect(result.reason).toMatch(/the VIX regime is stressed, so no new entry may be sized/)
    expect(result.reason).toMatch(/vix 35\.00 is above 30, the stressed threshold/)

    // `sizeBracket` returns null for a blocked regime, and null is what rides out.
    expect(result.stopPoints).toBeNull()
    expect(result.targetPoints).toBeNull()
    expect(result.stopTicks).toBeNull()
    expect(result.targetTicks).toBeNull()
    // The move the VIX implies is still reported: a blocked cycle says what it saw.
    expect(result.impliedMovePoints).toBeCloseTo(impliedMovePoints(STRESSED_VIX, ANCHOR), 6)
  })

  it('sizes the stop and target from the implied move at the anchor', () => {
    const result = decide({ forecast: forecastTo(cost), volatility: VIX })

    const implied = impliedMovePoints(NORMAL_VIX, ANCHOR)
    const bracket = sizeBracket('normal', implied, MES_TICK_SIZE)
    const config = DEFAULT_VOLATILITY_REGIME_CONFIG

    expect(result.impliedMovePoints).toBeCloseTo(implied, 6)
    expect(result.stopPoints).toBeCloseTo(bracket!.stopPoints, 12)
    expect(result.targetPoints).toBeCloseTo(bracket!.targetPoints, 12)
    expect(result.stopTicks).toBeCloseTo(bracket!.stopTicks, 12)
    expect(result.targetTicks).toBeCloseTo(bracket!.targetTicks, 12)

    // And the bracket really is the regime's multiples of the implied move, in ticks of
    // MES_TICK_SIZE rather than in points.
    expect(result.stopPoints).toBeCloseTo(implied * config.stopMultiplier.normal, 6)
    expect(result.targetPoints).toBeCloseTo(implied * config.targetMultiplier.normal, 6)
    expect(result.stopTicks).toBeCloseTo(result.stopPoints! / MES_TICK_SIZE, 9)
    expect(result.targetTicks).toBeCloseTo(result.targetPoints! / MES_TICK_SIZE, 9)
  })

  it('trades a forecast just inside the implied move and stands aside just outside it', () => {
    const implied = impliedMovePoints(NORMAL_VIX, ANCHOR)
    const band = DEFAULT_VOLATILITY_REGIME_CONFIG

    const inside = decide({
      forecast: forecastTo({ terminalClose: ANCHOR + implied * 1.99, shareUp: 0.9 }),
      volatility: VIX,
    })
    expect(inside.action).toBe('buy')

    const outside = decide({
      forecast: forecastTo({ terminalClose: ANCHOR + implied * 2.01, shareUp: 0.9 }),
      volatility: VIX,
    })
    expect(outside.direction).toBe('up')
    expect(outside.action).toBe('no_trade')
    expect(outside.reason).toMatch(
      new RegExp(`outside the ${band.saneMinMultiplier}x-${band.saneMaxMultiplier}x band`)
    )
    expect(outside.reason).toMatch(/terminal move of \d+\.\d points/)
    expect(outside.reason).toMatch(new RegExp(`around the ${implied.toFixed(1)}-point move`))
  })

  it('measures a down forecast by magnitude, against the same band as an up one', () => {
    const implied = impliedMovePoints(NORMAL_VIX, ANCHOR)

    const inside = decide({
      forecast: forecastTo({ terminalClose: ANCHOR - implied * 1.99, shareUp: 0.1 }),
      volatility: VIX,
    })
    expect(inside.direction).toBe('down')
    expect(inside.action).toBe('sell')

    const outside = decide({
      forecast: forecastTo({ terminalClose: ANCHOR - implied * 2.01, shareUp: 0.1 }),
      volatility: VIX,
    })
    expect(outside.direction).toBe('down')
    expect(outside.action).toBe('no_trade')
    expect(outside.reason).toMatch(/outside the 0.25x-2x band/)

    // The magnitude is the same number an upward forecast of the same size reports: a
    // short is not a bigger claim than a long.
    const magnitude = (reason: string) => /terminal move of (\d+\.\d) points/.exec(reason)?.[1]
    const up = decide({
      forecast: forecastTo({ terminalClose: ANCHOR + implied * 2.01, shareUp: 0.9 }),
      volatility: VIX,
    })
    expect(magnitude(outside.reason)).toBe(magnitude(up.reason))
    expect(magnitude(outside.reason)).toBeDefined()
  })

  it('stands aside when there is no VIX context at all, naming what was missing', () => {
    const result = deriveKronosSignal({
      forecast: forecastTo(cost),
      closes: closesEndingAt(ANCHOR),
      now: NOW,
    })

    expect(result.regime).toBe('unknown')
    expect(result.vixStale).toBe(true)
    expect(result.vix).toBeNull()
    expect(result.vix3m).toBeNull()
    expect(result.action).toBe('no_trade')
    expect(result.direction).toBe('up')
    // No regime to raise the floor, so the plan's flat default stands.
    expect(result.minAgreement).toBe(DEFAULT_MIN_AGREEMENT)
    expect(result.reason).toMatch(
      /standing aside: no VIX context was supplied with the forecast and none could be fetched/
    )
    expect(result.impliedMovePoints).toBeNull()
    expect(result.stopPoints).toBeNull()
    expect(result.expiresAt).toBe(new Date(NOW.getTime() + 60_000).toISOString())
  })

  it('stands aside on a stale VIX quote, naming the print it could not use', () => {
    const result = decide({
      forecast: forecastTo(cost),
      volatility: vixContext({ asOf: new Date(NOW.getTime() - 30 * 60_000).toISOString() }),
    })

    expect(result.vixStale).toBe(true)
    expect(result.regime).toBe('unknown')
    // The print is reported and flagged, not hidden: an operator needs to see what the
    // filter was handed.
    expect(result.vix).toBe(NORMAL_VIX)
    expect(result.action).toBe('no_trade')
    expect(result.reason).toMatch(/standing aside: the VIX quote is stale/)
    expect(result.reason).toMatch(/older than the freshness allowance/)
    expect(result.impliedMovePoints).toBeNull()
  })

  it('stands aside when the context carries no readable vix quote', () => {
    const result = decide({
      forecast: forecastTo(cost),
      volatility: { vix: null, vix3m: null },
    })

    expect(result.regime).toBe('unknown')
    expect(result.action).toBe('no_trade')
    expect(result.reason).toMatch(/the VIX context carried no readable vix quote/)
  })

  it('gives an explicit minAgreement the last word over the regime floor', () => {
    const marginal = forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.65 })

    // Lowered below the elevated floor: the caller asked to trade this tape.
    const lowered = decide({
      forecast: marginal,
      volatility: vixContext({ vix: ELEVATED_VIX }),
      config: { minAgreement: 0.6 },
    })
    expect(lowered.regime).toBe('elevated')
    expect(lowered.minAgreement).toBe(0.6)
    expect(lowered.action).toBe('buy')

    // Raised above the calm floor: the caller is stricter than the regime, and wins.
    const raised = decide({
      forecast: marginal,
      volatility: vixContext({ vix: 12 }),
      config: { minAgreement: 0.9 },
    })
    expect(raised.regime).toBe('calm')
    expect(raised.minAgreement).toBe(0.9)
    expect(raised.action).toBe('no_trade')
  })

  it('carries the regime and the stand-aside into a payload it could not read at all', () => {
    const result = deriveKronosSignal({
      forecast: [],
      closes: [],
      volatility: vixContext({ vix: ELEVATED_VIX }),
      now: NOW,
    })

    expect(result.regime).toBe('elevated')
    expect(result.vix).toBe(ELEVATED_VIX)
    expect(result.action).toBe('no_trade')
    expect(result.minAgreement).toBe(MIN_AGREEMENT_BY_REGIME.elevated)
    expect(result.reason).toMatch(/the forecast returned an empty path/)
  })
})
