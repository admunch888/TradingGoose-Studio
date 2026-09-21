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
 * Pure: no IO, no zod, no clock of its own (`now` is injectable). Everything that
 * cannot be decided stands aside with a reason instead of throwing, so a half-written
 * workflow produces a flat signal an operator can read rather than an error.
 */

import { type Direction, directionOf } from './backtest'
import { deriveForecastSignalInput } from './paper-risk'
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

export interface KronosSignalResult {
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
 * A stand-aside result, for a payload the decision cannot be made from at all.
 */
const standAside = (now: Date, reason: string, minAgreement: number): KronosSignalResult => {
  return {
    direction: 'flat',
    action: 'no_trade',
    reason: `standing aside: ${reason}`,
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
  config?: KronosSignalConfig
  /** Injectable evaluation instant, so expiries are testable. Defaults to now. */
  now?: Date
}): KronosSignalResult {
  const { forecast, closes, config = {}, now = new Date() } = args
  const minAgreement = finiteNumber(config.minAgreement) ?? DEFAULT_MIN_AGREEMENT
  const barsPerYear = finiteNumber(config.barsPerYear) ?? DEFAULT_BARS_PER_YEAR

  const points = readPoints(forecast)
  if (points === undefined) {
    return standAside(now, 'the forecast payload carried no forecast points', minAgreement)
  }
  if (points.length === 0) {
    return standAside(now, 'the forecast returned an empty path', minAgreement)
  }

  if (!Array.isArray(closes) || closes.length === 0) {
    return standAside(now, 'the market series carried no realized closes', minAgreement)
  }
  if (closes.some((close) => finiteNumber(close) === undefined)) {
    return standAside(
      now,
      'the close series carries a close that is not a finite number',
      minAgreement
    )
  }
  if (closes.length < MIN_CLOSE_SAMPLES) {
    return standAside(
      now,
      `the close series has ${closes.length} bars, fewer than the ${MIN_CLOSE_SAMPLES} required to estimate realized volatility`,
      minAgreement
    )
  }

  const lastClose = closes[closes.length - 1]
  if (lastClose <= 0) {
    return standAside(now, 'the last close must be positive', minAgreement)
  }

  const terminal = points[points.length - 1]
  const predictedClose = finiteNumber(terminal?.close)
  if (predictedClose === undefined) {
    return standAside(now, 'the terminal forecast point has no finite close', minAgreement)
  }

  // The same rule the backtest scores with, so a live signal and a backtest agree
  // on what the forecast said. A terminal median equal to the anchor is flat.
  const direction = directionOf(lastClose, predictedClose)

  const realizedVolatilityAnnualized = realizedVolatility(closes, barsPerYear)

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
  const notes: string[] = []
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
    // A trade this layer stopped still expires on the stand-aside clock, not the one
    // the policy hands the trade it was about to allow.
    expiresAt:
      notes.length > 0 && decision.action !== 'no_trade'
        ? standAsideExpiry(now)
        : decision.expiresAt,
  }
}
