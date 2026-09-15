/**
 * When a forecast bar is allowed to land.
 *
 * Kronos encodes each target's minute, hour, weekday and date, so a forecast
 * timestamp has to fall where a bar could actually print. Working that out from
 * the history alone cannot see an intraday break: a CME future prints bars from
 * Sunday 18:00 ET to Friday 17:00 ET with an hour off each afternoon, and a
 * history-derived "first and last bar time" reads that as open all day, every
 * day including Saturday.
 *
 * The market series already carries the answer. `marketSessions` comes from the
 * market-hours API (providers/market/market-hours), one window per date, holiday
 * aware, for every provider. This turns those windows into a recurring weekly
 * schedule so the same rule also covers the days just past the end of the
 * history, which is where a forecast usually lands.
 */

const MINUTES_PER_DAY = 1440
const MINUTE_MS = 60_000

/** No real session window spans more than a few days; this only stops a bad one looping. */
const MAX_WINDOW_DAYS = 10

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

export interface LocalTime {
  weekday: number
  dateKey: string
  minuteOfDay: number
}

export type ReadLocalTime = (instant: number) => LocalTime

/** Reads an instant's wall-clock weekday, date and minute in the listing's timezone. */
export const createLocalTimeReader = (timezone: string): ReadLocalTime => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (instant) => {
    const parts: Record<string, string> = {}
    for (const part of formatter.formatToParts(new Date(instant))) {
      parts[part.type] = part.value
    }
    return {
      weekday: WEEKDAY_INDEX[parts.weekday],
      dateKey: `${parts.year}-${parts.month}-${parts.day}`,
      minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
    }
  }
}

/** One `MarketSessionWindow`, narrowed to what the schedule needs. */
export interface SessionWindow {
  start: string
  end: string
}

/** Half-open `[start, end)` minute-of-day ranges, keyed by weekday (0 = Sunday). */
export type WeeklyTradingSchedule = ReadonlyMap<
  number,
  ReadonlyArray<Readonly<{ start: number; end: number }>>
>

/** Pulls the session windows off a market series, ignoring anything malformed. */
export const readSessionWindows = (marketSeries: unknown): SessionWindow[] => {
  const sessions = (marketSeries as { marketSessions?: unknown } | null | undefined)?.marketSessions
  if (!Array.isArray(sessions)) return []

  return sessions.flatMap((session) => {
    if (!session || typeof session !== 'object') return []
    const { start, end } = session as { start?: unknown; end?: unknown }
    if (typeof start !== 'string' || typeof end !== 'string') return []
    return [{ start, end }]
  })
}

/**
 * Cut a window at each local midnight, so a session that runs overnight (Globex
 * opens at 18:00 and closes at 17:00 the next day) contributes to both weekdays.
 *
 * The step to midnight is computed in local minutes, so on the two days a year a
 * DST shift moves midnight, a market trading through it can be off by the hour of
 * the shift. Exchange holidays and half days are not modelled either - both are
 * limits of projecting a week forward, not of the windows themselves.
 */
const splitWindowByLocalDay = (
  startMs: number,
  endMs: number,
  readLocalTime: ReadLocalTime
): Array<{ weekday: number; start: number; end: number }> => {
  const parts: Array<{ weekday: number; start: number; end: number }> = []
  let cursor = startMs

  for (let guard = 0; cursor < endMs && guard < MAX_WINDOW_DAYS; guard++) {
    const local = readLocalTime(cursor)
    const chunkEndMs = Math.min(endMs, cursor + (MINUTES_PER_DAY - local.minuteOfDay) * MINUTE_MS)
    const spanMinutes = Math.round((chunkEndMs - cursor) / MINUTE_MS)
    if (spanMinutes <= 0) break

    parts.push({
      weekday: local.weekday,
      start: local.minuteOfDay,
      end: Math.min(MINUTES_PER_DAY, local.minuteOfDay + spanMinutes),
    })
    cursor = chunkEndMs
  }

  return parts
}

const mergeRanges = (
  ranges: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> => {
  const merged: Array<{ start: number; end: number }> = []
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1]
    // `<=` joins ranges that only touch, so a day split at midnight comes back
    // whole while a real break keeps its gap.
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end)
      continue
    }
    merged.push({ ...range })
  }
  return merged
}

/**
 * Build the weekly schedule from the series' own session windows.
 *
 * A range is kept only when the history prints bars at that time of day - on any
 * day, not that same weekday. A provider may list pre-market alongside the
 * regular session on a regular-hours fetch, and admitting forecast bars into a
 * window that never printed one would put them where the model has seen nothing.
 * Judging by time of day rather than by the dated window matters: the history
 * stops somewhere mid-week, so the last weekday in it has no evening bars yet,
 * and per-window pruning would read that as an evening the market is shut.
 *
 * Ranges are pruned before they are merged, because a pre-market window ends
 * exactly where the regular session begins and merging first would fuse them.
 *
 * Returns null when the series carries no usable windows, which is the signal to
 * fall back to inferring the calendar from the bars.
 */
export const buildWeeklyTradingSchedule = (
  sessions: readonly SessionWindow[],
  historyMs: readonly number[],
  readLocalTime: ReadLocalTime
): WeeklyTradingSchedule | null => {
  const windows = sessions
    .map((session) => ({ startMs: Date.parse(session.start), endMs: Date.parse(session.end) }))
    .filter(
      (window) =>
        Number.isFinite(window.startMs) &&
        Number.isFinite(window.endMs) &&
        window.endMs > window.startMs
    )
  if (windows.length === 0) return null

  const byWeekday = new Map<number, Array<{ start: number; end: number }>>()
  for (const window of windows) {
    for (const part of splitWindowByLocalDay(window.startMs, window.endMs, readLocalTime)) {
      const ranges = byWeekday.get(part.weekday)
      if (ranges) {
        ranges.push({ start: part.start, end: part.end })
        continue
      }
      byWeekday.set(part.weekday, [{ start: part.start, end: part.end }])
    }
  }

  const barMinutes = historyMs.map((instant) => readLocalTime(instant).minuteOfDay)
  const hasBars = (range: { start: number; end: number }) =>
    barMinutes.some((minute) => minute >= range.start && minute < range.end)

  const schedule = new Map<number, Array<{ start: number; end: number }>>()
  for (const [weekday, ranges] of byWeekday) {
    const covered = ranges.filter(hasBars)
    if (covered.length > 0) schedule.set(weekday, mergeRanges(covered))
  }
  return schedule.size > 0 ? schedule : null
}

/**
 * A bar opening at this local time falls inside a session.
 *
 * The end is exclusive because bars are stamped at their open: the last 5-minute
 * bar of a 09:30-16:00 session opens at 15:55, and 16:00 is the close, not a bar.
 */
export const isWithinWeeklySchedule = (
  schedule: WeeklyTradingSchedule,
  time: Pick<LocalTime, 'weekday' | 'minuteOfDay'>
): boolean => {
  const ranges = schedule.get(time.weekday)
  if (!ranges) return false
  return ranges.some((range) => time.minuteOfDay >= range.start && time.minuteOfDay < range.end)
}
