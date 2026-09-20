/**
 * The pieces a backtest run needs around `backtest.ts`, kept separate from the
 * CLI so they can be tested without a network or a Kronos service.
 *
 * The run itself is hours long on CPU, so two things matter as much as
 * correctness: it must not lose finished work when something fails partway, and
 * it must be honest about what it could not score rather than quietly shrinking
 * the sample.
 */

import type { ForecastObservation } from '@/lib/kronos/backtest'

export interface Bar {
  timestamp: string
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

/** 10th/90th percentile of the sampled closes, as the service reports them. */
export interface Band {
  low: number
  high: number
}

/** A forecast point, with the band the ensemble put on it when it ran more than one sample. */
export interface ForecastPoint {
  close: number
  band?: Band
}

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/**
 * A band only counts if both edges are numbers. A half-written line or an older
 * record carrying something else is treated as no band at all, which scores as
 * unscored rather than as a band that happened to be missed.
 */
const readBand = (value: unknown): Band | undefined => {
  const band = value as { low?: unknown; high?: unknown } | null | undefined
  const low = finite(band?.low)
  const high = finite(band?.high)
  return low !== undefined && high !== undefined ? { low, high } : undefined
}

/**
 * Yahoo's chart response, which offers 60 days of 15-minute bars against the 30
 * the IBKR provider is configured for. Measured on MES=F: 5,672 timestamps, of
 * which 1,182 are padding, leaving 4,490 usable bars.
 *
 * Yahoo pads its arrays with nulls for gaps, so any bar missing a field is
 * dropped rather than interpolated: a made-up bar would be scored as if it had
 * happened.
 */
export const barsFromYahooChart = (payload: unknown): Bar[] => {
  const result = (payload as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as
    | {
        timestamp?: unknown
        indicators?: { quote?: Array<Record<string, unknown[]>> }
      }
    | undefined

  const stamps = result?.timestamp
  const quote = result?.indicators?.quote?.[0]
  if (!Array.isArray(stamps) || !quote) return []

  const bars: Bar[] = []
  for (let index = 0; index < stamps.length; index++) {
    const seconds = finite(stamps[index])
    const open = finite(quote.open?.[index])
    const high = finite(quote.high?.[index])
    const low = finite(quote.low?.[index])
    const close = finite(quote.close?.[index])
    if (seconds === undefined || open === undefined || close === undefined) continue
    if (high === undefined || low === undefined) continue

    bars.push({
      timestamp: new Date(seconds * 1000).toISOString(),
      open,
      high,
      low,
      close,
      ...(finite(quote.volume?.[index]) !== undefined
        ? { volume: finite(quote.volume?.[index]) }
        : {}),
    })
  }

  return bars
}

/**
 * Drop bars that would make the forecast request invalid, and put them in order.
 *
 * The service rejects a non-positive price and requires strictly increasing
 * timestamps. A duplicate timestamp is the common one, from a provider stitching
 * two requests together, and it fails the whole request rather than one bar.
 */
export const normaliseBars = (bars: Bar[]): Bar[] => {
  const seen = new Set<string>()
  return bars
    .filter((bar) => {
      const time = Date.parse(bar.timestamp)
      if (!Number.isFinite(time) || seen.has(bar.timestamp)) return false
      if (![bar.open, bar.high, bar.low, bar.close].every((value) => value > 0)) return false
      seen.add(bar.timestamp)
      return true
    })
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
}

export interface ForecastWindowRequest {
  requestId: string
  listing: { listingId: string; listingType: string }
  interval: string
  timezone: string
  normalizationMode: string
  history: Bar[]
  futureTimestamps: string[]
  parameters: { temperature: number; topP: number; sampleCount: number }
}

/**
 * Build the forecast request for one window.
 *
 * The future timestamps are the realized bars' own timestamps, so the model is
 * asked about exactly the bars it will be scored against. That also keeps the
 * calendar inference out of the backtest entirely: nothing has to guess where
 * the next bars fall, because history already says.
 */
export const buildWindowRequest = (
  window: { context: Bar[]; realized: Bar[]; originIndex: number },
  options: {
    listingId: string
    listingType?: string
    interval: string
    timezone: string
    temperature: number
    topP: number
    sampleCount: number
  }
): ForecastWindowRequest => ({
  requestId: `backtest-${options.listingId}-${window.originIndex}`,
  listing: { listingId: options.listingId, listingType: options.listingType ?? 'default' },
  interval: options.interval,
  timezone: options.timezone,
  normalizationMode: 'raw',
  history: window.context,
  futureTimestamps: window.realized.map((bar) => bar.timestamp),
  parameters: {
    temperature: options.temperature,
    topP: options.topP,
    sampleCount: options.sampleCount,
  },
})

/** Turn a forecast and its window into something `scoreForecast` can read. */
export const observationFrom = (
  window: { context: Bar[]; realized: Bar[] },
  forecast: ForecastPoint[],
  regime?: string
): ForecastObservation => {
  const terminalBand = readBand(forecast[forecast.length - 1]?.band)

  return {
    lastClose: window.context[window.context.length - 1].close,
    predictedCloses: forecast.map((point) => point.close),
    realizedCloses: window.realized.map((bar) => bar.close),
    ...(terminalBand ? { terminalBand } : {}),
    ...(regime ? { regime } : {}),
  }
}

export interface RunRecord {
  originIndex: number
  lastBar: string
  predictedCloses: number[]
  realizedCloses: number[]
  /** Band on the terminal forecast point, when the run that wrote the record had one. */
  terminalBand?: Band
  regime?: string
}

/**
 * Read back what a previous run finished, so an interrupted run resumes.
 *
 * A full pass is five to ten hours on CPU. Losing it to a restart, a timeout or
 * a full disk means the measurement does not get made, so results are appended
 * per window and completed windows are skipped on the next start.
 */
export const parseRunRecords = (jsonl: string): Map<number, RunRecord> => {
  const records = new Map<number, RunRecord>()
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const record = JSON.parse(trimmed) as RunRecord
      if (typeof record.originIndex === 'number' && Array.isArray(record.predictedCloses)) {
        // Carry the band through, or a resumed run scores every window bandlessly.
        records.set(record.originIndex, { ...record, terminalBand: readBand(record.terminalBand) })
      }
    } catch {
      // A half-written final line is expected after an interrupted run.
    }
  }
  return records
}

/** How far through, and how long the rest will take at the rate so far. */
export const formatProgress = (done: number, total: number, elapsedMs: number): string => {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0
  if (done === 0) return `${done}/${total} (${percent}%)`

  const remainingMs = (elapsedMs / done) * (total - done)
  const minutes = Math.round(remainingMs / 60_000)
  const eta = minutes >= 60 ? `${(minutes / 60).toFixed(1)}h` : `${minutes}m`
  return `${done}/${total} (${percent}%) · ${(elapsedMs / done / 1000).toFixed(1)}s each · ~${eta} left`
}
