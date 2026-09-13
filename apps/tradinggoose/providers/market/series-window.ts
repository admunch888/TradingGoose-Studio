import type {
  MarketSeriesRange,
  MarketSeriesWindow,
  MarketSeriesWindowMode,
} from '@/providers/market/types'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Bar count used when a caller (block, widget) has no explicit window. Matches the
 * chart widget default so a caller-provided series and an editor-provided series agree.
 */
export const DEFAULT_SERIES_BAR_COUNT = 500

/** Range used only when a provider does not advertise `bars` window support. */
export const DEFAULT_SERIES_RANGE: MarketSeriesRange = { value: 1, unit: 'year' }

/**
 * Smallest shape a provider-param capability needs for interval defaulting. Kept
 * structural so this module stays free of provider-config imports.
 */
export interface SeriesIntervalCapabilities {
  supportsInterval?: boolean
  intervals?: ReadonlyArray<string>
}

/**
 * Builds a window that a provider advertising `allowedModes` accepts. `bars` is
 * preferred because every registered series provider advertises it and a bar count
 * is stable across intervals and market calendars.
 */
export const resolveDefaultSeriesWindow = (
  allowedModes?: MarketSeriesWindowMode[]
): MarketSeriesWindow | null => {
  const modes = allowedModes && allowedModes.length > 0 ? allowedModes : (['bars'] as const)

  if (modes.includes('bars')) {
    return { mode: 'bars', barCount: DEFAULT_SERIES_BAR_COUNT }
  }

  if (modes.includes('range')) {
    return { mode: 'range', range: DEFAULT_SERIES_RANGE }
  }

  if (modes.includes('absolute')) {
    const endMs = Date.now()
    const startMs = endMs - (rangeToMs(DEFAULT_SERIES_RANGE) ?? 0)
    return {
      mode: 'absolute',
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    }
  }

  return null
}

/**
 * Picks a default interval for a provider. Returns undefined when the provider
 * declares no interval support or advertises an empty interval list, so callers
 * never emit an interval the provider rejects. Prefers a daily interval because the
 * editor's series blocks are used for daily-resolution analysis by default.
 */
export const resolveDefaultSeriesInterval = (
  capabilities?: SeriesIntervalCapabilities | null
): string | undefined => {
  if (!capabilities) return undefined
  if (capabilities.supportsInterval === false) return undefined

  const intervals = capabilities.intervals ?? []
  if (intervals.length === 0) return undefined

  return intervals.includes('1d') ? '1d' : intervals[0]
}

const parseDateInput = (value?: string | number | null): Date | null => {
  if (value === undefined || value === null) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date
}

export const rangeToMs = (range?: MarketSeriesRange): number | null => {
  if (!range) return null
  const value = Number(range.value)
  if (!Number.isFinite(value) || value <= 0) return null
  if (range.unit === 'day') return value * DAY_MS
  if (range.unit === 'week') return value * 7 * DAY_MS
  if (range.unit === 'month') return value * 30 * DAY_MS
  if (range.unit === 'year') return value * 365 * DAY_MS
  return null
}

export const normalizeSeriesWindow = (
  window: MarketSeriesWindow | undefined,
  allowedModes: MarketSeriesWindowMode[]
): MarketSeriesWindow | null => {
  if (!window) return null
  if (!allowedModes.includes(window.mode)) return null

  if (window.mode === 'range') {
    const rangeMs = rangeToMs(window.range)
    return rangeMs && rangeMs > 0 ? window : null
  }

  if (window.mode === 'bars') {
    const barCount = Number(window.barCount)
    return Number.isFinite(barCount) && barCount > 0
      ? { mode: 'bars', barCount: Math.floor(barCount) }
      : null
  }

  const start = parseDateInput(window.start)
  if (!start) return null
  const end = window.end ? parseDateInput(window.end) : null

  return {
    mode: 'absolute',
    start: start.toISOString(),
    end: end ? end.toISOString() : undefined,
  }
}

export const normalizeSeriesWindows = (
  windows: Array<MarketSeriesWindow | undefined>,
  allowedModes: MarketSeriesWindowMode[]
): MarketSeriesWindow[] => {
  const normalized: MarketSeriesWindow[] = []

  windows.forEach((window) => {
    const next = normalizeSeriesWindow(window, allowedModes)
    if (next) normalized.push(next)
  })

  return normalized
}

export const seriesWindowKey = (windows: MarketSeriesWindow[]): string => {
  return windows.length ? JSON.stringify(windows) : 'none'
}

export const areSeriesWindowsEqual = (
  a?: MarketSeriesWindow | null,
  b?: MarketSeriesWindow | null
): boolean => {
  if (!a || !b) return false
  if (a.mode !== b.mode) return false
  if (a.mode === 'range' && b.mode === 'range') {
    return a.range.value === b.range.value && a.range.unit === b.range.unit
  }
  if (a.mode === 'bars' && b.mode === 'bars') {
    return a.barCount === b.barCount
  }
  if (a.mode === 'absolute' && b.mode === 'absolute') {
    return a.start === b.start && a.end === b.end
  }
  return false
}
