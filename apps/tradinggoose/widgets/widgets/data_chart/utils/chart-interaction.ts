/**
 * How long after a pan, zoom or scroll the chart still counts as user-driven.
 *
 * The visible range is saved into the widget params, and every save re-renders
 * the widget - which unmounts the header, closing an open dropdown. A streamed
 * quote updates the last candle several times a second and shifts the range on
 * its own, so saving those shifts made the Indicators dropdown close the moment
 * it opened. Only a range the user moved is worth persisting.
 */
export const CHART_RANGE_INTERACTION_WINDOW_MS = 2_000

/** Whether a visible-range change came from the user rather than a live update. */
export function shouldPersistVisibleRange(params: {
  lastInteractionAtMs: number | null
  nowMs: number
  windowMs?: number
}): boolean {
  const { lastInteractionAtMs, nowMs } = params
  if (lastInteractionAtMs === null) return false
  const windowMs = params.windowMs ?? CHART_RANGE_INTERACTION_WINDOW_MS
  return nowMs - lastInteractionAtMs <= windowMs
}

/**
 * Plot titles PineTS emits for its drawing collections (labels, lines, boxes,
 * linefills, polylines, tables). They carry no value, so the legend printed
 * `__labels__: --` next to every real plot.
 */
export function isInternalIndicatorPlotTitle(title: string | null | undefined): boolean {
  if (!title) return false
  return /^__.+__$/.test(title.trim())
}
