/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest'
import { buildPeriod } from '@/providers/market/ibkr/series'

const DAY = 86_400_000

// The end is fixed so these assertions are about arithmetic, not about "now".
const end = Date.UTC(2026, 8, 12)
const startOf = (days: number) => end - days * DAY

describe('buildPeriod', () => {
  it('never asks for a period longer than the bar size supports', () => {
    // 365 days is the limit for daily bars. The month rounding used to emit
    // `13m` - roughly 395 days - which is past the very cap it was clamped to.
    expect(buildPeriod(startOf(365), end, '1d')).toBe('365d')
  })

  it('does not round a window up past what the caller asked for', () => {
    // The old month conversion turned these into `2m` (60 days) and `4m`
    // (120 days), silently requesting data outside the requested range.
    expect(buildPeriod(startOf(45), end, '1d')).toBe('45d')
    expect(buildPeriod(startOf(100), end, '1d')).toBe('100d')
  })

  it('clamps a window longer than the bar size allows', () => {
    // 500 days of daily bars is not expressible; the clamp is the point.
    expect(buildPeriod(startOf(500), end, '1d')).toBe('365d')
  })

  it('uses whole years past the period grammar day ceiling', () => {
    // 1095 days of weekly bars is within the bar's limit, but the grammar's day
    // form stops at 1000, so this has to come out as years.
    expect(buildPeriod(startOf(1095), end, '1w')).toBe('3y')
  })

  it('never exceeds the 15y ceiling of the period grammar', () => {
    // A `1m` (one month) bar allows a 15-year lookback: more cannot be asked for
    // in a single request, so the cap must match the grammar, not the bar.
    expect(buildPeriod(startOf(365 * 20), end, '1m')).toBe('15y')
  })

  it('never asks for a zero or fractional period', () => {
    // A sub-day window is still a one-day request, never `0d`.
    expect(buildPeriod(end - 60_000, end, '1d')).toBe('1d')
    expect(buildPeriod(end, end, '1d')).toBe('1d')
  })
})
