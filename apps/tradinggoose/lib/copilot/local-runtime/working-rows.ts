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
 * Ids of the rows a transcript rewrite replaces: every transcript row, and
 * working rows saved before working rows had their own sequence range (those
 * sit among transcript sequences and would collide with the rewritten ones).
 * Every other working row is left in place.
 *
 * The history routes used to delete a session's items outright, which removed
 * the working history mid-turn. Deleting everything and inserting the working
 * rows again then raced the local runtime saving its next row: the insert
 * failed (`Failed query: insert into "copilot_review_items"`), rolled back the
 * transcript save, and Copilot stopped mid-task.
 */
export function getReviewItemIdsReplacedByTranscriptRewrite(
  items: Array<{
    id: string
    itemId?: string | null
    content?: string | null
    sequence?: number | null
  }>
): string[] {
  return items
    .filter(
      (item) =>
        !isLocalWorkingItem(item) ||
        (typeof item.sequence === 'number' && item.sequence < LOCAL_WORKING_SEQUENCE_BASE)
    )
    .map((item) => item.id)
}
