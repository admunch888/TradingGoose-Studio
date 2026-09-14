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
 * Drops the oldest whole tool exchanges until the estimated prompt fits the
 * model context window, then prepends the system prompt.
 */
/**
 * Makes the history one an OpenAI-compatible server accepts: every assistant
 * tool call has its tool result, and every tool result answers a tool call
 * made before it. A session saved by an earlier build could hold a step whose
 * other calls never ran (the loop halted on a browser tool), and resuming it
 * failed with a 400 on every continuation. Unanswered calls are dropped (an
 * assistant step left with no calls keeps its text, or goes), and so are
 * orphan results.
 */
export function repairToolCallPairs(messages: LocalWorkingMessage[]): LocalWorkingMessage[] {
  const answered = new Set(
    messages.filter(isToolMessage).map((message) => message.tool_call_id as string)
  )
  const called = new Set<string>()
  const repaired: LocalWorkingMessage[] = []

  for (const message of messages) {
    if (isToolMessage(message)) {
      if (called.has(message.tool_call_id as string)) repaired.push(message)
      continue
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const calls = message.tool_calls.filter((call) => answered.has(call.id))
      calls.forEach((call) => called.add(call.id))
      if (calls.length > 0) {
        repaired.push(
          calls.length === message.tool_calls.length ? message : { ...message, tool_calls: calls }
        )
      } else if (message.content?.trim()) {
        const { tool_calls: _dropped, ...textOnly } = message
        repaired.push(textOnly)
      }
      continue
    }
    repaired.push(message)
  }

  return repaired
}

export function trimLocalWorkingMessages(
  messages: LocalWorkingMessage[],
  options: { systemPrompt: string; contextWindow?: number }
): LocalWorkingMessage[] {
  messages = repairToolCallPairs(messages)
  const contextWindow = options.contextWindow ?? DEFAULT_LOCAL_CONTEXT_WINDOW
  const systemMessage: LocalWorkingMessage = { role: 'system', content: options.systemPrompt }

  // Reserve room for the response, tools schema and context blocks.
  const budgetTokens = Math.max(2_048, Math.floor(contextWindow * 0.5))
  const budgetChars = budgetTokens * CHARS_PER_TOKEN

  const estimate = (list: LocalWorkingMessage[]) =>
    list.reduce((total, message) => total + JSON.stringify(message).length, 0)

  let trimmed = messages
  let index = 0
  while (estimate(trimmed) > budgetChars && index < trimmed.length - 2) {
    // Never split an assistant tool_calls message from its tool results: drop
    // forward until the next user/assistant message so the pairing survives.
    let end = index + 1
    while (end < trimmed.length && isToolMessage(trimmed[end])) end++
    trimmed = [...trimmed.slice(0, index), ...trimmed.slice(end)]
    // Keep the loop bounded if nothing was removable.
    if (isToolMessage(trimmed[index])) index++
  }

  return [systemMessage, ...trimmed]
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n…[truncated]` : value
}
