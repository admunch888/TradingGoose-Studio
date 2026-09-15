/**
 * Working-message helpers for the local Copilot runtime.
 *
 * The managed Copilot service keeps the model conversation server-side. The
 * local runtime has no such service, so the OpenAI-style working history is
 * persisted by us (see `persistence.ts`) and rebuilt for every turn and tool
 * continuation.
 */

export interface LocalWorkingMessage {
  role: string
  content?: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

export interface LocalContinuationInput {
  toolCallId: string
  toolName: string
  status: number
  message?: unknown
  data?: unknown
}

export interface LocalWorkingState {
  /** Working messages in truncation order (system message excluded then re-added). */
  messages: LocalWorkingMessage[]
  /** System prompt that produced this history. */
  systemPrompt: string
  /** Model context window in tokens, used for trimming. */
  contextWindow: number
}

export const DEFAULT_LOCAL_CONTEXT_WINDOW = 32_768
/** Rough characters-per-token ratio used to estimate prompt size. */
const CHARS_PER_TOKEN = 4

function isToolMessage(message: LocalWorkingMessage): boolean {
  return typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0
}

/**
 * Builds the working message list for a turn.
 *
 * The system prompt is not stored in the list — it is prepended at request time
 * by `trimLocalWorkingMessages` — so prompt changes take effect immediately.
 */
export function buildLocalWorkingMessages(params: {
  systemPrompt: string
  priorWorkingMessages: LocalWorkingMessage[]
  userContent: string
  continuation?: LocalContinuationInput
  defaultContextWindow?: number
  contextWindow?: number
}): LocalWorkingMessage[] {
  const messages = [...(params.priorWorkingMessages ?? [])]

  if (params.continuation) {
    const { toolCallId, toolName, status, message, data } = params.continuation
    // The route persists the tool result (`persistLocalContinuation`) BEFORE it
    // invokes the continuation, and the caller reloads the working history from
    // that store — so the same result arrives both in `priorWorkingMessages` and
    // as `continuation`. Pushing it again would send the model two role:'tool'
    // messages sharing one tool_call_id (rejected by most OpenAI-compatible
    // servers, and silently double-counted by the rest), so only add it when the
    // history does not already carry that call.
    const alreadyPersisted = messages.some(
      (existing) => existing.role === 'tool' && existing.tool_call_id === toolCallId
    )
    if (!alreadyPersisted) {
      messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        name: toolName,
        content: truncate(
          JSON.stringify({
            ok: status >= 200 && status < 300,
            status,
            ...(message !== undefined ? { message } : {}),
            ...(data !== undefined ? { data } : {}),
          }),
          200_000
        ),
      })
    }
    return trimLocalWorkingMessages(messages, {
      systemPrompt: params.systemPrompt,
      contextWindow: params.contextWindow ?? params.defaultContextWindow,
    })
  }

  messages.push({ role: 'user', content: params.userContent })
  return trimLocalWorkingMessages(messages, {
    systemPrompt: params.systemPrompt,
    contextWindow: params.contextWindow ?? params.defaultContextWindow,
  })
}

/**
 * Makes the history one an OpenAI-compatible server accepts: every assistant
 * tool call has its tool result, and every tool result answers a tool call
 * made before it. A session saved by an earlier build could hold a step whose
 * other calls never ran (the loop halted on a browser tool), and resuming it
 * failed with a 400 on every continuation. Unanswered calls are dropped (an
 * assistant step left with no calls keeps its text, or goes), and so are
 * orphan results.
 *
 * Each result is placed right after its call. A turn that stopped for a browser
 * tool used to save its reply text after the call, so the result the browser
 * sent back followed that text and the resumed request was refused.
 */
export function repairToolCallPairs(messages: LocalWorkingMessage[]): LocalWorkingMessage[] {
  const placed = new Set<number>()
  const repaired: LocalWorkingMessage[] = []
  // The first unplaced result for a call after it; call ids such as `call_0`
  // repeat across steps when the server sends none.
  const findResult = (callId: string, callIndex: number) =>
    messages.findIndex(
      (message, index) =>
        index > callIndex &&
        !placed.has(index) &&
        isToolMessage(message) &&
        message.tool_call_id === callId
    )

  messages.forEach((message, index) => {
    // Results are placed with their call; one no call claims is an orphan.
    if (isToolMessage(message)) return
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const answered = message.tool_calls.flatMap((call) => {
        const resultIndex = findResult(call.id, index)
        if (resultIndex === -1) return []
        placed.add(resultIndex)
        return [{ call, result: messages[resultIndex] }]
      })
      if (answered.length > 0) {
        repaired.push(
          answered.length === message.tool_calls.length
            ? message
            : { ...message, tool_calls: answered.map((entry) => entry.call) }
        )
        repaired.push(...answered.map((entry) => entry.result))
      } else if (message.content?.trim()) {
        const { tool_calls: _dropped, ...textOnly } = message
        repaired.push(textOnly)
      }
      return
    }
    repaired.push(message)
  })

  return repaired
}

/**
 * Tool call arguments as a JSON object string. The model streams arguments as
 * text, and a fragment that is not a JSON object (cut off, empty, or an array)
 * is executed as `{}`. Replaying the raw text made the next request fail:
 * SGLang parses each call's arguments to render the Qwen chat template and
 * answers a failure with 400 before prefill, so the turn died right after its
 * first tool call.
 */
export function normalizeToolCallArguments(value: string | null | undefined): string {
  if (!value?.trim()) return '{}'
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? JSON.stringify(parsed)
      : '{}'
  } catch {
    return '{}'
  }
}

const normalizeStoredToolCalls = (message: LocalWorkingMessage): LocalWorkingMessage => {
  if (!message.tool_calls?.length) return message
  const toolCalls = message.tool_calls.map((call) => {
    const args = normalizeToolCallArguments(call.function.arguments)
    return args === call.function.arguments
      ? call
      : { ...call, function: { ...call.function, arguments: args } }
  })
  return toolCalls.every((call, index) => call === message.tool_calls?.[index])
    ? message
    : { ...message, tool_calls: toolCalls }
}

/**
 * How much of an older tool result the rebuilt history carries. Block and
 * workflow metadata results run to hundreds of kilobytes; replaying them whole
 * pushed the conversation itself out of the context budget.
 */
export const MAX_HISTORY_TOOL_RESULT_CHARS = 16_000

const compactToolResult = (message: LocalWorkingMessage): LocalWorkingMessage =>
  isToolMessage(message) &&
  typeof message.content === 'string' &&
  message.content.length > MAX_HISTORY_TOOL_RESULT_CHARS
    ? { ...message, content: truncate(message.content, MAX_HISTORY_TOOL_RESULT_CHARS) }
    : message

/**
 * How much of a tool result survives a second trimming pass, once dropping
 * whole exchanges was not enough. Reached only by a long turn whose remaining
 * exchanges still overflow the window.
 */
export const OVERFLOW_TOOL_RESULT_CHARS = 4_000

/**
 * Drops the oldest whole tool exchanges until the estimated prompt fits the
 * model context window, then prepends the system prompt.
 *
 * The latest user message is never dropped. A continuation (the turn resumed
 * after a browser tool such as `plan`) adds no user message of its own, so
 * after a few large tool results trimming used to remove the user's request
 * itself; Qwen3-family chat templates then raise "No user query found in
 * messages" and SGLang answered every such continuation with 400 before
 * prefill. Older tool results are compacted first, and the pairs are repaired
 * again after trimming so no result outlives its call.
 */
export function trimLocalWorkingMessages(
  messages: LocalWorkingMessage[],
  options: { systemPrompt: string; contextWindow?: number }
): LocalWorkingMessage[] {
  // Sessions saved before arguments were normalized can still hold raw ones.
  messages = repairToolCallPairs(messages).map(compactToolResult).map(normalizeStoredToolCalls)
  const contextWindow = options.contextWindow ?? DEFAULT_LOCAL_CONTEXT_WINDOW
  const systemMessage: LocalWorkingMessage = { role: 'system', content: options.systemPrompt }

  // Reserve room for the response, tools schema and context blocks.
  const budgetTokens = Math.max(2_048, Math.floor(contextWindow * 0.5))
  const budgetChars = budgetTokens * CHARS_PER_TOKEN

  const estimate = (list: LocalWorkingMessage[]) =>
    list.reduce((total, message) => total + JSON.stringify(message).length, 0)
  const latestUserIndex = (list: LocalWorkingMessage[]) =>
    list.map((message) => message.role).lastIndexOf('user')

  // The system prompt is part of the prompt the server sees, and with a skill
  // loaded it is not small - leaving it out of the budget is how a request ends
  // up over the window and is refused with an empty 400.
  const systemChars = JSON.stringify(systemMessage).length
  const fits = (list: LocalWorkingMessage[]) => systemChars + estimate(list) <= budgetChars

  /** The oldest message that may be dropped: anything but the latest user turn. */
  const firstRemovableIndex = (list: LocalWorkingMessage[]) => {
    const keep = latestUserIndex(list)
    for (let i = 0; i < list.length; i++) {
      if (i !== keep) return i
    }
    return -1
  }

  const dropOldestExchanges = (list: LocalWorkingMessage[]) => {
    while (!fits(list)) {
      const start = firstRemovableIndex(list)
      if (start === -1) break
      // Never split an assistant tool_calls message from its tool results: drop
      // forward until the next user/assistant message so the pairing survives.
      let end = start + 1
      while (end < list.length && isToolMessage(list[end])) end++
      // Keep the exchange the turn is resuming; there is nothing after it.
      if (end >= list.length) break
      list = [...list.slice(0, start), ...list.slice(end)]
    }
    return list
  }

  let trimmed = dropOldestExchanges(messages)

  // A long turn can still overflow once only the newest exchanges are left -
  // each one capped at MAX_HISTORY_TOOL_RESULT_CHARS, twenty of them do not
  // fit. Shrink the results that remain rather than return an oversized prompt.
  if (!fits(trimmed)) {
    trimmed = dropOldestExchanges(
      trimmed.map((message) =>
        isToolMessage(message) && typeof message.content === 'string'
          ? { ...message, content: truncate(message.content, OVERFLOW_TOOL_RESULT_CHARS) }
          : message
      )
    )
  }

  return [systemMessage, ...repairToolCallPairs(trimmed)]
}

/**
 * The shape of a request's messages, for logging a model server refusal
 * without logging the conversation: roles in order (tool call counts on
 * assistant steps), whether a user message is present, and the size.
 */
export function summarizeWorkingMessages(messages: LocalWorkingMessage[]): {
  messageCount: number
  roles: string
  hasUserMessage: boolean
  estimatedChars: number
} {
  return {
    messageCount: messages.length,
    roles: messages
      .map((message) =>
        message.tool_calls?.length
          ? `${message.role}(calls:${message.tool_calls.length})`
          : message.role
      )
      .join(','),
    hasUserMessage: messages.some((message) => message.role === 'user'),
    estimatedChars: messages.reduce((total, message) => total + JSON.stringify(message).length, 0),
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n…[truncated]` : value
}
