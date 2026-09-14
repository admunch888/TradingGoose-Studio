/**
 * Shape of the local Copilot's working-history rows in `copilot_review_items`.
 *
 * The model's working history (the user's requests, its tool calls and results,
 * its replies) is stored beside the visible transcript in the same table. This
 * module has no database access, so the history routes that replace the
 * transcript can tell those rows apart and keep them.
 */
export const LOCAL_WORKING_PREFIX = '[[local-working]]'
export const TOOL_RESULT_ITEM_PREFIX = 'local_tool_result_'
export const LOCAL_USER_ITEM_PREFIX = 'local_user_'
export const LOCAL_ASSISTANT_ITEM_PREFIX = 'local_working_assistant_'

/**
 * Working rows are numbered from here, above any transcript sequence (those
 * count items from 0). Sharing one counter let a transcript write and a working
 * write claim the same sequence, and `(session, sequence)` is unique.
 */
export const LOCAL_WORKING_SEQUENCE_BASE = 1_000_000_000

export function encodeLocalWorkingValue(value: unknown): string {
  return `${LOCAL_WORKING_PREFIX}${JSON.stringify(value)}`
}

export function decodeLocalWorkingValue(content: string): unknown | null {
  if (!content?.startsWith(LOCAL_WORKING_PREFIX)) return null
  try {
    return JSON.parse(content.slice(LOCAL_WORKING_PREFIX.length))
  } catch {
    return null
  }
}

export function isLocalWorkingContent(content: string | null | undefined): boolean {
  return typeof content === 'string' && content.startsWith(LOCAL_WORKING_PREFIX)
}

export function isLocalWorkingItemId(itemId: string | null | undefined): boolean {
  if (typeof itemId !== 'string') return false
  return (
    itemId.startsWith(TOOL_RESULT_ITEM_PREFIX) ||
    itemId.startsWith(LOCAL_USER_ITEM_PREFIX) ||
    itemId.startsWith(LOCAL_ASSISTANT_ITEM_PREFIX)
  )
}

/**
 * Review items synthesised for the local working state. These must be excluded
 * from the transcript handed to the model and from the user-visible thread.
 */
export function isLocalWorkingItem(row: {
  itemId?: string | null
  content?: string | null
}): boolean {
  return isLocalWorkingItemId(row.itemId) || isLocalWorkingContent(row.content)
}

/**
 * Working rows to re-insert after the transcript was replaced: in their saved
 * order, numbered from `LOCAL_WORKING_SEQUENCE_BASE`, and detached from the
 * turns the replacement deleted.
 *
 * The history routes replace a session's items by deleting all of them. That
 * removed the working history mid-turn, so a turn resumed after `plan` reached
 * the model with no user message and a result detached from its call, and the
 * model server refused it.
 */
export function rebaseLocalWorkingRows<T extends { sequence: number; turnId?: string | null }>(
  rows: T[]
): T[] {
  return [...rows]
    .sort((left, right) => left.sequence - right.sequence)
    .map((row, index) => ({ ...row, sequence: LOCAL_WORKING_SEQUENCE_BASE + index, turnId: null }))
}
