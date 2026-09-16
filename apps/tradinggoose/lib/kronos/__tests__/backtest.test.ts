/**
 * These pin the arithmetic that decides whether the rest of the trading system
 * is worth building. The failure mode being guarded against is not a crash - it
 * is a number that looks like evidence and is not: a hit rate read off a sample
 * too small to resolve it, or one inflated by a forecast that was scored against
 * bars it had already seen.
 */
import { describe, expect, it } from 'vitest'
import {
  type ForecastObservation,
  type ForecastScore,
  scoreForecast,
  sliceBacktestWindows,
  summariseForecastScores,
  wilsonInterval,
} from '@/lib/kronos/backtest'

const observation = (overrides: Partial<ForecastObservation> = {}): ForecastObservation => ({
  lastClose: 6000,
  predictedCloses: [6010, 6020, 6030],
  realizedCloses: [6005, 6015, 6025],
  ...overrides,
})

const scores = (specs: Array<Partial<ForecastObservation>>): ForecastScore[] =>
  specs
    .map((spec) => scoreForecast(observation(spec)))
    .filter((score): score is ForecastScore => score !== null)

describe('scoring one forecast', () => {
  it('is a hit when the predicted and realized directions agree', () => {
    const score = scoreForecast(observation())

    expect(score?.predicted).toBe('up')
    expect(score?.realized).toBe('up')
    expect(score?.directionHit).toBe(true)
  })

  it('is a miss when the market went the other way', () => {
    const score = scoreForecast(observation({ realizedCloses: [5995, 5990, 5980] }))

    expect(score?.realized).toBe('down')
    expect(score?.directionHit).toBe(false)
  })

  it('scores the terminal bar, not the path to it', () => {
    // A forecast that dips and recovers is still an up forecast: the signal acts
    // on where the path ends.
    const score = scoreForecast(observation({ predictedCloses: [5900, 5850, 6030] }))

    expect(score?.predicted).toBe('up')
    expect(score?.directionHit).toBe(true)
  })

  it('measures error against the terminal bar', () => {
    const score = scoreForecast(observation())

    expect(score?.absoluteError).toBeCloseTo(5, 6)
    expect(score?.percentError).toBeCloseTo((5 / 6000) * 100, 6)
  })

  it.each([
    ['the forecast is flat', { predictedCloses: [6000, 6000, 6000] }],
    ['the market was flat', { realizedCloses: [6005, 6015, 6000] }],
  ])('does not count a direction when %s', (_label, overrides) => {
    // No position would have been taken, so counting it either way would move
    // the hit rate on a trade that never happened.
    expect(scoreForecast(observation(overrides))?.directionHit).toBeNull()
  })
})

describe('a forecast whose bars have not all closed', () => {
  it('is not scored on the bars that happen to exist', () => {
    // Scoring it would measure a 2-bar forecast the model never made.
    expect(scoreForecast(observation({ realizedCloses: [6005, 6015] }))).toBeNull()
  })

  it.each([
    ['no forecast', { predictedCloses: [] }],
    ['a nonsense last close', { lastClose: 0 }],
  ])('is rejected for %s', (_label, overrides) => {
    expect(scoreForecast(observation(overrides))).toBeNull()
  })
})

describe('band coverage', () => {
  it('is the only check that the ensemble bands mean anything', () => {
    const inside = scoreForecast(observation({ terminalBand: { low: 6000, high: 6050 } }))
    const outside = scoreForecast(observation({ terminalBand: { low: 6040, high: 6060 } }))

    expect(inside?.withinBand).toBe(true)
    expect(outside?.withinBand).toBe(false)
  })

  it('is absent, not false, when the forecast carried no band', () => {
    expect(scoreForecast(observation())?.withinBand).toBeNull()
    expect(summariseForecastScores(scores([{}])).bandCoverage).toBeNull()
  })
})

describe('the confidence interval', () => {
  it('stays inside 0..1 where the textbook interval does not', () => {
    // 10 of 10 gives p=1 and a Wald half-width of 0, claiming certainty.
    const interval = wilsonInterval(10, 10)

    expect(interval.high).toBeLessThanOrEqual(1)
    expect(interval.low).toBeLessThan(1)
    expect(interval.low).toBeGreaterThan(0.6)
  })

  it('is wide on a small sample and narrow on a large one', () => {
    const small = wilsonInterval(6, 10)
    const large = wilsonInterval(600, 1000)

    expect(small.high - small.low).toBeGreaterThan(large.high - large.low)
  })

  it('returns nothing rather than NaN with no observations', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 0 })
  })
})

describe('summarising a run', () => {
  const up = { predictedCloses: [6030], realizedCloses: [6025] }
  const down = { predictedCloses: [6030], realizedCloses: [5975] }

  it('reports the hit rate over the forecasts that took a direction', () => {
    const summary = summariseForecastScores(
      scores([up, up, up, down, { predictedCloses: [6000], realizedCloses: [6010] }])
    )

    // The flat forecast is excluded from the denominator, not counted as a miss.
    expect(summary.scored).toBe(5)
    expect(summary.directional.evaluated).toBe(4)
    expect(summary.directional.hitRate).toBeCloseTo(0.75, 6)
  })

  it('does not call a small sample above a half a real edge', () => {
    // 6 of 10 is 60%, and means nothing. This is the number that would otherwise
    // get read as a green light.
    const summary = summariseForecastScores(scores([...Array(6).fill(up), ...Array(4).fill(down)]))

    expect(summary.directional.hitRate).toBeCloseTo(0.6, 6)
    expect(summary.directional.beatsChance).toBe(false)
    expect(summary.directional.confidenceInterval95.low).toBeLessThan(0.5)
  })

  it('calls a large sample above a half a real edge', () => {
    const summary = summariseForecastScores(
      scores([...Array(360).fill(up), ...Array(240).fill(down)])
    )

    expect(summary.directional.hitRate).toBeCloseTo(0.6, 6)
    expect(summary.directional.beatsChance).toBe(true)
  })

  it('breaks the hit rate down by regime', () => {
    const summary = summariseForecastScores(
      scores([
        { ...up, regime: 'calm' },
        { ...up, regime: 'calm' },
        { ...down, regime: 'stressed' },
      ])
    )

    expect(summary.byRegime.calm.hitRate).toBe(1)
    expect(summary.byRegime.stressed.hitRate).toBe(0)
  })
})

describe('slicing a series into windows', () => {
  const bars = Array.from({ length: 20 }, (_, index) => index)

  it('never lets a forecast see a bar it is scored against', () => {
    // The whole point. Lookahead is an off-by-one, and it flatters a model
    // silently.
    for (const window of sliceBacktestWindows(bars, { contextBars: 5, horizonBars: 3 })) {
      const overlap = window.context.filter((bar) => window.realized.includes(bar))
      expect(overlap).toEqual([])
      expect(Math.max(...window.context)).toBeLessThan(Math.min(...window.realized))
    }
  })

  it('starts only once there is a full context behind it', () => {
    const [first] = [...sliceBacktestWindows(bars, { contextBars: 5, horizonBars: 3 })]

    expect(first.context).toEqual([0, 1, 2, 3, 4])
    expect(first.realized).toEqual([5, 6, 7])
    expect(first.originIndex).toBe(4)
  })

  it('stops before a window whose horizon has not closed', () => {
    const windows = [...sliceBacktestWindows(bars, { contextBars: 5, horizonBars: 3 })]
    const last = windows[windows.length - 1]

    expect(windows).toHaveLength(13)
    expect(last.realized).toEqual([17, 18, 19])
  })

  it('steps to trade resolution for wall-clock', () => {
    // On CPU each window is a forecast of tens of seconds, so this is the knob
    // that turns a ten-hour run into under three.
    const windows = [...sliceBacktestWindows(bars, { contextBars: 5, horizonBars: 3, step: 4 })]

    expect(windows.map((window) => window.originIndex)).toEqual([4, 8, 12, 16])
  })

  it.each([
    ['too short a series', { contextBars: 25, horizonBars: 3 }],
    ['a zero horizon', { contextBars: 5, horizonBars: 0 }],
    ['a zero step', { contextBars: 5, horizonBars: 3, step: 0 }],
  ])('yields nothing for %s', (_label, options) => {
    expect([...sliceBacktestWindows(bars, options)]).toEqual([])
  })
})
