import { describe, expect, it } from 'vitest'
import { buildCompactPriceFormatter } from '@/widgets/widgets/data_chart/hooks/use-chart-styles'

describe('buildCompactPriceFormatter', () => {
  const format = buildCompactPriceFormatter(2, 'en-US')

  it('writes prices below a million in full', () => {
    expect(format(7694.75)).toBe('7694.75')
    expect(format(7710)).toBe('7710')
    expect(format(123_456.5)).toBe('123456.5')
    expect(format(-2_450.25)).toBe('-2450.25')
    expect(format(0.25)).toBe('0.25')
  })

  it('abbreviates values from a million up', () => {
    expect(format(1_250_000)).toBe('1.25M')
    expect(format(-3_000_000_000)).toBe('-3B')
    expect(format(2_000_000_000_000)).toBe('2T')
  })

  it('writes nothing for a value that is not a number', () => {
    expect(format(Number.NaN)).toBe('')
  })
})
