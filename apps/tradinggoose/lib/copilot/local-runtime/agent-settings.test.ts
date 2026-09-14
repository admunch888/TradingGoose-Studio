/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeChunk = { choices: Array<{ delta: Record<string, unknown> }> }

const mockState = vi.hoisted(() => ({
  streams: [] as FakeChunk[][],
  createBodies: [] as Array<Record<string, unknown>>,
  vllmConfig: {} as Record<string, unknown>,
  skills: [] as Array<{ name: string; content: string }>,
}))

vi.mock('@/lib/system-services/runtime', () => ({
  resolveVllmServiceConfig: async () => ({
    baseUrl: 'http://127.0.0.1:8000',
    ...mockState.vllmConfig,
  }),
}))

vi.mock('@/lib/skills/operations', () => ({
  listSkills: async () => mockState.skills,
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
    tools: [{ name: 'list_workflows', description: 'List workflows' }],
  }),
}))

vi.mock('@/lib/copilot/local-runtime/tool-execution', () => ({
  executeLocalCopilotServerTool: async () => ({ success: true, result: { ok: true } }),
}))

import { runLocalCopilotTurn } from '@/lib/copilot/local-runtime/agent'

const sink = { send: () => {}, close: () => {}, error: () => {} }

const turn = (workspaceId?: string) =>
  runLocalCopilotTurn({
    model: 'vllm/qwen3.8-fp8',
    conversationId: 'session-1',
    userMessage: 'hello',
    contexts: [],
    priorWorkingMessages: [],
    ctx: { userId: 'user-1', accessLevel: 'full', ...(workspaceId ? { workspaceId } : {}) },
    sink,
    requestId: 'req-1',
  })

const listWorkflowsCall: FakeChunk[] = [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'call_1', function: { name: 'list_workflows', arguments: '{}' } },
          ],
        },
      },
    ],
  },
]

beforeEach(() => {
  mockState.streams = []
  mockState.createBodies = []
  mockState.vllmConfig = {}
  mockState.skills = []
})

describe('local Copilot turn settings', () => {
  it('sends no sampling overrides when nothing is configured', async () => {
    mockState.streams = [[{ choices: [{ delta: { content: 'ok' } }] }]]

    await turn()

    const body = mockState.createBodies[0]!
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('chat_template_kwargs')
  })

  it('asks the model to think and uses the configured temperature', async () => {
    mockState.vllmConfig = { copilotEnableThinking: true, copilotTemperature: 0.6 }
    mockState.streams = [[{ choices: [{ delta: { content: 'ok' } }] }]]

    await turn()

    expect(mockState.createBodies[0]).toMatchObject({
      temperature: 0.6,
      chat_template_kwargs: { enable_thinking: true },
      stream: true,
    })
  })

  it('stops after the configured number of model calls', async () => {
    mockState.vllmConfig = { copilotMaxToolIterations: 3 }
    mockState.streams = Array.from({ length: 10 }, () => listWorkflowsCall)

    await turn()

    expect(mockState.createBodies).toHaveLength(3)
  })

  it("puts the workspace's copilot-instructions skill in the system prompt", async () => {
    mockState.skills = [{ name: 'Copilot Instructions', content: 'Always use IBKR paper.' }]
    mockState.streams = [[{ choices: [{ delta: { content: 'ok' } }] }]]

    await turn('workspace-1')

    const [system] = mockState.createBodies[0]!.messages as Array<{ role: string; content: string }>
    expect(system?.role).toBe('system')
    expect(system?.content).toContain('Always use IBKR paper.')
  })
})
