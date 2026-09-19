import { copilotReviewItems, db } from '@tradinggoose/db'
import { and, asc, desc, eq, gte, like, lt, notLike } from 'drizzle-orm'
import { LOCAL_COPILOT_MODEL_PREFIX } from '@/lib/copilot/local-runtime/runtime-models'
import type { LocalWorkingMessage } from '@/lib/copilot/local-runtime/working-messages'
import {
  decodeLocalWorkingValue,
  encodeLocalWorkingValue,
  LOCAL_ASSISTANT_ITEM_PREFIX,
  LOCAL_USER_ITEM_PREFIX,
  LOCAL_WORKING_PREFIX,
  LOCAL_WORKING_SEQUENCE_BASE,
  TOOL_RESULT_ITEM_PREFIX,
} from '@/lib/copilot/local-runtime/working-rows'
import { createLogger } from '@/lib/logs/console/logger'
import { safeRandomUUID } from '@/lib/safe-uuid'

export {
  isLocalWorkingContent,
  isLocalWorkingItem,
  isLocalWorkingItemId,
} from '@/lib/copilot/local-runtime/working-rows'

const logger = createLogger('LocalCopilotPersistence')

/**
 * Persistence for the local Copilot runtime's model working history.
 *
 * Rows live in the existing Copilot review tables so no schema migration is
 * needed:
 * - the assistant `tool_calls` message is stored as a `function_call` review
 *   item (`content` holds the calls and the step's text);
 * - each tool result is stored as a synthetic `tool_result` review item whose
 *   content is namespaced with `LOCAL_WORKING_PREFIX` and filtered out of the
 *   user-visible transcript and of the model's own conversation history.
 *
 * Working rows are numbered from `LOCAL_WORKING_SEQUENCE_BASE` (working-rows.ts),
 * apart from the transcript.
 */
const FUNCTION_CALL_KIND = 'function_call'
const MAX_WORKING_INSERT_ATTEMPTS = 5

type WorkingRow = { itemId: string; content: string }
type WorkingRowValues = Omit<typeof copilotReviewItems.$inferInsert, 'sessionId' | 'sequence'> & {
  itemId: string
}

/**
 * Appends one working row after the session's last working row.
 *
 * A write that lost its sequence to a concurrent one used to vanish
 * (`onConflictDoNothing`), silently dropping a user request or a tool call from
 * the history. The sequence is now re-read and the write retried; a conflict on
 * the item id is an already-saved row and ends the write.
 */
async function insertLocalWorkingRow(
  reviewSessionId: string,
  values: WorkingRowValues
): Promise<void> {
  for (let attempt = 0; attempt < MAX_WORKING_INSERT_ATTEMPTS; attempt++) {
    const [lastRow] = await db
      .select({ sequence: copilotReviewItems.sequence })
      .from(copilotReviewItems)
      .where(
        and(
          eq(copilotReviewItems.sessionId, reviewSessionId),
          gte(copilotReviewItems.sequence, LOCAL_WORKING_SEQUENCE_BASE)
        )
      )
      .orderBy(desc(copilotReviewItems.sequence))
      .limit(1)

    const sequence =
      typeof lastRow?.sequence === 'number' ? lastRow.sequence + 1 : LOCAL_WORKING_SEQUENCE_BASE

    const inserted = await db
      .insert(copilotReviewItems)
      .values({ ...values, sessionId: reviewSessionId, sequence })
      .onConflictDoNothing()
      .returning({ id: copilotReviewItems.id })
    if (inserted.length > 0) return

    const [existing] = await db
      .select({ id: copilotReviewItems.id })
      .from(copilotReviewItems)
      .where(
        and(
          eq(copilotReviewItems.sessionId, reviewSessionId),
          eq(copilotReviewItems.itemId, values.itemId)
        )
      )
      .limit(1)
    if (existing) return
  }

  logger.warn('Local copilot working history row was not saved', {
    reviewSessionId,
    itemId: values.itemId,
  })
}

/** Persists a single working message (assistant tool_calls or tool result). */
export async function persistLocalWorkingMessage(params: {
  reviewSessionId: string
  message: LocalWorkingMessage
}): Promise<void> {
  const { reviewSessionId, message } = params
  const isToolMessage = typeof message.tool_call_id === 'string' && !!message.tool_call_id

  await insertLocalWorkingRow(reviewSessionId, {
    turnId: null,
    itemId: isToolMessage
      ? `${TOOL_RESULT_ITEM_PREFIX}${message.tool_call_id}`
      : `local_tool_calls_${safeRandomUUID()}`,
    kind: isToolMessage ? 'tool_result' : FUNCTION_CALL_KIND,
    messageRole: isToolMessage ? 'tool' : 'assistant',
    content: isToolMessage
      ? encodeLocalWorkingValue({
          content: message.content ?? '',
          toolCallId: message.tool_call_id,
          ...(message.name ? { name: message.name } : {}),
        })
      : // The step's text travels with its calls, so it is replayed in place
        // rather than saved as a separate reply between the call and its result.
        encodeLocalWorkingValue({
          tool_calls: message.tool_calls ?? [],
          ...(message.content ? { content: message.content } : {}),
        }),
    timestamp: new Date().toISOString(),
    contentBlocks: [],
    contexts: [],
    fileAttachments: [],
    citations: [],
  })
}

/**
 * Loads the working history for a session in insertion order, skipping the
 * user-authored transcript rows (those are rebuilt from the turn history).
 *
 * Returns `null` when nothing has been persisted yet.
 */
export async function loadLocalWorkingMessages(
  reviewSessionId: string
): Promise<LocalWorkingMessage[] | null> {
  const rows = await db
    .select({ itemId: copilotReviewItems.itemId, content: copilotReviewItems.content })
    .from(copilotReviewItems)
    .where(
      and(
        eq(copilotReviewItems.sessionId, reviewSessionId),
        like(copilotReviewItems.content, `${LOCAL_WORKING_PREFIX}%`)
      )
    )
    .orderBy(asc(copilotReviewItems.sequence))

  if (rows.length === 0) return null

  const messages: LocalWorkingMessage[] = []
  for (const row of rows as WorkingRow[]) {
    const decoded = decodeLocalWorkingValue(row.content)
    if (!decoded || typeof decoded !== 'object') continue
    const record = decoded as Record<string, unknown>

    if (Array.isArray(record.tool_calls)) {
      messages.push({
        role: 'assistant',
        content: typeof record.content === 'string' ? record.content : null,
        tool_calls: record.tool_calls as LocalWorkingMessage['tool_calls'],
      })
      continue
    }

    if (typeof record.toolCallId === 'string') {
      messages.push({
        role: 'tool',
        tool_call_id: record.toolCallId,
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        content: typeof record.content === 'string' ? record.content : '',
      })
      continue
    }

    // Plain user/assistant text turns, written by persistLocalWorkingUserMessage
    // and persistLocalWorkingAssistantMessage. Without these the model would
    // only ever see the current turn.
    if (
      typeof record.text === 'string' &&
      (record.role === 'user' || record.role === 'assistant')
    ) {
      messages.push({ role: record.role, content: record.text })
    }
  }

  return messages.length > 0 ? messages : null
}

/**
 * Records the user's turn in the working history so later turns can replay it.
 * Idempotent per itemId, so a retried request cannot duplicate the turn.
 */
export async function persistLocalWorkingUserMessage(params: {
  reviewSessionId: string
  itemId: string
  text: string
}): Promise<void> {
  await appendWorkingRow(params.reviewSessionId, `${LOCAL_USER_ITEM_PREFIX}${params.itemId}`, {
    text: params.text,
    role: 'user',
  })
}

/**
 * Records the assistant's final reply text in the working history. Called once
 * per completed turn; tool-call steps carry their own text.
 */
export async function persistLocalWorkingAssistantMessage(params: {
  reviewSessionId: string
  itemId: string
  text: string
}): Promise<void> {
  if (!params.text.trim()) return
  await appendWorkingRow(params.reviewSessionId, `${LOCAL_ASSISTANT_ITEM_PREFIX}${params.itemId}`, {
    text: params.text,
    role: 'assistant',
  })
}

/** Inserts one namespaced working-history row at the end of the session. */
async function appendWorkingRow(
  reviewSessionId: string,
  itemId: string,
  payload: Record<string, unknown>
): Promise<void> {
  await insertLocalWorkingRow(reviewSessionId, {
    turnId: null,
    itemId,
    kind: 'message',
    messageRole: typeof payload.role === 'string' ? payload.role : 'assistant',
    content: encodeLocalWorkingValue(payload),
    timestamp: new Date().toISOString(),
    contentBlocks: [],
    contexts: [],
    fileAttachments: [],
    citations: [],
  })
}

/**
 * Appends the continuation tool result to the persisted working history.
 * Idempotent: a tool result for the same call id is never written twice.
 */
export async function persistLocalContinuation(params: {
  reviewSessionId: string
  toolCallId: string
  toolName: string
  status: number
  message?: unknown
  data?: unknown
}): Promise<void> {
  const existing = await db
    .select({ itemId: copilotReviewItems.itemId })
    .from(copilotReviewItems)
    .where(
      and(
        eq(copilotReviewItems.sessionId, params.reviewSessionId),
        eq(copilotReviewItems.itemId, `${TOOL_RESULT_ITEM_PREFIX}${params.toolCallId}`)
      )
    )
    .limit(1)

  if (existing.length > 0) return

  await persistLocalWorkingMessage({
    reviewSessionId: params.reviewSessionId,
    message: {
      role: 'tool',
      tool_call_id: params.toolCallId,
      name: params.toolName,
      content: JSON.stringify({
        ok: params.status >= 200 && params.status < 300,
        status: params.status,
        ...(params.message !== undefined ? { message: params.message } : {}),
        ...(params.data !== undefined ? { data: params.data } : {}),
      }),
    },
  })
}

/** Deletes the assistant tool_calls row for a turn that ended without tools. */
export async function deleteLocalWorkingMessage(
  reviewSessionId: string,
  itemId: string
): Promise<void> {
  await db
    .delete(copilotReviewItems)
    .where(
      and(eq(copilotReviewItems.sessionId, reviewSessionId), eq(copilotReviewItems.itemId, itemId))
    )
}

export async function clearLocalWorkingState(reviewSessionId: string): Promise<void> {
  await db
    .delete(copilotReviewItems)
    .where(
      and(
        eq(copilotReviewItems.sessionId, reviewSessionId),
        like(copilotReviewItems.content, `${LOCAL_WORKING_PREFIX}%`)
      )
    )
}

// ---------------------------------------------------------------- transcript --
// The user-visible assistant message is stored as a normal review item so the
// client renders local turns with the same code path as hosted ones.

/** Persists (or replaces) the assistant transcript item for a local turn. */
export async function persistLocalReviewMessage(params: {
  reviewSessionId: string
  itemId: string
  role: 'assistant' | 'user'
  content: string
}): Promise<void> {
  if (!params.content.trim()) return

  const existing = await db
    .select({ id: copilotReviewItems.id })
    .from(copilotReviewItems)
    .where(
      and(
        eq(copilotReviewItems.sessionId, params.reviewSessionId),
        eq(copilotReviewItems.itemId, params.itemId)
      )
    )
    .limit(1)

  if (existing.length > 0) {
    await db
      .update(copilotReviewItems)
      .set({ content: params.content })
      .where(eq(copilotReviewItems.id, existing[0].id))
    return
  }

  // Transcript items stay below the working rows' range.
  const [lastRow] = await db
    .select({ sequence: copilotReviewItems.sequence })
    .from(copilotReviewItems)
    .where(
      and(
        eq(copilotReviewItems.sessionId, params.reviewSessionId),
        lt(copilotReviewItems.sequence, LOCAL_WORKING_SEQUENCE_BASE)
      )
    )
    .orderBy(desc(copilotReviewItems.sequence))
    .limit(1)

  const nextSequence = typeof lastRow?.sequence === 'number' ? lastRow.sequence + 1 : 0

  await db.insert(copilotReviewItems).values({
    sessionId: params.reviewSessionId,
    turnId: null,
    sequence: nextSequence,
    itemId: params.itemId,
    kind: 'message',
    messageRole: params.role,
    content: params.content,
    timestamp: new Date().toISOString(),
    contentBlocks: [],
    contexts: [],
    fileAttachments: [],
    citations: [],
  })
}

/**
 * Appends text to the most recent assistant transcript item of a session,
 * creating one when the continuation produced text before any was stored.
 */
export async function appendLocalAssistantText(
  reviewSessionId: string,
  text: string
): Promise<void> {
  if (!text.trim()) return

  const [latest] = await db
    .select({ id: copilotReviewItems.id, content: copilotReviewItems.content })
    .from(copilotReviewItems)
    .where(
      and(
        eq(copilotReviewItems.sessionId, reviewSessionId),
        eq(copilotReviewItems.messageRole, 'assistant'),
        eq(copilotReviewItems.kind, 'message'),
        notLike(copilotReviewItems.content, `${LOCAL_WORKING_PREFIX}%`)
      )
    )
    .orderBy(desc(copilotReviewItems.sequence))
    .limit(1)

  if (latest) {
    await db
      .update(copilotReviewItems)
      .set({ content: `${latest.content}${text}` })
      .where(eq(copilotReviewItems.id, latest.id))
    return
  }

  await persistLocalReviewMessage({
    reviewSessionId,
    itemId: `local_assistant_${safeRandomUUID()}`,
    role: 'assistant',
    content: text,
  })
}

/**
 * Normalizes a stored session model to the bare runtime model name.
 *
 * mark-complete receives no model from the client, so callers recover the value
 * from the session row they have already loaded and verified as owned instead of
 * looking the session up by id alone.
 */
export function toLocalRuntimeModelName(model: string | null | undefined): string | null {
  if (!model) return null
  return model.startsWith(LOCAL_COPILOT_MODEL_PREFIX)
    ? model.slice(LOCAL_COPILOT_MODEL_PREFIX.length)
    : model
}
