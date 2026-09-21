/**
 * Scoring a Kronos forecast against what actually happened.
 *
 * The question this answers is the cheap one, and it comes first: does the
 * forecast beat a coin toss? A P&L simulation adds fills, slippage and sizing -
 * more ways to be wrong, stacked on a question still unanswered. If the
 * direction is no better than chance, nothing downstream of it matters.
 *
 * Deliberately pure and free of Kronos itself, so the expensive part (running
 * hundreds of forecasts) is a driver around this, and the arithmetic that
 * decides whether to build the rest of the system is testable in milliseconds.
 */

/** One forecast, the bars it was scored against, and the regime it was made in. */
export interface ForecastObservation {
  /** Close of the last bar the model saw. Direction is measured from here. */
  lastClose: number
  /** Predicted closes, one per horizon bar, oldest first. */
  predictedCloses: number[]
  /** Realized closes for the same bars. Shorter than the forecast means unscored. */
  realizedCloses: number[]
  /**
   * Ensemble band for the terminal bar, if the forecast carried one. Checking
   * whether the realized close lands inside it is the only test that the bands -
   * and so the agreement thresholds built on them - mean anything.
   */
  terminalBand?: { low: number; high: number }
  /** Volatility regime at forecast time, for the breakdown. */
  regime?: string
}

export type Direction = 'up' | 'down' | 'flat'

export interface ForecastScore {
  predicted: Direction
  realized: Direction
  /** Null when either side is flat: no position would have been taken. */
  directionHit: boolean | null
  absoluteError: number
  percentError: number
  /** Null when the forecast carried no band. */
  withinBand: boolean | null
  regime?: string
}

export interface DirectionalSummary {
  /** Forecasts where a direction was actually predicted and realized. */
  evaluated: number
  hits: number
  hitRate: number
  /** Wilson score interval, which stays sane at small samples and extreme rates. */
  confidenceInterval95: { low: number; high: number }
  /** True when the whole interval sits above a coin toss. */
  beatsChance: boolean
}

export interface ForecastScoreSummary {
  scored: number
  directional: DirectionalSummary
  meanAbsoluteError: number
  meanAbsolutePercentError: number
  /** Null when no forecast carried a band. */
  bandCoverage: { evaluated: number; covered: number; rate: number } | null
  byRegime: Record<string, DirectionalSummary>
}

/**
 * The one place a direction is decided. Exported so the live signal path
 * (`signal.ts`) reads a forecast exactly the way the backtest scores it.
 */
export const directionOf = (from: number, to: number): Direction => {
  if (to > from) return 'up'
  if (to < from) return 'down'
  return 'flat'
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * The textbook `p ± 1.96·√(p(1−p)/n)` interval misbehaves exactly where this
 * gets read - small samples, rates near a half - and can produce bounds outside
 * 0..1. Wilson does not, and needs no more information.
 */
export const wilsonInterval = (
  hits: number,
  total: number,
  z = 1.96
): { low: number; high: number } => {
  if (total <= 0) return { low: 0, high: 0 }

  const p = hits / total
  const z2 = z * z
  const denominator = 1 + z2 / total
  const centre = p + z2 / (2 * total)
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)

  return {
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator),
  }
}

/**
 * Score one forecast on its terminal bar.
 *
 * The terminal bar is what the signal acts on - the plan's rules are written
 * against the forecast's end point, not its shape - so that is what is scored.
 */
export const scoreForecast = (observation: ForecastObservation): ForecastScore | null => {
  const { lastClose, predictedCloses, realizedCloses, terminalBand, regime } = observation

  // Only score a forecast whose bars have all closed. A partially realized
  // forecast scored on the bars that happen to exist is a forecast scored on a
  // shorter horizon than it made.
  if (
    predictedCloses.length === 0 ||
    realizedCloses.length < predictedCloses.length ||
    !Number.isFinite(lastClose) ||
    lastClose <= 0
  ) {
    return null
  }

  const predictedTerminal = predictedCloses[predictedCloses.length - 1]
  const realizedTerminal = realizedCloses[predictedCloses.length - 1]
  if (!Number.isFinite(predictedTerminal) || !Number.isFinite(realizedTerminal)) return null

  const predicted = directionOf(lastClose, predictedTerminal)
  const realized = directionOf(lastClose, realizedTerminal)
  const absoluteError = Math.abs(predictedTerminal - realizedTerminal)

  return {
    predicted,
    realized,
    directionHit: predicted === 'flat' || realized === 'flat' ? null : predicted === realized,
    absoluteError,
    percentError: (absoluteError / lastClose) * 100,
    withinBand: terminalBand
      ? realizedTerminal >= terminalBand.low && realizedTerminal <= terminalBand.high
      : null,
    regime,
  }
}

const summariseDirection = (scores: ForecastScore[]): DirectionalSummary => {
  const evaluated = scores.filter((score) => score.directionHit !== null)
  const hits = evaluated.filter((score) => score.directionHit === true).length
  const confidenceInterval95 = wilsonInterval(hits, evaluated.length)

  return {
    evaluated: evaluated.length,
    hits,
    hitRate: evaluated.length > 0 ? hits / evaluated.length : 0,
    confidenceInterval95,
    // Being above a half is not evidence; having the whole interval above it is.
    beatsChance: evaluated.length > 0 && confidenceInterval95.low > 0.5,
  }
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length

export const summariseForecastScores = (scores: ForecastScore[]): ForecastScoreSummary => {
  const banded = scores.filter((score) => score.withinBand !== null)

  const byRegime: Record<string, DirectionalSummary> = {}
  for (const regime of new Set(scores.map((score) => score.regime).filter(Boolean))) {
    byRegime[regime as string] = summariseDirection(
      scores.filter((score) => score.regime === regime)
    )
  }

  return {
    scored: scores.length,
    directional: summariseDirection(scores),
    meanAbsoluteError: mean(scores.map((score) => score.absoluteError)),
    meanAbsolutePercentError: mean(scores.map((score) => score.percentError)),
    bandCoverage:
      banded.length > 0
        ? {
            evaluated: banded.length,
            covered: banded.filter((score) => score.withinBand === true).length,
            rate: banded.filter((score) => score.withinBand === true).length / banded.length,
          }
        : null,
    byRegime,
  }
}

/**
 * The smallest hit rate this many forecasts could show to be better than chance.
 *
 * Reported alongside a result that does not clear it, because "54%" is a
 * property of the sample size, not a constant: MES on Globex yields far more
 * windows than a regular-hours instrument, and stepping through them changes it
 * again. Quoting a fixed number would be wrong for most runs.
 */
export const smallestDetectableHitRate = (evaluated: number): number | null => {
  if (evaluated <= 0) return null

  for (let rate = 0.5; rate <= 0.75; rate += 0.005) {
    if (wilsonInterval(Math.round(evaluated * rate), evaluated).low > 0.5) {
      return Math.round(rate * 1000) / 1000
    }
  }
  return null
}

export interface BacktestWindow<Bar> {
  /** Bars the model is allowed to see. */
  context: Bar[]
  /** Bars it is scored against, which it must not have seen. */
  realized: Bar[]
  /** Index of the last context bar in the original series. */
  originIndex: number
}

/**
 * Cut a series into context/realized pairs.
 *
 * Lookahead is the classic way a backtest flatters a model, and it is an
 * off-by-one: the context must end exactly where the realized bars begin. Doing
 * the slicing here, once, means a driver cannot get it subtly wrong in a loop.
 *
 * `step` trades resolution for wall-clock. On CPU each window is a forecast of
 * tens of seconds, so stepping by 4 turns a ten-hour run into under three.
 */
export function* sliceBacktestWindows<Bar>(
  bars: Bar[],
  {
    contextBars,
    horizonBars,
    step = 1,
  }: { contextBars: number; horizonBars: number; step?: number }
): Generator<BacktestWindow<Bar>> {
  if (contextBars <= 0 || horizonBars <= 0 || step <= 0) return

  for (let end = contextBars; end + horizonBars <= bars.length; end += step) {
    yield {
      context: bars.slice(end - contextBars, end),
      realized: bars.slice(end, end + horizonBars),
      originIndex: end - 1,
    }
  }
}
