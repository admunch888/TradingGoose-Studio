/**
 * Finding B regression suite: a continuation's tool result must reach the model
 * exactly once.
 *
 * On a continuation turn the same browser tool result arrives twice — the route
 * persists it (`persistLocalContinuation` -> `local_tool_result_<toolCallId>`)
 * BEFORE invoking the continuation, and the handler then reloads the working
 * history (which now contains it) while also passing the identical
 * `continuation`. `buildLocalWorkingMessages` used to push it again
 * unconditionally, producing two role:'tool' messages sharing one
 * tool_call_id: rejected by most OpenAI-compatible servers, and silently
 * double-counted by the rest.
 */
import { describe, expect, it } from 'vitest'
import {
  buildLocalWorkingMessages,
  type LocalWorkingMessage,
} from '@/lib/copilot/local-runtime/working-messages'

const SYSTEM_PROMPT = 'system prompt'

function toolMessagesFor(messages: LocalWorkingMessage[], toolCallId: string) {
  return messages.filter(
    (message) => message.role === 'tool' && message.tool_call_id === toolCallId
  )
}

const assistantToolCall: LocalWorkingMessage = {
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: 'call_abc',
      type: 'function',
      function: { name: 'run_workflow', arguments: '{}' },
    },
  ],
}

describe('buildLocalWorkingMessages continuation idempotency', () => {
  it('does not duplicate a tool result the history already carries', () => {
    // Exactly what the continuation path produces today: the persisted row is
    // already the tail of the loaded history AND arrives as `continuation`.
    const priorWorkingMessages: LocalWorkingMessage[] = [
      { role: 'user', content: 'run the workflow' },
      assistantToolCall,
      {
        role: 'tool',
        tool_call_id: 'call_abc',
        name: 'run_workflow',
        content: JSON.stringify({ ok: true, status: 200, data: { done: true } }),
      },
    ]

    const messages = buildLocalWorkingMessages({
      systemPrompt: SYSTEM_PROMPT,
      priorWorkingMessages,
      userContent: '',
      continuation: {
        toolCallId: 'call_abc',
        toolName: 'run_workflow',
        status: 200,
        data: { done: true },
      },
    })

    expect(toolMessagesFor(messages, 'call_abc')).toHaveLength(1)
  })

  it('appends the result when the history does not carry it yet', () => {
    const priorWorkingMessages: LocalWorkingMessage[] = [
      { role: 'user', content: 'run the workflow' },
      assistantToolCall,
    ]

    const messages = buildLocalWorkingMessages({
      systemPrompt: SYSTEM_PROMPT,
      priorWorkingMessages,
      userContent: '',
      continuation: {
        toolCallId: 'call_abc',
        toolName: 'run_workflow',
        status: 200,
        data: { done: true },
      },
    })

    const [toolMessage] = toolMessagesFor(messages, 'call_abc')
    expect(toolMessage).toBeDefined()
    expect(toolMessage?.content).toContain('"ok":true')
  })
})
