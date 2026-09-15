import { describe, expect, it } from 'vitest'
import {
  buildLocalWorkingMessages,
  type LocalWorkingMessage,
  MAX_HISTORY_TOOL_RESULT_CHARS,
  normalizeToolCallArguments,
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

  it('fits a long turn whose newest exchanges alone overflow the window', () => {
    // What the workflow-building turn produced: twenty exploration exchanges,
    // each result already at the per-result cap. The old forward-only loop
    // stopped with the whole tail in place and SGLang refused the request with
    // an empty 400 (estimatedChars 524671 against a 262144 budget).
    const history: LocalWorkingMessage[] = [{ role: 'user', content: 'Build the workflow' }]
    for (let i = 0; i < 20; i++) {
      history.push(call(`call_${i}`, 'get_blocks_metadata'))
      history.push(result(`call_${i}`, 'z'.repeat(MAX_HISTORY_TOOL_RESULT_CHARS)))
    }

    const messages = trimLocalWorkingMessages(history, {
      systemPrompt: 's'.repeat(40_000),
      contextWindow: 131_072,
    })

    const totalChars = messages.reduce((total, m) => total + JSON.stringify(m).length, 0)
    expect(totalChars).toBeLessThanOrEqual(131_072 * 0.5 * 4)
    // The request itself survives, and so does the most recent exchange.
    expect(messages[1]).toEqual({ role: 'user', content: 'Build the workflow' })
    expect(messages.at(-2)?.tool_calls?.[0]?.id).toBe('call_19')
    expect(messages.at(-1)?.tool_call_id).toBe('call_19')
  })

  it('counts the system prompt against the budget', () => {
    const history: LocalWorkingMessage[] = [
      { role: 'user', content: 'hi' },
      call('call_1', 'list_workflows'),
      result('call_1', 'q'.repeat(20_000)),
      call('call_2', 'list_workflows'),
      result('call_2', 'q'.repeat(20_000)),
    ]

    // 8192 * 0.5 * 4 = 16384 chars of budget, nearly all of it the prompt.
    const messages = trimLocalWorkingMessages(history, {
      systemPrompt: 'p'.repeat(12_000),
      contextWindow: 8_192,
    })

    const totalChars = messages.reduce((total, m) => total + JSON.stringify(m).length, 0)
    expect(totalChars).toBeLessThanOrEqual(16_384)
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

describe('tool call arguments in a saved history', () => {
  it('rebuilds unparseable arguments as an empty object and keeps valid ones', () => {
    const history: LocalWorkingMessage[] = [
      { role: 'user', content: 'Build the workflow' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_bad',
            type: 'function',
            function: { name: 'get_blocks', arguments: '{"a":' },
          },
          { id: 'call_ok', type: 'function', function: { name: 'plan', arguments: '{"x": 1}' } },
        ],
      },
      result('call_bad', '{"ok":true}'),
      result('call_ok', '{"ok":true}'),
    ]

    const messages = trimLocalWorkingMessages(history, { systemPrompt: 'system' })

    expect(messages[2]?.tool_calls?.map((c) => c.function.arguments)).toEqual(['{}', '{"x":1}'])
  })

  it('normalizeToolCallArguments accepts only JSON objects', () => {
    expect(normalizeToolCallArguments('{"a":1}')).toBe('{"a":1}')
    expect(normalizeToolCallArguments('{"a":')).toBe('{}')
    expect(normalizeToolCallArguments('"text"')).toBe('{}')
    expect(normalizeToolCallArguments('null')).toBe('{}')
    expect(normalizeToolCallArguments(undefined)).toBe('{}')
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
