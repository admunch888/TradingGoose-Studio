/**
 * The signal decision layer, without IO.
 *
 * What these pin down, beyond the arithmetic: direction and action are answered
 * separately (a direction with no action behind it is the normal case), the agreement
 * gate is measured against the ensemble rather than the median path, and every way the
 * payload can be unusable ends in a flat signal with a reason rather than a throw.
 */

import { describe, expect, it } from 'vitest'
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

const NOW = new Date('2026-03-02T14:30:00.000Z')
const ANCHOR = 5000

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
      now: NOW,
    })

    expect(result.agreement).toBe(DEFAULT_MIN_AGREEMENT)
    expect(result.action).toBe('buy')
  })

  it('stands aside when the ensemble falls just below the floor', () => {
    const result = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.599 }),
      closes: closesEndingAt(ANCHOR),
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
      now: NOW,
      // 200 ticks of move against a 100-tick floor.
      config: { minTerminalReturnTicks: 100 },
    })
    expect(accepted.action).toBe('buy')

    const rejected = deriveKronosSignal({
      forecast: forecastTo(cost),
      closes: closesEndingAt(ANCHOR),
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
      now: NOW,
      config: { maxPredictedDrawdownTicks: 20 },
    })
    expect(medianOnly.action).toBe('buy')

    const deepBand = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.9, bandLow: ANCHOR - 25 }),
      closes: closesEndingAt(ANCHOR),
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
      now: NOW,
    })
    expect(traded.expiresAt).toBe(new Date(NOW.getTime() + 5 * 60_000).toISOString())

    const stood = deriveKronosSignal({
      forecast: forecastTo({ terminalClose: ANCHOR * 1.01, shareUp: 0.2 }),
      closes: closesEndingAt(ANCHOR),
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
      now: NOW,
      config: { currentPositionSide: 'long', currentPositionQuantity: 2 },
    })

    expect(alreadyLong.direction).toBe('up')
    expect(alreadyLong.action).toBe('no_trade')
    expect(alreadyLong.reason).toMatch(/Already long/)

    // Without a side, the caller is treated as flat: nothing to double up on.
    expect(
      deriveKronosSignal({ forecast: forecastTo(cost), closes: closesEndingAt(ANCHOR), now: NOW })
        .action
    ).toBe('buy')
  })
})
