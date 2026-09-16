/**
 * A backtest run is hours long, so the cheap failures are the expensive ones: a
 * padded bar scored as if it happened, a duplicate timestamp that makes the
 * service reject every window, or a crash that loses finished work.
 */
import { describe, expect, it } from 'vitest'
import {
  type Bar,
  barsFromYahooChart,
  buildWindowRequest,
  formatProgress,
  normaliseBars,
  observationFrom,
  parseRunRecords,
} from '@/lib/kronos/backtest-driver'

const yahooChart = (
  overrides: Record<string, unknown[]> = {},
  stamps = [1757000000, 1757000900]
) => ({
  chart: {
    result: [
      {
        timestamp: stamps,
        indicators: {
          quote: [
            {
              open: [100, 101],
              high: [102, 103],
              low: [99, 100],
              close: [101, 102],
              volume: [1000, 1100],
              ...overrides,
            },
          ],
        },
      },
    ],
  },
})

const bar = (timestamp: string, close = 100): Bar => ({
  timestamp,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
})

describe('reading Yahoo bars', () => {
  it('maps a chart response into bars', () => {
    const bars = barsFromYahooChart(yahooChart())

    expect(bars).toHaveLength(2)
    expect(bars[0]).toMatchObject({ open: 100, high: 102, low: 99, close: 101, volume: 1000 })
    expect(bars[0].timestamp).toBe(new Date(1757000000 * 1000).toISOString())
  })

  it.each([
    ['close', { close: [101, null] }],
    ['open', { open: [100, null] }],
    ['high', { high: [102, null] }],
    ['low', { low: [99, null] }],
  ])('drops a bar padded with null %s rather than inventing one', (_field, overrides) => {
    // Yahoo pads gaps with nulls. A filled-in bar would be scored as if the
    // market had traded there.
    expect(barsFromYahooChart(yahooChart(overrides))).toHaveLength(1)
  })

  it('keeps a bar with no volume, since only prices are scored', () => {
    const bars = barsFromYahooChart(yahooChart({ volume: [1000, null] }))

    expect(bars).toHaveLength(2)
    expect(bars[1].volume).toBeUndefined()
  })

  it.each([
    ['an empty object', {}],
    ['no result', { chart: { result: [] } }],
    ['no quote', { chart: { result: [{ timestamp: [1] }] } }],
  ])('returns nothing for %s', (_label, payload) => {
    expect(barsFromYahooChart(payload)).toEqual([])
  })
})

describe('normalising bars', () => {
  it('drops duplicate timestamps, which the service rejects the whole request for', () => {
    const bars = normaliseBars([bar('2026-01-02T14:30:00.000Z'), bar('2026-01-02T14:30:00.000Z')])

    expect(bars).toHaveLength(1)
  })

  it('puts bars in order, whatever order they arrived in', () => {
    const bars = normaliseBars([bar('2026-01-02T15:00:00.000Z'), bar('2026-01-02T14:30:00.000Z')])

    expect(bars.map((b) => b.timestamp)).toEqual([
      '2026-01-02T14:30:00.000Z',
      '2026-01-02T15:00:00.000Z',
    ])
  })

  it('drops a non-positive price, which the schema refuses', () => {
    expect(normaliseBars([{ ...bar('2026-01-02T14:30:00.000Z'), close: 0 }])).toEqual([])
  })

  it('drops an unparseable timestamp', () => {
    expect(normaliseBars([bar('not-a-date')])).toEqual([])
  })
})

describe('building a window request', () => {
  const window = {
    context: [bar('2026-01-02T14:30:00.000Z', 100), bar('2026-01-02T14:45:00.000Z', 101)],
    realized: [bar('2026-01-02T15:00:00.000Z', 102), bar('2026-01-02T15:15:00.000Z', 103)],
    originIndex: 7,
  }
  const request = buildWindowRequest(window, {
    listingId: 'MES=F',
    interval: '15m',
    timezone: 'America/New_York',
    temperature: 1,
    topP: 0.9,
    sampleCount: 1,
  })

  it('asks about exactly the bars it will be scored against', () => {
    // Using the realized bars' own timestamps keeps calendar inference out of
    // the backtest: history already says where the next bars fall.
    expect(request.futureTimestamps).toEqual([
      '2026-01-02T15:00:00.000Z',
      '2026-01-02T15:15:00.000Z',
    ])
  })

  it('sends only the context as history', () => {
    expect(request.history).toHaveLength(2)
    expect(request.history.at(-1)?.timestamp).toBe('2026-01-02T14:45:00.000Z')
  })

  it('identifies the window, so a resumed run can skip it', () => {
    expect(request.requestId).toContain('7')
  })
})

describe('turning a forecast into an observation', () => {
  it('measures direction from the last bar the model saw', () => {
    const window = {
      context: [bar('2026-01-02T14:30:00.000Z', 100), bar('2026-01-02T14:45:00.000Z', 101)],
      realized: [bar('2026-01-02T15:00:00.000Z', 105)],
    }

    const observation = observationFrom(window, [{ close: 104 }])

    expect(observation.lastClose).toBe(101)
    expect(observation.predictedCloses).toEqual([104])
    expect(observation.realizedCloses).toEqual([105])
  })
})

describe('resuming an interrupted run', () => {
  const line = (originIndex: number) =>
    JSON.stringify({ originIndex, lastBar: 'x', predictedCloses: [1], realizedCloses: [1] })

  it('reads back the windows already finished', () => {
    const records = parseRunRecords([line(0), line(4), line(8)].join('\n'))

    expect([...records.keys()]).toEqual([0, 4, 8])
  })

  it('survives the half-written last line an interrupted run leaves', () => {
    const records = parseRunRecords(`${line(0)}\n{"originIndex":4,"predicted`)

    expect([...records.keys()]).toEqual([0])
  })

  it('ignores a record with no forecast in it', () => {
    expect(parseRunRecords('{"originIndex":1}').size).toBe(0)
  })

  it('reads an empty file as nothing done', () => {
    expect(parseRunRecords('').size).toBe(0)
  })
})

describe('progress', () => {
  it('estimates what is left from the rate so far', () => {
    // 20 of 30 in 10 minutes: 30s each, 10 windows left -> 5 minutes.
    const progress = formatProgress(20, 30, 600_000)

    expect(progress).toContain('67%')
    expect(progress).toContain('30.0s each')
    expect(progress).toContain('5m left')
  })

  it('switches to hours once the wait is long', () => {
    // 10 of 100 in 10 minutes is 90 minutes left, which reads better as hours.
    expect(formatProgress(10, 100, 600_000)).toContain('1.5h left')
  })

  it('does not divide by zero before the first window', () => {
    expect(formatProgress(0, 100, 0)).toBe('0/100 (0%)')
  })
})
