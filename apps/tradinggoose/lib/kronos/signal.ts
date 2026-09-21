/**
 * The Kronos Signal: one forecast plus the closes it was anchored to, one decision.
 *
 * This is the first production caller of `signal-policy.ts`, and it exists to keep
 * three things apart that are easy to conflate:
 *
 * 1. **Direction** - which way the terminal median points, using `directionOf` from
 *    `backtest.ts` so the live path and the backtest can never disagree on what
 *    "up" means. A flat terminal median is flat, and a flat direction is not a hit.
 * 2. **Action** - whether the policy's gates let a trade through. A direction with
 *    no action behind it is the normal case, not a bug.
 * 3. **Agreement** - how much of the ensemble actually voted for that direction. The
 *    policy cannot see this: it reasons about one median path. A forecast that ran a
 *    single sample has no disagreement to measure, so the gate is *not applied* and
 *    the reason says so rather than quietly passing it.
 *
 * And around all three, the **regime**, from `regime.ts`: the VIX complex decides how
 * strong the ensemble has to be before it may trade, whether it may trade at all, and
 * how far the stop and target sit. A quote the decision cannot be anchored to - none at
 * all, or one older than the freshness allowance - is the same kind of answer as a
 * missing ensemble: a stand-aside that names what was missing.
 *
 * Pure: no IO, no zod, no clock of its own (`now` is injectable). Everything that
 * cannot be decided stands aside with a reason instead of throwing, so a half-written
 * workflow produces a flat signal an operator can read rather than an error.
 */

import { isStale, type VolatilityContext, type VolatilityQuote } from '@/lib/market/volatility'
import { type Direction, directionOf } from './backtest'
import { deriveForecastSignalInput } from './paper-risk'
import {
  classifyVolatilityRegime,
  DEFAULT_VOLATILITY_REGIME_CONFIG,
  forecastOutsideImpliedMove,
  impliedMoveFraction,
  impliedMovePoints,
  MIN_AGREEMENT_BY_REGIME,
  sizeBracket,
  type VolatilityRegime,
} from './regime'
import { KronosSignalPolicy, type SignalAction, type SignalPolicyConfig } from './signal-policy'

/** Micro E-mini S&P 500 tick: 0.25 index points. Thresholds are quoted in these. */
export const MES_TICK_SIZE = 0.25

/**
 * Share of the ensemble that must agree with the predicted direction. The plan for
 * this phase names 0.6: more than a bare majority, so a near coin-toss ensemble
 * stands aside. Nothing in the repo derives the number - it is a policy choice, and
 * it is a threshold on `shareUp`, not on the backtest's hit rate.
 */
export const DEFAULT_MIN_AGREEMENT = 0.6

/**
 * Floor on the close series. The same 32 bars the forecast request itself requires
 * (`ForecastRequestSchema`), so a series long enough to forecast is long enough to
 * estimate volatility from.
 */
export const MIN_CLOSE_SAMPLES = 32

/**
 * Bars per year used to annualize realized volatility. The interval-aware factor is
 * a later item; until then this is one minute bar of a US equity session, which keeps
 * the policy's 0.6 default roughly comparable across intervals instead of exploding
 * as the interval shortens.
 */
export const DEFAULT_BARS_PER_YEAR = 252 * 390

/** A forecast point, structurally the `ForecastPoint` of `types.ts`. */
export interface KronosSignalPoint {
  close: number
  high?: number
  low?: number
  /** 10th/90th percentile of the sampled closes; absent when one sample was drawn. */
  band?: { low: number; high: number }
}

/**
 * The Kronos Forecast block's output: the points, plus (once the service reports it)
 * how the ensemble split. Both are optional here because a caller may hand over the
 * bare points array instead.
 */
export interface KronosSignalForecastPayload {
  forecast: KronosSignalPoint[]
  ensemble?: { sampleCount?: number; shareUp?: number }
}

export type KronosSignalForecast = KronosSignalPoint[] | KronosSignalForecastPayload

export interface KronosSignalConfig {
  /** Minimum terminal move, in MES ticks, to trade. Absent keeps the policy default. */
  minTerminalReturnTicks?: number
  /** Maximum predicted path drawdown, in MES ticks, to stand aside. Absent keeps the policy default. */
  maxPredictedDrawdownTicks?: number
  /** Realized annualized volatility above which we stand aside. */
  maxRealizedVolatility?: number
  /** Whether the policy may flip an existing position. */
  allowFlip?: boolean
  /** Minimum ensemble agreement, 0..1. Defaults to `DEFAULT_MIN_AGREEMENT`. */
  minAgreement?: number
  /** Annualization factor for realized volatility. Defaults to `DEFAULT_BARS_PER_YEAR`. */
  barsPerYear?: number
  /** The account's current side. Absent means flat, which is all a decision-only caller knows. */
  currentPositionSide?: 'long' | 'short' | 'flat'
  currentPositionQuantity?: number
}

/**
 * The regime as the operator reads it. `unknown` is not a regime: it is the absence of
 * a VIX the decision could be anchored to, and it always accompanies a stand-aside.
 */
export type KronosSignalRegime = VolatilityRegime | 'unknown'

/**
 * Everything the VIX complex decided, flattened for the block's outputs.
 *
 * The bracket is geometry, not permission: it is reported whenever the regime and the
 * anchor allow one to be computed, and every distance is null when the regime blocks
 * entries (stressed) or there is no move to size from.
 */
export interface KronosSignalVolatilityFacts {
  regime: KronosSignalRegime
  /** The VIX last print, even when it turned out to be stale; null when unreadable. */
  vix: number | null
  /** VIX3M's last print, only from a fresh and readable quote. */
  vix3m: number | null
  /** True when the VIX quote was missing, unreadable, or older than the allowance. */
  vixStale: boolean
  /** One sigma over the configured horizon, as a fraction of price. */
  impliedMoveFraction: number | null
  /** The same move in index points at `lastClose`. */
  impliedMovePoints: number | null
  stopPoints: number | null
  targetPoints: number | null
  stopTicks: number | null
  targetTicks: number | null
}

export interface KronosSignalResult extends KronosSignalVolatilityFacts {
  /** Which way the terminal median points, `backtest.ts`'s rule. */
  direction: Direction
  /** What the policy's gates allow. Not the same thing as `direction`. */
  action: SignalAction
  reason: string
  /** Null when the close series could not be read. */
  lastClose: number | null
  /** Null when the forecast carried no usable points. */
  predictedClose: number | null
  terminalReturn: number | null
  terminalReturnTicks: number | null
  predictedDrawdown: number | null
  predictedDrawdownTicks: number | null
  realizedVolatilityAnnualized: number | null
  /** Null when the forecast carried no ensemble, and then the gate is not applied. */
  agreement: number | null
  /** The floor the agreement was measured against: the regime's, unless the caller set one. */
  minAgreement: number
  /** ISO timestamp. The policy's own TTL: 5 minutes for a trade, 1 for a stand-aside. */
  expiresAt: string
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** A band counts only when both edges are numbers; half a band is no band. */
const readBand = (
  point: KronosSignalPoint | undefined
): { low: number; high: number } | undefined => {
  const low = finiteNumber(point?.band?.low)
  const high = finiteNumber(point?.band?.high)
  return low !== undefined && high !== undefined ? { low, high } : undefined
}

const readPoints = (
  forecast: KronosSignalForecast | undefined
): KronosSignalPoint[] | undefined => {
  if (Array.isArray(forecast)) return forecast
  const points = (forecast as KronosSignalForecastPayload | undefined)?.forecast
  return Array.isArray(points) ? points : undefined
}

const readEnsembleShareUp = (forecast: KronosSignalForecast | undefined): number | undefined =>
  Array.isArray(forecast) ? undefined : finiteNumber(forecast?.ensemble?.shareUp)

/**
 * Sample standard deviation of log returns, annualized. The n-1 divisor because the
 * series is a sample of one regime, not a population - and on 32 bars the difference
 * is not cosmetic.
 */
const realizedVolatility = (closes: readonly number[], barsPerYear: number): number => {
  const returns: number[] = []
  for (let index = 1; index < closes.length; index++) {
    returns.push(Math.log(closes[index] / closes[index - 1]))
  }
  if (returns.length < 2) return 0

  const mean = returns.reduce((total, value) => total + value, 0) / returns.length
  const variance =
    returns.reduce((total, value) => total + (value - mean) ** 2, 0) / (returns.length - 1)
  return Math.sqrt(variance) * Math.sqrt(barsPerYear)
}

/** Ticks -> fraction of the anchor price, the unit the policy's thresholds use. */
const fractionOfTicks = (ticks: number, anchor: number): number => (ticks * MES_TICK_SIZE) / anchor

/** Fraction -> ticks, for reporting a threshold in the operator's unit. */
export const ticksOfFraction = (fraction: number, anchor: number): number =>
  (fraction * anchor) / MES_TICK_SIZE

/**
 * The policy's shortest window. A decision this layer stops for its own reasons (the
 * agreement gate) has to expire like the stand-asides the policy produces, and asking
 * the policy for it keeps every TTL in `signal-policy.ts` rather than a second copy of
 * the numbers living here.
 */
const standAsideExpiry = (now: Date): string =>
  new KronosSignalPolicy({}, now).evaluate({
    forecastTerminalReturn: 0,
    predictedPathDrawdown: 0,
    realizedVolatilityAnnualized: 0,
    currentPositionSide: 'flat',
    currentPositionQuantity: 0,
  }).expiresAt

/**
 * A quote the decision can be anchored to, or null.
 *
 * `volatility.ts` has already proved a quote it returns; this is the check for one that
 * arrived from somewhere else - a workflow body, or a caller that built the context by
 * hand. A quote with no positive last print is not a quiet market, it is a broken one.
 */
const readQuote = (value: unknown): VolatilityQuote | null => {
  if (typeof value !== 'object' || value === null) return null
  const quote = value as VolatilityQuote
  const last = finiteNumber(quote.last)
  return last === undefined || last <= 0 ? null : quote
}

/**
 * The day's change in a quote, from the quote's own last against its own open.
 *
 * `open` in `volatility.ts` is TODAY'S opening print from either source - IBKR field
 * 7295, or the first non-null bar open of Yahoo's session - so the difference is the
 * day's change and not a gap against a prior close. When the source carried no open
 * (a pre-open index, or a payload whose open rows were all null) the change cannot be
 * derived, and null is reported rather than a change guessed from a missing print: the
 * classifier reads a non-finite change as no change, which is the honest answer.
 */
const dailyChangePct = (quote: VolatilityQuote): number | null => {
  const open = finiteNumber(quote.open)
  if (open === undefined || open <= 0) return null
  return ((quote.last - open) / open) * 100
}

interface ResolvedVolatility {
  /** Non-null only for a readable, fresh VIX quote; the regime that may trade. */
  regime: VolatilityRegime | null
  vix: number | null
  vix3m: number | null
  vixStale: boolean
  /** Stand-aside reasons for a missing, unreadable or stale context. */
  notes: string[]
}

/**
 * The VIX complex, read once, with the reasons a decision cannot be taken from it.
 *
 * The freshness rule is `volatility.ts`'s own `isStale`, applied here rather than at the
 * fetch site because this layer already owns an injectable clock and the decision is
 * what has to be anchored to a live print. A missing quote and an old one are different
 * reasons and are named differently, but both leave `regime` null: with no regime there
 * is no floor to raise, no entry to permit and no move to size, and every one of those
 * would otherwise be silently filled with a default nobody chose.
 *
 * VIX3M is dropped rather than the whole context when only it is stale: the second leg
 * only sharpens the term-structure check, and the classifier already treats its absence
 * as no opinion rather than as a steepening.
 */
const resolveVolatility = ({
  volatility,
  now,
}: {
  volatility: VolatilityContext | undefined
  now: Date
}): ResolvedVolatility => {
  const vixQuote = readQuote(volatility?.vix)
  const vix3mQuote = readQuote(volatility?.vix3m)
  const freshVix3m = vix3mQuote !== null && !isStale(vix3mQuote, now) ? vix3mQuote.last : null

  if (vixQuote === null) {
    return {
      regime: null,
      vix: null,
      vix3m: freshVix3m,
      vixStale: true,
      notes: [
        volatility === undefined
          ? 'no VIX context was supplied with the forecast and none could be fetched'
          : 'the VIX context carried no readable vix quote',
      ],
    }
  }

  if (isStale(vixQuote, now)) {
    return {
      regime: null,
      vix: vixQuote.last,
      vix3m: freshVix3m,
      vixStale: true,
      notes: [
        `the VIX quote is stale: last print ${vixQuote.last} as of ${vixQuote.asOf}, older than the freshness allowance`,
      ],
    }
  }

  // `reasons` is only read for the blocked regime; the tradable regimes are visible in
  // the `regime` output and in the floor they set.
  const { regime, reasons } = classifyVolatilityRegime({
    vix: vixQuote.last,
    vix3m: freshVix3m,
    vixChangePct: dailyChangePct(vixQuote),
  })

  return {
    regime,
    vix: vixQuote.last,
    vix3m: freshVix3m,
    vixStale: false,
    notes:
      regime === 'stressed'
        ? [
            // The classifier's own reasons, verbatim: the level, the day's jump and the
            // term structure each decide this, and an operator staring at a blocked
            // cycle needs to know which of the three bit.
            `the VIX regime is stressed, so no new entry may be sized: ${reasons.join('; ')}`,
          ]
        : [],
  }
}

/**
 * The VIX facts as the result reports them, at a known anchor.
 *
 * Called once a decision exists (with `lastClose`) and once for the payloads no decision
 * exists for (with null), so every result - including the ones that never got as far as
 * the closes - carries the regime it was judged under.
 */
const volatilityFacts = (
  resolved: ResolvedVolatility,
  lastClose: number | null
): KronosSignalVolatilityFacts => {
  const facts: KronosSignalVolatilityFacts = {
    regime: resolved.regime ?? 'unknown',
    vix: resolved.vix,
    vix3m: resolved.vix3m,
    vixStale: resolved.vixStale,
    impliedMoveFraction: null,
    impliedMovePoints: null,
    stopPoints: null,
    targetPoints: null,
    stopTicks: null,
    targetTicks: null,
  }

  if (resolved.regime === null || resolved.vix === null) return facts
  if (lastClose === null || lastClose <= 0) return facts

  const implied = impliedMovePoints(resolved.vix, lastClose, DEFAULT_VOLATILITY_REGIME_CONFIG)
  const bracket = sizeBracket(resolved.regime, implied, MES_TICK_SIZE)

  return {
    ...facts,
    impliedMoveFraction: impliedMoveFraction(resolved.vix, DEFAULT_VOLATILITY_REGIME_CONFIG),
    impliedMovePoints: implied,
    // sizeBracket is null for a blocked regime, which is the only way an entry is
    // permitted to be sized here; a null bracket is a null bracket, not a zero one.
    stopPoints: bracket?.stopPoints ?? null,
    targetPoints: bracket?.targetPoints ?? null,
    stopTicks: bracket?.stopTicks ?? null,
    targetTicks: bracket?.targetTicks ?? null,
  }
}

/**
 * A stand-aside result, for a payload the decision cannot be made from at all. The
 * volatility facts ride along, so a blocked cycle still says which regime blocked it.
 */
const standAside = (
  now: Date,
  reasons: readonly string[],
  minAgreement: number,
  volatility: KronosSignalVolatilityFacts
): KronosSignalResult => {
  return {
    ...volatility,
    direction: 'flat',
    action: 'no_trade',
    reason: reasons.map((reason) => `standing aside: ${reason}`).join('; '),
    lastClose: null,
    predictedClose: null,
    terminalReturn: null,
    terminalReturnTicks: null,
    predictedDrawdown: null,
    predictedDrawdownTicks: null,
    realizedVolatilityAnnualized: null,
    agreement: null,
    minAgreement,
    expiresAt: standAsideExpiry(now),
  }
}

export function deriveKronosSignal(args: {
  /** Forecast points, or the Kronos Forecast block's output carrying them. */
  forecast: KronosSignalForecast
  /** Realized closes the forecast was anchored to; last element is the anchor. */
  closes: readonly number[]
  /**
   * The VIX complex for this decision, as `fetchVolatilityContext` returns it. Absent,
   * or present but stale, the signal stands aside rather than trading a regime it
   * cannot know: the agreement floor, the entry permission and the stop all come from
   * here, and every one of them would otherwise fall back to a default nobody chose.
   */
  volatility?: VolatilityContext
  config?: KronosSignalConfig
  /** Injectable evaluation instant, so expiries are testable. Defaults to now. */
  now?: Date
}): KronosSignalResult {
  const { forecast, closes, volatility, config = {}, now = new Date() } = args
  const resolved = resolveVolatility({ volatility, now })
  const barsPerYear = finiteNumber(config.barsPerYear) ?? DEFAULT_BARS_PER_YEAR

  // The floor, in the order the caller's intent ranks: an explicit `minAgreement` is the
  // caller overriding the policy and wins outright; otherwise a usable regime sets it;
  // otherwise the plan's flat default. Stressed has no entry in that map because it is
  // a closed door rather than a higher bar - the block comes from the regime note - so
  // the default stands there and is never the reason an entry was allowed.
  const minAgreement =
    finiteNumber(config.minAgreement) ??
    (resolved.regime !== null && resolved.regime !== 'stressed'
      ? MIN_AGREEMENT_BY_REGIME[resolved.regime]
      : DEFAULT_MIN_AGREEMENT)

  // Every stand-aside from here on carries the VIX facts and whatever the VIX had to say
  // about itself: a payload that cannot be judged still has a regime, and reporting it
  // is how an operator tells "no quote" from "a quote the signal could not use".
  const standAsideNow = (reason: string): KronosSignalResult =>
    standAside(now, [reason, ...resolved.notes], minAgreement, volatilityFacts(resolved, null))

  const points = readPoints(forecast)
  if (points === undefined) {
    return standAsideNow('the forecast payload carried no forecast points')
  }
  if (points.length === 0) {
    return standAsideNow('the forecast returned an empty path')
  }

  if (!Array.isArray(closes) || closes.length === 0) {
    return standAsideNow('the market series carried no realized closes')
  }
  if (closes.some((close) => finiteNumber(close) === undefined)) {
    return standAsideNow('the close series carries a close that is not a finite number')
  }
  if (closes.length < MIN_CLOSE_SAMPLES) {
    return standAsideNow(
      `the close series has ${closes.length} bars, fewer than the ${MIN_CLOSE_SAMPLES} required to estimate realized volatility`
    )
  }

  const lastClose = closes[closes.length - 1]
  if (lastClose <= 0) {
    return standAsideNow('the last close must be positive')
  }

  const terminal = points[points.length - 1]
  const predictedClose = finiteNumber(terminal?.close)
  if (predictedClose === undefined) {
    return standAsideNow('the terminal forecast point has no finite close')
  }

  // The same rule the backtest scores with, so a live signal and a backtest agree
  // on what the forecast said. A terminal median equal to the anchor is flat.
  const direction = directionOf(lastClose, predictedClose)

  const realizedVolatilityAnnualized = realizedVolatility(closes, barsPerYear)
  const vixFacts = volatilityFacts(resolved, lastClose)

  // The path the policy sees: the band's low is where the ensemble's 10th percentile
  // got to, so it bounds the excursion better than the median path alone. A point
  // without a band falls back to its own low, and the terminal point's band - the one
  // that says whether an ensemble exists at all - is required below.
  const policyInput = deriveForecastSignalInput({
    lastClose,
    predictedClose,
    predictedPath: points.map((point) => {
      const band = readBand(point)
      const close = finiteNumber(point.close) ?? lastClose
      return {
        high: band?.high ?? finiteNumber(point.high) ?? close,
        low: band?.low ?? finiteNumber(point.low) ?? close,
      }
    }),
    realizedVolatilityAnnualized,
    currentPositionSide: config.currentPositionSide ?? 'flat',
    currentPositionQuantity: config.currentPositionQuantity ?? 0,
  })

  // The futures terms: the operator quotes thresholds in ticks, the policy compares
  // fractions. Absent a tick threshold the policy's own default stands.
  const policyOverrides: Partial<SignalPolicyConfig> = {}
  const minTerminalReturnTicks = finiteNumber(config.minTerminalReturnTicks)
  if (minTerminalReturnTicks !== undefined) {
    policyOverrides.minTerminalReturn = fractionOfTicks(minTerminalReturnTicks, lastClose)
  }
  const maxPredictedDrawdownTicks = finiteNumber(config.maxPredictedDrawdownTicks)
  if (maxPredictedDrawdownTicks !== undefined) {
    policyOverrides.maxPredictedDrawdown = fractionOfTicks(maxPredictedDrawdownTicks, lastClose)
  }
  if (finiteNumber(config.maxRealizedVolatility) !== undefined) {
    policyOverrides.maxRealizedVolatility = config.maxRealizedVolatility
  }
  if (config.allowFlip !== undefined) policyOverrides.allowFlip = config.allowFlip

  const decision = new KronosSignalPolicy(policyOverrides, now).evaluate(policyInput)

  const shareUp = readEnsembleShareUp(forecast)
  const agreement =
    shareUp === undefined ? null : predictedClose > lastClose ? shareUp : 1 - shareUp
  const terminalBand = readBand(terminal)

  // Direction and action are reported separately, but an action the ensemble does not
  // support is not taken: the gates below can only turn a trade into a stand-aside.
  //
  // The VIX notes come first and are the fail-safes: a missing or stale context, and a
  // stressed regime, each of which blocks a new entry whatever the forecast said.
  //
  // A stressed regime blocks NEW ENTRIES and nothing else. Managing a position that is
  // already open - cutting it, or letting it run against a wider stop - is not this
  // layer's job: this layer decides what a forecast is worth entering, it is handed the
  // account side only so the policy can refuse to double up. Flattening an existing
  // position on a stress reading is a separate decision, made by whoever owns the order
  // path, and half-implementing it here would be worse than leaving it out.
  const notes: string[] = resolved.notes.map((note) => `standing aside: ${note}`)

  // The one piece of discipline that holds in every regime: a forecast claiming a move
  // the options market is not pricing is a model artefact rather than a signal, and a
  // stop placed against an implied move the forecast ignores will be hit. Measured by
  // MAGNITUDE, so a forecast down is held to the same band as a forecast up - a short is
  // not a bigger claim than a long.
  const terminalMovePoints = predictedClose - lastClose
  const implied = vixFacts.impliedMovePoints
  if (
    resolved.regime !== null &&
    implied !== null &&
    forecastOutsideImpliedMove(terminalMovePoints, implied)
  ) {
    const { horizonHours, saneMinMultiplier, saneMaxMultiplier } = DEFAULT_VOLATILITY_REGIME_CONFIG
    const magnitude = Math.abs(terminalMovePoints)
    const multiple = implied > 0 ? ` (${(magnitude / implied).toFixed(2)}x it)` : ''
    notes.push(
      `standing aside: the terminal move of ${magnitude.toFixed(1)} points${multiple} is outside the ${saneMinMultiplier}x-${saneMaxMultiplier}x band around the ${implied.toFixed(1)}-point move the VIX implies over ${horizonHours}h`
    )
  }

  if (agreement === null) {
    notes.push(
      'standing aside: the agreement gate was not applied, the forecast carried no ensemble (a single sample)'
    )
  } else if (agreement < minAgreement) {
    notes.push(
      `standing aside: sample agreement ${agreement.toFixed(3)} is below the minimum ${minAgreement}`
    )
  }
  if (terminalBand === undefined) {
    notes.push(
      'standing aside: the terminal forecast point carried no band, so the predicted excursion is unbounded'
    )
  }
  const action: SignalAction = notes.length > 0 ? 'no_trade' : decision.action

  return {
    direction,
    action,
    reason: [decision.reason, ...notes].join('; '),
    lastClose,
    predictedClose,
    terminalReturn: policyInput.forecastTerminalReturn,
    terminalReturnTicks: ticksOfFraction(policyInput.forecastTerminalReturn, lastClose),
    predictedDrawdown: policyInput.predictedPathDrawdown,
    predictedDrawdownTicks: ticksOfFraction(policyInput.predictedPathDrawdown, lastClose),
    realizedVolatilityAnnualized,
    agreement,
    minAgreement,
    // What the regime decided, and the geometry that came with it. Null where no
    // usable VIX was available, and the bracket is null when the regime blocks entries.
    ...vixFacts,
    // A trade this layer stopped still expires on the stand-aside clock, not the one
    // the policy hands the trade it was about to allow.
    expiresAt:
      notes.length > 0 && decision.action !== 'no_trade'
        ? standAsideExpiry(now)
        : decision.expiresAt,
  }
}
