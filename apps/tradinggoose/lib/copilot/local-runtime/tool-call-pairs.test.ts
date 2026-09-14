/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { describeModelServerError } from '@/lib/copilot/local-runtime/model-server-error'
import {
  type LocalWorkingMessage,
  repairToolCallPairs,
  trimLocalWorkingMessages,
} from '@/lib/copilot/local-runtime/working-messages'

type FakeChunk = { choices: Array<{ delta: Record<string, unknown> }> }

const mockState = vi.hoisted(() => ({
  streams: [] as FakeChunk[][],
  createBodies: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/system-services/runtime', () => ({
  resolveVllmServiceConfig: async () => ({ baseUrl: 'http://127.0.0.1:8000' }),
}))

vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: async (body: Record<string, unknown>) => {
          mockState.createBodies.push(body)
          const chunks = mockState.streams.shift() ?? []
          return {
            async *[Symbol.asyncIterator]() {
              for (const chunk of chunks) yield chunk
            },
          }
        },
      },
    }
  },
}))

vi.mock('@/lib/copilot/runtime-tool-manifest', () => ({
  getCopilotRuntimeToolManifest: async () => ({
    version: 'v1',
    tools: [
      { name: 'get_available_blocks', description: 'Blocks' },
      { name: 'plan', description: 'Plan', parameters: { type: 'object' } },
    ],
  }),
}))

vi.mock('@/lib/copilot/local-runtime/tool-execution', () => ({
  executeLocalCopilotServerTool: async () => ({ success: true, result: { ok: true } }),
}))

import { runLocalCopilotTurn } from '@/lib/copilot/local-runtime/agent'

const user = (content: string): LocalWorkingMessage => ({ role: 'user', content })
const calls = (...ids: string[]): LocalWorkingMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: ids.map((id) => ({
    id,
    type: 'function' as const,
    function: { name: id.startsWith('plan') ? 'plan' : 'get_available_blocks', arguments: '{}' },
  })),
})
const result = (id: string): LocalWorkingMessage => ({
  role: 'tool',
  tool_call_id: id,
  content: '{"ok":true}',
})

describe('repairToolCallPairs', () => {
  it('drops tool calls that never got a result, keeping the answered ones', () => {
    // The saved step from a halt on plan: get_available_blocks never ran.
    const history = [user('build it'), calls('blocks_1', 'plan_1'), result('plan_1')]

    expect(repairToolCallPairs(history)).toEqual([
      user('build it'),
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'plan_1', type: 'function', function: { name: 'plan', arguments: '{}' } },
        ],
      },
      result('plan_1'),
    ])
  })

  it('drops orphan results and steps left with nothing to say', () => {
    const history = [
      user('hi'),
      calls('blocks_1'),
      result('ghost'),
      { role: 'assistant', content: 'Working on it', tool_calls: calls('blocks_2').tool_calls },
      user('again'),
    ]

    expect(repairToolCallPairs(history)).toEqual([
      user('hi'),
      { role: 'assistant', content: 'Working on it' },
      user('again'),
    ])
  })

  it('leaves a well-formed history untouched and repairs before trimming', () => {
    const history = [user('go'), calls('blocks_1'), result('blocks_1')]

    expect(repairToolCallPairs(history)).toEqual(history)
    expect(
      trimLocalWorkingMessages([user('go'), calls('blocks_1', 'plan_1'), result('plan_1')], {
        systemPrompt: 'system',
      })[2]?.tool_calls
    ).toHaveLength(1)
  })
})

describe('local agent halting on a browser tool', () => {
  beforeEach(() => {
    mockState.streams = []
    mockState.createBodies = []
  })

  it('records only the browser tool it hands off, with the id the frame and result use', async () => {
    // One step asking for a server tool and plan, with no ids from the server.
    mockState.streams = [
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { name: 'get_available_blocks', arguments: '{}' } },
                  { index: 1, function: { name: 'plan', arguments: '{"objective":"x"}' } },
                ],
              },
            },
          ],
        },
      ],
    ]
    const frames: Array<Record<string, unknown>> = []

    const run = await runLocalCopilotTurn({
      model: 'vllm/qwen3.8-fp8',
      conversationId: 'session-1',
      userMessage: 'build it',
      contexts: [],
      priorWorkingMessages: [],
      ctx: { userId: 'user-1', accessLevel: 'full' },
      sink: { send: (frame) => frames.push(frame), close: () => {}, error: () => {} },
      requestId: 'req-1',
    })

    expect(run.awaiting).toEqual({ toolCallId: 'call_1', toolName: 'plan' })
    const step = run.workingMessages.at(-1)
    expect(step?.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'plan', arguments: '{"objective":"x"}' },
      },
    ])
  })
})

describe('describeModelServerError', () => {
  it('keeps the status, message and body a model server refusal carries', () => {
    const error = Object.assign(new Error('400 tool call has no response'), {
      status: 400,
      error: { message: 'tool call has no response', type: 'BadRequestError' },
    })

    expect(describeModelServerError(error)).toEqual({
      status: 400,
      message: '400 tool call has no response',
      body: { message: 'tool call has no response', type: 'BadRequestError' },
    })
    expect(describeModelServerError('boom')).toEqual({ message: 'boom' })
  })
})
