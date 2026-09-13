/**
 * Finding A regression suite for the local Copilot runtime.
 *
 * The browser-handoff path (`awaiting_tools` -> `/api/copilot/tools/mark-complete`
 * -> `handleLocalCopilotContinuation`) was unreachable for two independent
 * reasons, and BOTH are covered here:
 *
 *   1. `buildOpenAiTools` filtered the client-only tools out of the schema sent
 *      to the model, so a schema-conforming model could never emit one even
 *      though the system prompt tells it to.
 *   2. `response.output_item.done` (the function_call frame) was only emitted
 *      inside the server-tool execution loop, i.e. AFTER the client-only early
 *      return. The browser derives the tool it must run from that frame alone
 *      (stores/copilot/streaming.ts is the only writer of
 *      `pendingAutoExecutionToolCallIds`), so un-filtering the schema without
 *      also emitting the frame leaves a turn stuck in `waiting_for_tools`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeChunk = { choices: Array<{ delta: Record<string, unknown> }> }

const mockState = vi.hoisted(() => ({
  /** One scripted stream per `chat.completions.create` call, consumed in order. */
  streams: [] as FakeChunk[][],
  /** Every request body handed to the (mocked) vLLM client. */
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

// Mirrors the real manifest: the client-only tools are present in it. The bug
// was in the schema builder, not the manifest.
vi.mock('@/lib/copilot/runtime-tool-manifest', () => ({
  getCopilotRuntimeToolManifest: async () => ({
    version: 'v1',
    tools: [
      { name: 'list_workflows', description: 'List workflows' },
      { name: 'create_workflow', description: 'Create a workflow' },
      { name: 'run_workflow', description: 'Run a workflow', parameters: { type: 'object' } },
      { name: 'plan', description: 'Propose a plan', parameters: { type: 'object' } },
      { name: 'checkoff_todo', description: 'Check off a todo', parameters: { type: 'object' } },
      {
        name: 'mark_todo_in_progress',
        description: 'Mark a todo in progress',
        parameters: { type: 'object' },
      },
      {
        name: 'gdrive_request_access',
        description: 'Request Drive access',
        parameters: { type: 'object' },
      },
      {
        name: 'oauth_request_access',
        description: 'Request OAuth access',
        parameters: { type: 'object' },
      },
      { name: 'deploy_workflow', description: 'Deploy a workflow', parameters: { type: 'object' } },
      { name: 'sleep', description: 'Wait', parameters: { type: 'object' } },
    ],
  }),
}))

vi.mock('@/lib/copilot/local-runtime/tool-execution', () => ({
  executeLocalCopilotServerTool: async () => ({ success: true, result: { ok: true } }),
}))

import { LOCAL_CLIENT_ONLY_TOOLS, runLocalCopilotTurn } from '@/lib/copilot/local-runtime/agent'
import type { LocalSseEventSink } from '@/lib/copilot/local-runtime/types'

function recorder() {
  const frames: Array<Record<string, unknown>> = []
  const sink: LocalSseEventSink = {
    send: (payload: Record<string, unknown>) => {
      frames.push(payload)
    },
    close: () => {},
    error: () => {},
  }
  return { frames, sink }
}

function turnParams(sink: LocalSseEventSink) {
  return {
    model: 'vllm/qwen3.8-fp8',
    conversationId: 'session-1',
    userMessage: 'hello',
    contexts: [],
    fileContents: [],
    priorWorkingMessages: [],
    ctx: { userId: 'user-1', accessLevel: 'full' as const },
    sink,
    requestId: 'req-1',
  }
}

function toolCallChunks(name: string, id: string, args = '{}'): FakeChunk[] {
  return [
    { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] },
  ]
}

function functionCallFrames(frames: Array<Record<string, unknown>>, name: string) {
  return frames
    .filter((frame) => frame.event === 'response.output_item.done')
    .map((frame) => frame.data as { item?: Record<string, unknown> })
    .filter((data) => data?.item?.name === name)
}

beforeEach(() => {
  mockState.streams = []
  mockState.createBodies = []
})

describe('local agent client-only tool handoff', () => {
  it('offers the client-only tools to the model', async () => {
    mockState.streams = [[{ choices: [{ delta: { content: 'ok' } }] }]]
    const { sink } = recorder()

    await runLocalCopilotTurn(turnParams(sink))

    const tools = mockState.createBodies[0]?.tools as Array<{
      function: { name: string }
    }>
    const names = tools.map((tool) => tool.function.name)

    // The prompt tells the model to call these (prompt.ts); hiding them from the
    // schema made every one of them uncallable.
    for (const clientOnly of LOCAL_CLIENT_ONLY_TOOLS) {
      expect(names).toContain(clientOnly)
    }
    expect(names).toContain('list_workflows')
  })

  it('emits the function_call frame before halting on a client-only call', async () => {
    mockState.streams = [toolCallChunks('run_workflow', 'call_abc', '{"workflowId":"w1"}')]
    const { frames, sink } = recorder()

    const result = await runLocalCopilotTurn(turnParams(sink))

    expect(result.awaiting).toEqual({ toolCallId: 'call_abc', toolName: 'run_workflow' })

    // The browser executes the call from this frame; without it the turn waits
    // for a tool call the client never saw.
    const items = functionCallFrames(frames, 'run_workflow')
    expect(items).toHaveLength(1)
    expect(items[0]?.item).toMatchObject({
      type: 'function_call',
      id: 'call_abc',
      call_id: 'call_abc',
      name: 'run_workflow',
    })
  })

  it('still emits the frame and executes server tools', async () => {
    mockState.streams = [
      toolCallChunks('list_workflows', 'call_srv'),
      [{ choices: [{ delta: { content: 'done' } }] }],
    ]
    const { frames, sink } = recorder()

    const result = await runLocalCopilotTurn(turnParams(sink))

    expect(result.awaiting).toBeNull()
    const items = functionCallFrames(frames, 'list_workflows')
    expect(items[0]?.item?.call_id).toBe('call_srv')
    expect(frames.some((frame) => frame.event === 'tool_result')).toBe(true)
  })
})
