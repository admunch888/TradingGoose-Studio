import { describe, expect, it } from 'vitest'
import {
  CHART_RANGE_INTERACTION_WINDOW_MS,
  isInternalIndicatorPlotTitle,
  shouldPersistVisibleRange,
} from '@/widgets/widgets/data_chart/utils/chart-interaction'

describe('shouldPersistVisibleRange', () => {
  const nowMs = 1_000_000

  it('saves a range the user just moved', () => {
    expect(shouldPersistVisibleRange({ lastInteractionAtMs: nowMs - 100, nowMs })).toBe(true)
    expect(
      shouldPersistVisibleRange({
        lastInteractionAtMs: nowMs - CHART_RANGE_INTERACTION_WINDOW_MS,
        nowMs,
      })
    ).toBe(true)
  })

  it('ignores the shift a streamed quote causes', () => {
    // No pan, zoom or scroll: the live candle moved the range on its own.
    expect(shouldPersistVisibleRange({ lastInteractionAtMs: null, nowMs })).toBe(false)
    expect(
      shouldPersistVisibleRange({
        lastInteractionAtMs: nowMs - CHART_RANGE_INTERACTION_WINDOW_MS - 1,
        nowMs,
      })
    ).toBe(false)
  })
})

describe('isInternalIndicatorPlotTitle', () => {
  it('spots the PineTS drawing collections shown as `__labels__: --`', () => {
    for (const title of ['__labels__', '__lines__', '__boxes__', '__linefills__', '__tables__']) {
      expect(isInternalIndicatorPlotTitle(title)).toBe(true)
    }
    expect(isInternalIndicatorPlotTitle('  __polylines__  ')).toBe(true)
  })

  it('keeps real plot titles', () => {
    for (const title of ['Short MA', 'CCI Turbo', 'ATR', 'MA_9', '']) {
      expect(isInternalIndicatorPlotTitle(title)).toBe(false)
    }
    expect(isInternalIndicatorPlotTitle(undefined)).toBe(false)
  })
})
