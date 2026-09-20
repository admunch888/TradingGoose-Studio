/**
 * The CME Globex shape is the reason this module exists.
 *
 * A future prints bars from Sunday 18:00 ET to Friday 17:00 ET with an hour off
 * each weekday afternoon. Inferring that from the bars gives "trades weekends,
 * open 00:00-23:45", which puts forecast bars on Saturday and inside the break.
 * The session windows the market series already carries say it exactly.
 */
import { describe, expect, it } from 'vitest'
import {
  buildWeeklyTradingSchedule,
  createLocalTimeReader,
  isWithinWeeklySchedule,
  readSessionWindows,
  type SessionWindow,
} from '@/lib/kronos/trading-calendar'

const NEW_YORK = 'America/New_York'
const readNewYork = createLocalTimeReader(NEW_YORK)

const MINUTE_MS = 60_000
const at = (iso: string) => Date.parse(iso)

/** Sun 18:00 ET -> Mon 17:00 ET, then one per weekday. 2026-01-04 is a Sunday. */
const globexWindows = (): SessionWindow[] => [
  { start: '2026-01-04T23:00:00.000Z', end: '2026-01-05T22:00:00.000Z' },
  { start: '2026-01-05T23:00:00.000Z', end: '2026-01-06T22:00:00.000Z' },
  { start: '2026-01-06T23:00:00.000Z', end: '2026-01-07T22:00:00.000Z' },
  { start: '2026-01-07T23:00:00.000Z', end: '2026-01-08T22:00:00.000Z' },
  { start: '2026-01-08T23:00:00.000Z', end: '2026-01-09T22:00:00.000Z' },
]

/** One bar every 15 minutes across every window, which is what the history holds. */
const barsCovering = (windows: SessionWindow[]): number[] => {
  const bars: number[] = []
  for (const window of windows) {
    for (let ms = at(window.start); ms < at(window.end); ms += 15 * MINUTE_MS) bars.push(ms)
  }
  return bars
}

const equityWindows = (): SessionWindow[] => [
  { start: '2026-01-08T14:30:00.000Z', end: '2026-01-08T21:00:00.000Z' },
  { start: '2026-01-09T14:30:00.000Z', end: '2026-01-09T21:00:00.000Z' },
]

describe('readSessionWindows', () => {
  it('reads the windows a market series carries', () => {
    expect(readSessionWindows({ marketSessions: equityWindows() })).toHaveLength(2)
  })

  it.each([
    ['no series', undefined],
    ['no sessions', {}],
    ['sessions that are not an array', { marketSessions: 'nope' }],
    ['a window with no timestamps', { marketSessions: [{ date: '2026-01-08' }] }],
  ])('returns nothing for %s', (_label, series) => {
    expect(readSessionWindows(series)).toEqual([])
  })
})

describe('a CME Globex week', () => {
  const schedule = buildWeeklyTradingSchedule(
    globexWindows(),
    barsCovering(globexWindows()),
    readNewYork
  )

  const open = (iso: string) => {
    if (!schedule) throw new Error('expected a schedule')
    return isWithinWeeklySchedule(schedule, readNewYork(at(iso)))
  }

  it('is closed all day Saturday', () => {
    // The bug this replaces: Sunday-evening bars read as "trades weekends", which
    // made every Saturday minute tradable.
    expect(open('2026-01-10T15:00:00.000Z')).toBe(false) // Sat 10:00 ET
    expect(open('2026-01-10T05:00:00.000Z')).toBe(false) // Sat 00:00 ET
  })

  it('is closed on Sunday until the 18:00 open', () => {
    expect(open('2026-01-11T20:00:00.000Z')).toBe(false) // Sun 15:00 ET
    expect(open('2026-01-11T22:59:00.000Z')).toBe(false) // Sun 17:59 ET
    expect(open('2026-01-11T23:00:00.000Z')).toBe(true) // Sun 18:00 ET
  })

  it('is closed through the 17:00-18:00 weekday break', () => {
    // The other half of the bug: a session read as 00:00-23:45 swallowed the break.
    expect(open('2026-01-13T21:45:00.000Z')).toBe(true) // Tue 16:45 ET
    expect(open('2026-01-13T22:00:00.000Z')).toBe(false) // Tue 17:00 ET
    expect(open('2026-01-13T22:45:00.000Z')).toBe(false) // Tue 17:45 ET
    expect(open('2026-01-13T23:00:00.000Z')).toBe(true) // Tue 18:00 ET
  })

  it('trades through weekday midnight', () => {
    expect(open('2026-01-14T05:00:00.000Z')).toBe(true) // Wed 00:00 ET
    expect(open('2026-01-14T09:30:00.000Z')).toBe(true) // Wed 04:30 ET
  })

  it('closes for the week at Friday 17:00', () => {
    expect(open('2026-01-16T21:45:00.000Z')).toBe(true) // Fri 16:45 ET
    expect(open('2026-01-16T22:00:00.000Z')).toBe(false) // Fri 17:00 ET
  })
})

describe('a history that stops mid-week', () => {
  it('still knows the rest of the week trades', () => {
    // The history ends Tuesday afternoon, so no bar has printed in Tuesday's
    // evening session or on Wednesday at all. Judging coverage window by window
    // reads that as "the market closes on Tuesday" and sends the next forecast
    // bar to Sunday. Coverage is a time of day, not a date.
    const lastBar = at('2026-01-06T21:45:00.000Z') // Tue 16:45 ET
    const schedule = buildWeeklyTradingSchedule(
      globexWindows(),
      barsCovering(globexWindows()).filter((ms) => ms <= lastBar),
      readNewYork
    )
    if (!schedule) throw new Error('expected a schedule')

    expect(isWithinWeeklySchedule(schedule, readNewYork(at('2026-01-06T23:00:00.000Z')))).toBe(true) // Tue 18:00 ET
    expect(isWithinWeeklySchedule(schedule, readNewYork(at('2026-01-07T15:00:00.000Z')))).toBe(true) // Wed 10:00 ET
    expect(isWithinWeeklySchedule(schedule, readNewYork(at('2026-01-10T15:00:00.000Z')))).toBe(
      false
    ) // Sat
  })
})

describe('a regular-hours equity session', () => {
  const schedule = buildWeeklyTradingSchedule(
    equityWindows(),
    barsCovering(equityWindows()),
    readNewYork
  )

  const open = (iso: string) => {
    if (!schedule) throw new Error('expected a schedule')
    return isWithinWeeklySchedule(schedule, readNewYork(at(iso)))
  }

  it('opens at 09:30 and takes its last bar before 16:00', () => {
    expect(open('2026-01-15T14:25:00.000Z')).toBe(false) // Thu 09:25 ET
    expect(open('2026-01-15T14:30:00.000Z')).toBe(true) // Thu 09:30 ET
    expect(open('2026-01-15T20:55:00.000Z')).toBe(true) // Thu 15:55 ET
    // 16:00 is the close, not a bar: a bar is stamped at its open.
    expect(open('2026-01-15T21:00:00.000Z')).toBe(false) // Thu 16:00 ET
  })

  it('is closed on a weekday the windows never covered', () => {
    expect(open('2026-01-12T15:00:00.000Z')).toBe(false) // Mon 10:00 ET
  })
})

describe('windows the history never reached', () => {
  it('are left out, so a forecast cannot land where no bar printed', () => {
    // A provider may list pre-market alongside the regular session on a
    // regular-hours fetch. Only the window with bars in it counts.
    const preMarket = { start: '2026-01-08T09:00:00.000Z', end: '2026-01-08T14:30:00.000Z' }
    const schedule = buildWeeklyTradingSchedule(
      [preMarket, ...equityWindows()],
      barsCovering(equityWindows()),
      readNewYork
    )
    if (!schedule) throw new Error('expected a schedule')

    expect(isWithinWeeklySchedule(schedule, readNewYork(at('2026-01-15T13:00:00.000Z')))).toBe(
      false
    )
    expect(isWithinWeeklySchedule(schedule, readNewYork(at('2026-01-15T15:00:00.000Z')))).toBe(true)
  })

  it('leave no schedule at all when that is every window', () => {
    // Nothing usable here, so the caller falls back to inferring from the bars.
    expect(buildWeeklyTradingSchedule(equityWindows(), [], readNewYork)).toBeNull()
  })
})

describe('malformed windows', () => {
  it.each([
    ['an unparseable timestamp', { start: 'not-a-date', end: '2026-01-08T21:00:00.000Z' }],
    [
      'an end before its start',
      { start: '2026-01-08T21:00:00.000Z', end: '2026-01-08T14:30:00.000Z' },
    ],
    [
      'a zero-length window',
      { start: '2026-01-08T14:30:00.000Z', end: '2026-01-08T14:30:00.000Z' },
    ],
  ])('drops %s', (_label, window) => {
    const schedule = buildWeeklyTradingSchedule(
      [window as SessionWindow, ...equityWindows()],
      barsCovering(equityWindows()),
      readNewYork
    )
    if (!schedule) throw new Error('expected a schedule')

    // Thursday and Friday only - the bad window contributed nothing.
    expect([...schedule.keys()].sort()).toEqual([4, 5])
  })
})
