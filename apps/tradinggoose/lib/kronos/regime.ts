/**
 * The VIX regime: whether a forecast may trade, how strong it must be, and how
 * far the stop sits.
 *
 * VIX is not an input to the model. Kronos forecasts one OHLCV series and knows
 * nothing about the options market; what the VIX complex says is how large a move
 * the market is already paying for, which is a different question and belongs to
 * the caller. This module is the arithmetic that turns a VIX level, its change on
 * the day and its term structure into the three things a paper trade needs:
 *
 * 1. **Permission** - a stressed market blocks new entries. `sizeBracket` returns
 *    null for it and `MIN_AGREEMENT_BY_REGIME` carries no stressed entry, so a
 *    caller cannot size a trade it was not allowed to take.
 * 2. **Conviction** - the share of the ensemble that must agree rises with the
 *    regime, because being wrong with a divided ensemble costs more on a loud tape.
 * 3. **Geometry** - stop and target are multiples of the move the options market
 *    implies over the horizon that was forecast, so a quiet tape is not asked to
 *    travel as far as a loud one.
 *
 * Pure arithmetic: no IO, no zod, no clock. Inputs that cannot be read come back
 * as a defined answer carrying a reason rather than as a throw - the judgement
 * `signal.ts` makes - because a cycle that cannot decide has to stand aside with
 * something an operator can read, not die.
 */

export type VolatilityRegime = 'calm' | 'normal' | 'elevated' | 'stressed'

export interface VolatilityRegimeInput {
  vix: number
  /** The 3-month index, for the term structure. Absent or unusable means no opinion. */
  vix3m?: number | null
  /** The day's change in VIX, as a percentage (18 means +18%). Null when unknown. */
  vixChangePct?: number | null
}

export interface VolatilityRegimeConfig {
  /** Below this is calm. */
  calmBelow: number // 15
  /** Above this is no longer normal; exactly this still is. */
  elevatedAbove: number // 22
  /** Above this is stressed; exactly this is still elevated. */
  stressedAbove: number // 30
  /** A rise this large in one day is stress whatever the level says. */
  stressedDailyJumpPct: number // 15
  /** Hours the forecast covers. */
  horizonHours: number // 2
  /** Hours in the session the horizon sits inside, for the time scaling. */
  sessionHours: number // 6.5
  /** Stop distance as a multiple of the implied move, per tradable regime. */
  stopMultiplier: Record<Exclude<VolatilityRegime, 'stressed'>, number> // 1.0 / 1.0 / 1.25
  /** Target distance as a multiple of the implied move, per tradable regime. */
  targetMultiplier: Record<Exclude<VolatilityRegime, 'stressed'>, number> // 1.5 / 1.5 / 1.5
  /** A forecast smaller than this multiple of the implied move is not supported. */
  saneMinMultiplier: number // 0.25
  /** A forecast larger than this multiple of the implied move is not supported either. */
  saneMaxMultiplier: number // 2
}

/**
 * The starting points from the plan, to be calibrated by paper results.
 *
 * Nothing here is derived from data - every number is a policy choice - so they
 * live in one object a run can override rather than as literals scattered through
 * the arithmetic.
 */
export const DEFAULT_VOLATILITY_REGIME_CONFIG: VolatilityRegimeConfig = {
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
}

/**
 * The share of the ensemble that must agree with the predicted direction before a
 * trade may be taken. Stressed has no entry: it is not a higher bar, it is a closed
 * door, and a caller that finds no key here has been told that.
 */
export const MIN_AGREEMENT_BY_REGIME: Record<Exclude<VolatilityRegime, 'stressed'>, number> = {
  calm: 0.6,
  normal: 0.6,
  elevated: 0.75,
}

/** Trading days a year, the annualization the VIX quote is itself built on. */
const TRADING_DAYS_PER_YEAR = 252

/**
 * One field of an override, or the default when the caller left it out or handed
 * over something no formula can use. A negative or non-finite setting is a bug
 * upstream, and a bug in the filter must not take the cycle down with it: the
 * default is the answer, and the defaults are the plan's.
 */
const merged = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback

/**
 * Defaults with the caller's overrides laid over them, field by field.
 *
 * A partial config means *these* fields differ, not that the rest are gone: a run
 * that only raises the horizon must keep the plan's stop multiples, or a
 * calibration changes more than it meant to.
 */
const resolveConfig = (overrides: Partial<VolatilityRegimeConfig> = {}): VolatilityRegimeConfig => {
  const base = DEFAULT_VOLATILITY_REGIME_CONFIG
  const stop = overrides.stopMultiplier
  const target = overrides.targetMultiplier
  return {
    calmBelow: merged(overrides.calmBelow, base.calmBelow),
    elevatedAbove: merged(overrides.elevatedAbove, base.elevatedAbove),
    stressedAbove: merged(overrides.stressedAbove, base.stressedAbove),
    stressedDailyJumpPct: merged(overrides.stressedDailyJumpPct, base.stressedDailyJumpPct),
    horizonHours: merged(overrides.horizonHours, base.horizonHours),
    sessionHours: merged(overrides.sessionHours, base.sessionHours),
    stopMultiplier: {
      calm: merged(stop?.calm, base.stopMultiplier.calm),
      normal: merged(stop?.normal, base.stopMultiplier.normal),
      elevated: merged(stop?.elevated, base.stopMultiplier.elevated),
    },
    targetMultiplier: {
      calm: merged(target?.calm, base.targetMultiplier.calm),
      normal: merged(target?.normal, base.targetMultiplier.normal),
      elevated: merged(target?.elevated, base.targetMultiplier.elevated),
    },
    saneMinMultiplier: merged(overrides.saneMinMultiplier, base.saneMinMultiplier),
    saneMaxMultiplier: merged(overrides.saneMaxMultiplier, base.saneMaxMultiplier),
  }
}

/** Two decimals is finer than any VIX reading that changes a decision. */
const shown = (value: number): string => value.toFixed(2)

/**
 * The regime, plus the reasons that decided it.
 *
 * The boundaries resolve one way, once, here: `calm` below 15, `normal` from 15
 * up to and including 22, `elevated` above 22 up to and including 30, `stressed`
 * above 30. Exactly 22 and exactly 30 are the only values where either reading is
 * defensible, and both round down to the quieter regime - which is also the
 * reading that asks for less conviction, so it is the one to be sure of. A
 * boundary that flips between two callers is worse than either choice.
 *
 * Two things override the level, because both mean the market is pricing stress
 * that a mean level has not caught up with yet: a rise of more than
 * `stressedDailyJumpPct` on the day, and an inverted term structure (VIX above
 * VIX3M), which is the shape volatility takes when the near term is what is
 * feared. Either one alone is enough.
 *
 * An unreadable VIX is treated as stressed rather than as calm: a zero or negative
 * index is a broken quote, not a quiet market, and sizing a stop from a broken
 * quote is exactly the mistake this module exists to prevent.
 */
export const classifyVolatilityRegime = (
  input: VolatilityRegimeInput,
  config?: Partial<VolatilityRegimeConfig>
): { regime: VolatilityRegime; reasons: string[] } => {
  const resolved = resolveConfig(config)
  const { vix, vix3m, vixChangePct } = input

  if (!Number.isFinite(vix) || vix <= 0) {
    return {
      regime: 'stressed',
      reasons: [
        'the vix reading is not a positive finite number, so no entry can be sized from it',
      ],
    }
  }

  const reasons: string[] = []
  let level: VolatilityRegime
  if (vix < resolved.calmBelow) {
    level = 'calm'
    reasons.push(`vix ${shown(vix)} is below ${resolved.calmBelow}, the calm threshold`)
  } else if (vix <= resolved.elevatedAbove) {
    level = 'normal'
    reasons.push(
      `vix ${shown(vix)} is between ${resolved.calmBelow} and ${resolved.elevatedAbove}, the normal band`
    )
  } else if (vix <= resolved.stressedAbove) {
    level = 'elevated'
    reasons.push(
      `vix ${shown(vix)} is above ${resolved.elevatedAbove} and at or below ${resolved.stressedAbove}, the elevated band`
    )
  } else {
    level = 'stressed'
    reasons.push(`vix ${shown(vix)} is above ${resolved.stressedAbove}, the stressed threshold`)
  }

  // A jump is a percentage, so a non-finite one is a missing reading, not a large
  // one: it can only ever add stress when it is a number we can compare. VIX3M is
  // read the same way, and a zero for it is a broken quote rather than a term
  // structure steep enough to invert the world.
  const changePct =
    typeof vixChangePct === 'number' && Number.isFinite(vixChangePct) ? vixChangePct : null
  const longEnd = typeof vix3m === 'number' && Number.isFinite(vix3m) && vix3m > 0 ? vix3m : null
  const jumped = changePct !== null && changePct > resolved.stressedDailyJumpPct
  const inverted = longEnd !== null && vix > longEnd

  // The level's own reason stays in the list even when an override fires, so a
  // blocked cycle can say "the level is calm, but the day is not" rather than
  // leaving the operator to guess which rule bit.
  if (jumped) {
    reasons.push(
      `vix is up ${shown(changePct)}% on the day, more than the ${resolved.stressedDailyJumpPct}% that marks stress`
    )
  }
  if (inverted) {
    reasons.push(`vix ${shown(vix)} is above vix3m ${shown(longEnd)}, an inverted term structure`)
  }

  return { regime: jumped || inverted ? 'stressed' : level, reasons }
}

/**
 * Fraction of price, one sigma, over the configured horizon.
 *
 * VIX is quoted as an annualized percentage, so it becomes a daily 1-sigma by
 * dividing by 100 and by the square root of the trading year, then scales with the
 * square root of the time - two hours of a 6.5-hour session is `sqrt(2/6.5)` of a
 * day, which is what makes VIX 16 worth about 0.56% over the plan's horizon.
 *
 * Zero for a VIX that cannot be read, so callers compare against a number rather
 * than a NaN: a NaN silently fails every comparison, and a risk filter that fails
 * open is worse than no filter.
 */
export const impliedMoveFraction = (
  vix: number,
  config?: Partial<VolatilityRegimeConfig>
): number => {
  const resolved = resolveConfig(config)
  if (!Number.isFinite(vix) || vix <= 0) return 0

  const dailySigma = vix / 100 / Math.sqrt(TRADING_DAYS_PER_YEAR)
  // A session of no length has no scale to divide by; the answer is the same zero
  // the unreadable VIX gets, and a zero move may not be traded against.
  const horizonScale =
    resolved.sessionHours > 0 ? Math.sqrt(resolved.horizonHours / resolved.sessionHours) : 0

  return dailySigma * horizonScale
}

/** The same move in index points at `price`. */
export const impliedMovePoints = (
  vix: number,
  price: number,
  config?: Partial<VolatilityRegimeConfig>
): number => {
  if (!Number.isFinite(price) || price <= 0) return 0
  return impliedMoveFraction(vix, config) * price
}

/**
 * Stop and target in points and ticks for a regime; null when entries are blocked.
 *
 * Null is the block-entries signal and nothing else: stressed is the regime that
 * cannot be traded, and a bracket that cannot be expressed in ticks (a tick size
 * of zero, an implied move of none) is the same kind of answer. Callers read null
 * as "do not enter", so this never returns a bracket that quotes a zero stop.
 *
 * Ticks are left fractional. The multiple is what the plan calibrates and a
 * rounding here would quietly change it; an order that must land on a whole tick
 * rounds where it knows how.
 */
export const sizeBracket = (
  regime: VolatilityRegime,
  impliedMovePoints: number,
  tickSize: number,
  config?: Partial<VolatilityRegimeConfig>
): {
  stopPoints: number
  targetPoints: number
  stopTicks: number
  targetTicks: number
} | null => {
  const resolved = resolveConfig(config)

  if (regime === 'stressed') return null
  if (!Number.isFinite(impliedMovePoints) || impliedMovePoints <= 0) return null
  if (!Number.isFinite(tickSize) || tickSize <= 0) return null

  const stopPoints = impliedMovePoints * resolved.stopMultiplier[regime]
  const targetPoints = impliedMovePoints * resolved.targetMultiplier[regime]

  return {
    stopPoints,
    targetPoints,
    stopTicks: stopPoints / tickSize,
    targetTicks: targetPoints / tickSize,
  }
}

/**
 * True when the forecast's terminal move is outside the sane multiples of the
 * implied move.
 *
 * The check is the one piece of discipline that applies in every regime: whatever
 * the VIX says, a forecast that claims a move the options market is not pricing is
 * not a forecast, it is a model artefact, and a stop placed against an implied move
 * it ignores will be hit. The bounds are inclusive, so a forecast of exactly 0.25x
 * or exactly 2x passes.
 *
 * Measured by magnitude, because a forecast down is as supported by the options
 * prices as a forecast up - a short is not a bigger claim than a long.
 *
 * A move that is not a number, or an implied move that is not one, cannot be
 * checked at all, and an uncheckable forecast is an untradable one: that returns
 * true, as does any non-zero forecast measured against the zero implied move an
 * unreadable VIX produces.
 */
export const forecastOutsideImpliedMove = (
  terminalMovePoints: number,
  impliedMovePoints: number,
  config?: Partial<VolatilityRegimeConfig>
): boolean => {
  const resolved = resolveConfig(config)
  if (!Number.isFinite(terminalMovePoints) || !Number.isFinite(impliedMovePoints)) return true

  const magnitude = Math.abs(terminalMovePoints)
  return (
    magnitude < resolved.saneMinMultiplier * impliedMovePoints ||
    magnitude > resolved.saneMaxMultiplier * impliedMovePoints
  )
}
