import { describe, expect, it } from 'vitest'
import {
  buildLocalWorkingMessages,
  type LocalWorkingMessage,
  MAX_HISTORY_TOOL_RESULT_CHARS,
  summarizeWorkingMessages,
  trimLocalWorkingMessages,
} from '@/lib/copilot/local-runtime/working-messages'

const call = (id: string, name: string): LocalWorkingMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
})
const result = (id: string, content: string): LocalWorkingMessage => ({
  role: 'tool',
  tool_call_id: id,
  content,
})

/** The history a continuation resumes: the request, heavy exploration, then plan. */
const continuationHistory = (): LocalWorkingMessage[] => [
  { role: 'user', content: 'Build the MES Options Chain workflow' },
  call('call_blocks', 'get_available_blocks'),
  result('call_blocks', 'x'.repeat(300_000)),
  call('call_meta', 'get_blocks_metadata'),
  result('call_meta', 'y'.repeat(300_000)),
  call('call_plan', 'plan'),
]

describe('trimming a continuation history', () => {
  it('keeps the user request even when tool results overflow the budget', () => {
    const messages = buildLocalWorkingMessages({
      systemPrompt: 'system',
      priorWorkingMessages: continuationHistory(),
      userContent: '',
      continuation: {
        toolCallId: 'call_plan',
        toolName: 'plan',
        status: 200,
        message: 'Plan ready',
      },
      contextWindow: 8_192,
    })

    expect(messages[0]).toEqual({ role: 'system', content: 'system' })
    expect(messages.filter((message) => message.role === 'user')).toEqual([
      { role: 'user', content: 'Build the MES Options Chain workflow' },
    ])
    // The plan exchange the continuation resumes survives, paired.
    expect(messages.at(-2)?.tool_calls?.[0]?.id).toBe('call_plan')
    expect(messages.at(-1)?.tool_call_id).toBe('call_plan')
    // No result outlives its call.
    const calls = new Set(messages.flatMap((message) => message.tool_calls?.map((c) => c.id) ?? []))
    for (const message of messages.filter((m) => m.role === 'tool')) {
      expect(calls.has(message.tool_call_id as string)).toBe(true)
    }
  })

  it('compacts large older tool results instead of replaying them whole', () => {
    const messages = trimLocalWorkingMessages(continuationHistory().slice(0, 3), {
      systemPrompt: 'system',
      contextWindow: 1_048_576,
    })

    const toolResult = messages.find((message) => message.role === 'tool')
    expect(toolResult?.content?.length).toBeLessThanOrEqual(MAX_HISTORY_TOOL_RESULT_CHARS + 20)
    expect(toolResult?.content?.endsWith('…[truncated]')).toBe(true)
  })

  it('leaves a history that fits untouched apart from the system prompt', () => {
    const history: LocalWorkingMessage[] = [
      { role: 'user', content: 'hi' },
      call('call_1', 'list_workflows'),
      result('call_1', '{"ok":true}'),
    ]

    expect(trimLocalWorkingMessages(history, { systemPrompt: 'system' })).toEqual([
      { role: 'system', content: 'system' },
      ...history,
    ])
  })
})

describe('summarizeWorkingMessages', () => {
  it('describes the request shape without its content', () => {
    const summary = summarizeWorkingMessages([
      { role: 'system', content: 'secret system prompt' },
      call('call_1', 'plan'),
      result('call_1', '{"ok":true}'),
    ])

    expect(summary).toMatchObject({
      messageCount: 3,
      roles: 'system,assistant(calls:1),tool',
      hasUserMessage: false,
    })
    expect(JSON.stringify(summary)).not.toContain('secret system prompt')
  })
})
