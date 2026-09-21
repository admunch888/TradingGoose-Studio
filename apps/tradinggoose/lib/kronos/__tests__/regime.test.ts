import { describe, expect, it } from 'vitest'
import {
  classifyVolatilityRegime,
  DEFAULT_VOLATILITY_REGIME_CONFIG,
  forecastOutsideImpliedMove,
  impliedMoveFraction,
  impliedMovePoints,
  MIN_AGREEMENT_BY_REGIME,
  sizeBracket,
} from '../regime'

const MES_TICK_SIZE = 0.25

describe('classifyVolatilityRegime', () => {
  it('reads the regime boundaries, with the overlaps resolving down', () => {
    expect(classifyVolatilityRegime({ vix: 14.9 }).regime).toBe('calm')
    expect(classifyVolatilityRegime({ vix: 14.99 }).regime).toBe('calm')
    expect(classifyVolatilityRegime({ vix: 15 }).regime).toBe('normal')
    expect(classifyVolatilityRegime({ vix: 15.01 }).regime).toBe('normal')
    // 22 is normal and 30 is elevated: the plan fixes the overlaps toward the
    // quieter regime, so the boundary values are not left to the caller.
    expect(classifyVolatilityRegime({ vix: 22 }).regime).toBe('normal')
    expect(classifyVolatilityRegime({ vix: 22.01 }).regime).toBe('elevated')
    expect(classifyVolatilityRegime({ vix: 30 }).regime).toBe('elevated')
    expect(classifyVolatilityRegime({ vix: 30.1 }).regime).toBe('stressed')
  })

  it('reports the level reason it decided from', () => {
    expect(classifyVolatilityRegime({ vix: 12.5 }).reasons.join(' ')).toContain('calm')
    expect(classifyVolatilityRegime({ vix: 18 }).reasons.join(' ')).toContain('normal band')
    expect(classifyVolatilityRegime({ vix: 25 }).reasons.join(' ')).toContain('elevated')
    expect(classifyVolatilityRegime({ vix: 35 }).reasons.join(' ')).toContain('stressed')
  })

  it('treats a 20% daily jump as stressed at an otherwise normal level', () => {
    const { regime, reasons } = classifyVolatilityRegime({ vix: 18, vixChangePct: 20 })
    expect(regime).toBe('stressed')
    expect(reasons.join(' ')).toContain('20.00%')
  })

  it('treats an inverted VIX/VIX3M as stressed at an otherwise normal level', () => {
    const { regime, reasons } = classifyVolatilityRegime({ vix: 18, vix3m: 16 })
    expect(regime).toBe('stressed')
    expect(reasons.join(' ')).toContain('inverted term structure')
  })

  it('treats a jump inside an otherwise calm level as stressed', () => {
    expect(classifyVolatilityRegime({ vix: 12, vixChangePct: 20 }).regime).toBe('stressed')
  })

  it('treats an inverted term structure inside an otherwise calm level as stressed', () => {
    expect(classifyVolatilityRegime({ vix: 12, vix3m: 11 }).regime).toBe('stressed')
  })

  it('keeps the calm level in the reasons when an override fires', () => {
    const { reasons } = classifyVolatilityRegime({ vix: 12, vixChangePct: 20 })
    expect(reasons.join(' ')).toContain('calm')
    expect(reasons.join(' ')).toContain('marks stress')
  })

  it('leaves a calm-but-rising day alone below the jump threshold', () => {
    expect(classifyVolatilityRegime({ vix: 12, vixChangePct: 15 }).regime).toBe('calm')
    expect(classifyVolatilityRegime({ vix: 12, vixChangePct: 14.99 }).regime).toBe('calm')
  })

  it('leaves a flat or upward-sloping term structure alone', () => {
    expect(classifyVolatilityRegime({ vix: 18, vix3m: 18 }).regime).toBe('normal')
    expect(classifyVolatilityRegime({ vix: 18, vix3m: 21 }).regime).toBe('normal')
  })

  it('ignores a missing or unusable VIX3M and daily change', () => {
    expect(classifyVolatilityRegime({ vix: 18, vix3m: null, vixChangePct: null }).regime).toBe(
      'normal'
    )
    expect(classifyVolatilityRegime({ vix: 18, vix3m: Number.NaN }).regime).toBe('normal')
    expect(classifyVolatilityRegime({ vix: 18, vix3m: 0 }).regime).toBe('normal')
    expect(classifyVolatilityRegime({ vix: 18, vixChangePct: Number.NaN }).regime).toBe('normal')
  })

  it('blocks entries when the VIX itself cannot be read', () => {
    // A zero or negative index is a broken quote, not a quiet market, and sizing a
    // stop from it is the mistake the whole module exists to prevent.
    for (const vix of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { regime, reasons } = classifyVolatilityRegime({ vix })
      expect(regime).toBe('stressed')
      expect(reasons.length).toBeGreaterThan(0)
    }
  })

  it('reads the regime from overridden boundaries', () => {
    expect(classifyVolatilityRegime({ vix: 18 }, { calmBelow: 20 }).regime).toBe('calm')
    expect(
      classifyVolatilityRegime({ vix: 14, vixChangePct: 6 }, { stressedDailyJumpPct: 5 }).regime
    ).toBe('stressed')
    expect(classifyVolatilityRegime({ vix: 25 }, { stressedAbove: 24 }).regime).toBe('stressed')
  })
})

describe('impliedMoveFraction and impliedMovePoints', () => {
  it("matches the plan's worked example: VIX 16 over two hours", () => {
    // 16 / 100 / sqrt(252) * sqrt(2 / 6.5) = 0.00559, or about 0.56%.
    expect(impliedMoveFraction(16)).toBeCloseTo(0.0056, 3)
    expect(impliedMovePoints(16, 6000)).toBeCloseTo(33.5, 0)
  })

  it('scales with the square root of the horizon', () => {
    const twoHours = impliedMoveFraction(20)
    const eightHours = impliedMoveFraction(20, { horizonHours: 8 })

    // Eight hours is four times the horizon, so double the move.
    expect(eightHours).toBeCloseTo(twoHours * 2, 10)
  })

  it('scales with the session it is measured against', () => {
    const halfSession = impliedMoveFraction(20, { sessionHours: 13 })
    expect(halfSession).toBeCloseTo(impliedMoveFraction(20) / Math.sqrt(2), 10)
  })

  it('scales linearly with the index level in points', () => {
    expect(impliedMovePoints(20, 6000) * 2).toBeCloseTo(impliedMovePoints(20, 12000), 10)
  })

  it('is zero for an unusable VIX or price, never NaN', () => {
    // NaN fails every comparison silently, which is the one failure mode a risk
    // filter must not have.
    expect(impliedMoveFraction(0)).toBe(0)
    expect(impliedMoveFraction(-10)).toBe(0)
    expect(impliedMoveFraction(Number.NaN)).toBe(0)
    expect(impliedMovePoints(20, 0)).toBe(0)
    expect(impliedMovePoints(20, -1)).toBe(0)
  })
})

describe('sizeBracket', () => {
  const implied = impliedMovePoints(16, 6000)

  it('sizes the stop and target at the multiple of the implied move the regime names', () => {
    const calm = sizeBracket('calm', implied, MES_TICK_SIZE)
    const normal = sizeBracket('normal', implied, MES_TICK_SIZE)
    const elevated = sizeBracket('elevated', implied, MES_TICK_SIZE)

    expect(calm?.stopPoints).toBeCloseTo(implied, 10)
    expect(calm?.targetPoints).toBeCloseTo(implied * 1.5, 10)
    expect(normal?.stopPoints).toBeCloseTo(implied, 10)
    expect(elevated?.stopPoints).toBeCloseTo(implied * 1.25, 10)
    // The target is 1.5x in every regime a trade may be taken in.
    for (const bracket of [calm, normal, elevated]) {
      expect(bracket?.targetPoints).toBeCloseTo(implied * 1.5, 10)
    }
  })

  it('quotes the same bracket in MES ticks', () => {
    const bracket = sizeBracket('elevated', implied, MES_TICK_SIZE)
    expect(bracket?.stopTicks).toBeCloseTo((implied * 1.25) / MES_TICK_SIZE, 10)
    expect(bracket?.targetTicks).toBeCloseTo((implied * 1.5) / MES_TICK_SIZE, 10)
  })

  it('returns null in stressed, the block-entries signal', () => {
    expect(sizeBracket('stressed', implied, MES_TICK_SIZE)).toBeNull()
  })

  it('returns null rather than a zero-stop bracket when there is nothing to size against', () => {
    expect(sizeBracket('calm', 0, MES_TICK_SIZE)).toBeNull()
    expect(sizeBracket('calm', Number.NaN, MES_TICK_SIZE)).toBeNull()
    expect(sizeBracket('calm', implied, 0)).toBeNull()
    expect(sizeBracket('calm', implied, -0.25)).toBeNull()
  })

  it('honours an overridden multiple without taking the other regimes with it', () => {
    const overridden = sizeBracket('elevated', implied, MES_TICK_SIZE, {
      stopMultiplier: { calm: 1, normal: 1, elevated: 3 },
    })
    expect(overridden?.stopPoints).toBeCloseTo(implied * 3, 10)
    // The target multiples were not part of the override and are still the plan's.
    expect(overridden?.targetPoints).toBeCloseTo(implied * 1.5, 10)
    expect(sizeBracket('calm', implied, MES_TICK_SIZE)?.stopPoints).toBeCloseTo(implied, 10)
  })
})

describe('forecastOutsideImpliedMove', () => {
  const implied = 40

  it('passes a forecast between the sane multiples, inclusively', () => {
    expect(forecastOutsideImpliedMove(10, implied)).toBe(false) // exactly 0.25x
    expect(forecastOutsideImpliedMove(80, implied)).toBe(false) // exactly 2x
    expect(forecastOutsideImpliedMove(implied, implied)).toBe(false)
  })

  it('rejects a forecast just outside either bound', () => {
    expect(forecastOutsideImpliedMove(10 - 0.01, implied)).toBe(true)
    expect(forecastOutsideImpliedMove(80 + 0.01, implied)).toBe(true)
    expect(forecastOutsideImpliedMove(0, implied)).toBe(true)
  })

  it('measures a down forecast by magnitude', () => {
    // A short is not a larger claim than a long: -1.5x the implied move is as
    // supported as +1.5x, and -2.5x is as unsupported as +2.5x.
    expect(forecastOutsideImpliedMove(-1.5 * implied, implied)).toBe(false)
    expect(forecastOutsideImpliedMove(-0.25 * implied, implied)).toBe(false)
    expect(forecastOutsideImpliedMove(-2.5 * implied, implied)).toBe(true)
  })

  it('rejects anything it cannot check', () => {
    expect(forecastOutsideImpliedMove(Number.NaN, implied)).toBe(true)
    expect(forecastOutsideImpliedMove(implied, Number.NaN)).toBe(true)
    // An unreadable VIX gives a zero implied move, and a real forecast is then
    // outside a band that only contains zero.
    expect(forecastOutsideImpliedMove(implied, 0)).toBe(true)
  })

  it('reads the sane band from the config', () => {
    expect(forecastOutsideImpliedMove(10, implied, { saneMinMultiplier: 0.1 })).toBe(false)
    expect(forecastOutsideImpliedMove(120, implied, { saneMaxMultiplier: 4 })).toBe(false)
  })
})

describe('config', () => {
  it("carries the plan's starting points", () => {
    expect(DEFAULT_VOLATILITY_REGIME_CONFIG).toEqual({
      calmBelow: 15,
      elevatedAbove: 22,
      stressedAbove: 30,
      stressedDailyJumpPct: 15,
      horizonHours: 2,
      sessionHours: 6.5,
      stopMultiplier: { calm: 1, normal: 1, elevated: 1.25 },
      targetMultiplier: { calm: 1.5, normal: 1.5, elevated: 1.5 },
      saneMinMultiplier: 0.25,
      saneMaxMultiplier: 2,
    })
  })

  it('asks for more agreement as the regime worsens, and names no stressed entry', () => {
    expect(MIN_AGREEMENT_BY_REGIME.calm).toBe(0.6)
    expect(MIN_AGREEMENT_BY_REGIME.normal).toBe(0.6)
    expect(MIN_AGREEMENT_BY_REGIME.elevated).toBe(0.75)
    expect(Object.keys(MIN_AGREEMENT_BY_REGIME)).toEqual(['calm', 'normal', 'elevated'])
  })

  it('merges an override onto the defaults rather than replacing them', () => {
    const { regime, reasons } = classifyVolatilityRegime({ vix: 18 }, { calmBelow: 20 })
    expect(regime).toBe('calm')
    expect(reasons.join(' ')).toContain('20')
    // Only the calm threshold moved: 21 is still inside the default normal band.
    expect(classifyVolatilityRegime({ vix: 21 }, { calmBelow: 20 }).regime).toBe('normal')

    // The untouched fields are still the plan's: a raised horizon must not
    // silently take the stop multiples with it.
    expect(sizeBracket('elevated', 40, MES_TICK_SIZE, { horizonHours: 8 })?.stopPoints).toBeCloseTo(
      50,
      10
    )
    expect(forecastOutsideImpliedMove(40, 40, { horizonHours: 8 })).toBe(false)
  })

  it('falls back to the default for a config value no formula can use', () => {
    expect(impliedMoveFraction(16, { horizonHours: -2 })).toBeCloseTo(impliedMoveFraction(16), 10)
    expect(impliedMoveFraction(16, { sessionHours: Number.NaN })).toBeCloseTo(
      impliedMoveFraction(16),
      10
    )
    expect(
      sizeBracket('calm', 40, MES_TICK_SIZE, {
        stopMultiplier: { calm: Number.NaN, normal: 1, elevated: 1.25 },
      })?.stopPoints
    ).toBeCloseTo(40, 10)
  })
})
