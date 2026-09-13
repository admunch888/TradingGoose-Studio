/**
 * Staged reviews must SURFACE on the local runtime, not be dropped.
 *
 * A local turn runs the agent in-process (local-runtime/agent.ts) and streams
 * its frames to the same store the managed runtime streams to. When a server
 * tool stages a mutation for approval it returns
 * `{ requiresReview: true, reviewToken, reviewBaseStateHash, ... }` and nothing
 * is written until the review is accepted. tool-execution.ts already separates
 * that metadata into `result.review`, but agent.ts built the `tool_result`
 * frame from `result.result` alone - so the browser saw a plain success, never
 * entered its review state, and the mutation could not be approved. The same
 * omission hid `requiresReview` from the model, contradicting the operating
 * rule in prompt.ts ("When a tool result says `requiresReview: true`, ... wait").
 *
 * Nothing else pins this seam: tool-execution's own suite never sees the frame,
 * and the store's suite builds its own frames. So this test runs the REAL
 * handler -> agent -> tool-execution stack (only the vLLM client and the server
 * tool implementation are stubbed), feeds the bytes it really emits into the
 * REAL store, and then approves the review the way the UI's Accept button does.
 *
 * The stubbed `routeExecution` stands in for any mutation tool that stages
 * (`base-tool.ts` -> `shouldStageServerToolMutationForReview`); staging happens
 * whenever the turn is not run at 'full', which is why the level itself is
 * pinned by chat-handler.test.ts and store.test.ts, and the SURFACE from there
 * out is pinned here.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const REVIEW_TOKEN = 'review-token-local-1'
const ENTITY_DOCUMENT = 'flowchart TD'
const STAGED_TOOL_ARGS = JSON.stringify({ entityId: 'wf-1', entityDocument: ENTITY_DOCUMENT })

const server = vi.hoisted(() => ({
  /** The public result a real mutation tool returns when it stages. */
  stagedResult: {
    requiresReview: true,
    reviewBaseStateHash: 'base-hash-1',
    entityKind: 'workflow',
    entityId: 'wf-1',
    entityDocument: 'flowchart TD',
    documentFormat: 'tg-workflow-graph-mermaid-v1',
    message: 'Workflow edit staged for review',
  } as Record<string, unknown>,
  /** The public result of the same tool when the mutation is applied. */
  appliedResult: {
    success: true,
    entityKind: 'workflow',
    entityId: 'wf-1',
    message: 'Workflow updated',
  } as Record<string, unknown>,
  /** false -> the tool applies immediately (the 'full' path #16 established). */
  stage: true,
  accessLevels: [] as Array<string | undefined>,
  persistedWorkingMessages: [] as Array<Record<string, unknown> & { content?: unknown }>,
}))

vi.mock('@tradinggoose/db', () => {
  const rows: unknown[] = []
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    values: () => chain,
    set: () => chain,
    onConflictDoNothing: () => chain,
    returning: () => chain,
    execute: () => chain,
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  }
  const db = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
    execute: () => chain,
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  }
  return { db, copilotReviewSessions: {}, copilotReviewItems: {} }
})

// The real handler persists the working history the model replays; capture it
// instead of round-tripping it through the stubbed db, so the model-facing
// contract can be asserted.
vi.mock('@/lib/copilot/local-runtime/persistence', () => ({
  persistLocalWorkingMessage: async ({ message }: { message: Record<string, unknown> }) => {
    server.persistedWorkingMessages.push(message)
  },
  persistLocalWorkingUserMessage: async () => {},
  persistLocalWorkingAssistantMessage: async () => {},
  persistLocalReviewMessage: async () => {},
  appendLocalAssistantText: async () => {},
  loadLocalWorkingMessages: async () => [],
}))

// The tool implementation: the staging branch is what the review machinery is
// for, and it mirrors base-tool.ts by returning `requiresReview` + base state.
vi.mock('@/lib/copilot/tools/server/router', () => ({
  routeExecution: async (
    _toolName: string,
    _payload: unknown,
    context?: { accessLevel?: string }
  ) => {
    server.accessLevels.push(context?.accessLevel)
    return server.stage ? { ...server.stagedResult } : { ...server.appliedResult }
  },
}))

// The real staging gate mints the token; here it mirrors that: strip the base
// hash from the public result and hand back a token for the stored review.
vi.mock('@/lib/copilot/tools/server/review-acceptance', () => ({
  stageServerManagedToolReview: async (_toolName: string, _payload: unknown, result: unknown) => {
    const record = (result ?? {}) as Record<string, unknown>
    if (record.requiresReview !== true) return result
    const { reviewBaseStateHash: _reviewBaseStateHash, ...publicResult } = record
    return { ...publicResult, reviewToken: REVIEW_TOKEN }
  },
  acceptServerManagedToolReview: async () => ({ ...server.appliedResult }),
}))

vi.mock('@/lib/copilot/runtime-tool-manifest', () => ({
  getCopilotRuntimeToolManifest: async () => ({
    tools: [
      {
        name: 'edit_workflow',
        description: 'Edit a workflow document',
        parameters: {
          type: 'object',
          properties: { entityId: { type: 'string' }, entityDocument: { type: 'string' } },
        },
      },
    ],
  }),
}))

vi.mock('@/lib/system-services/runtime', () => ({
  resolveVllmServiceConfig: async () => ({ baseUrl: 'http://127.0.0.1:8000' }),
}))

// A scripted self-hosted model: iteration 1 calls edit_workflow, iteration 2
// answers. Nothing else about the loop is stubbed.
const llm = vi.hoisted(() => ({ iterations: 0 }))

vi.mock('openai', () => {
  class FakeOpenAI {
    chat = {
      completions: {
        create: async () => {
          const iteration = llm.iterations++
          if (iteration === 0) {
            return (async function* toolCallStream() {
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call-1',
                          function: { name: 'edit_workflow', arguments: STAGED_TOOL_ARGS },
                        },
                      ],
                    },
                  },
                ],
              }
            })()
          }
          return (async function* textStream() {
            yield { choices: [{ delta: { content: 'Staged for your approval.' } }] }
          })()
        },
      },
    }
  }
  return { default: FakeOpenAI }
})

import { handleLocalCopilotChat } from '@/lib/copilot/local-runtime/chat-handler'
import { ClientToolCallState } from '@/lib/copilot/tools/client/base-tool'
import { getCopilotStore } from '@/stores/copilot/store'

type Frame = Record<string, unknown>

async function runLocalTurn(): Promise<{ frames: Frame[]; bytes: Uint8Array }> {
  const response = await handleLocalCopilotChat({
    model: 'vllm/qwen3.8-fp8',
    message: 'edit wf-1',
    modelMessage: 'edit wf-1',
    userMessageId: 'user-item-1',
    reviewSessionId: 'session-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    requestId: 'req-1',
  })
  const bytes = new Uint8Array(await new Response(response.body).arrayBuffer())
  const text = new TextDecoder().decode(bytes)
  const frames = text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)) as Frame)
  return { frames, bytes }
}

function streamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function freshStore(channel: string) {
  const store = getCopilotStore(channel)
  store.setState({
    currentChat: null,
    chats: [],
    accessLevel: 'full',
    messages: [
      {
        id: `${channel}-message`,
        role: 'assistant',
        content: '',
        timestamp: '2026-09-12T00:00:00.000Z',
      },
    ],
    isSendingMessage: true,
    abortController: null,
    toolCallsById: {},
  })
  return store
}

beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

beforeEach(() => {
  llm.iterations = 0
  server.stage = true
  server.accessLevels = []
  server.persistedWorkingMessages = []
})

describe('local runtime staged-review surface', () => {
  it('carries the staged review metadata on the tool_result frame', async () => {
    server.stage = true
    const { frames } = await runLocalTurn()

    const toolResult = frames.find((frame) => frame.type === 'tool_result')
    expect(toolResult?.toolCallId).toBe('call-1')
    expect(toolResult?.requiresReview).toBe(true)
    expect(toolResult?.reviewToken).toBe(REVIEW_TOKEN)
    // The preview is what the staged tool returned minus its private fields.
    expect(toolResult?.preview).toMatchObject({ entityId: 'wf-1', entityKind: 'workflow' })
    expect((toolResult?.preview as Record<string, unknown>)?.reviewToken).toBeUndefined()

    // The model's contract (prompt.ts: react to `requiresReview: true`) has to
    // hold too, but the token is a user-facing approval handle: never send it.
    const toolMessage = server.persistedWorkingMessages.find((message) => message.role === 'tool')
    const content = JSON.parse(String(toolMessage?.content))
    expect(content.ok).toBe(true)
    expect(content.requiresReview).toBe(true)
    expect(JSON.stringify(content)).not.toContain(REVIEW_TOKEN)
  })

  it('leaves the client tool call in review state with a usable token', async () => {
    server.stage = true
    const { bytes } = await runLocalTurn()

    const store = freshStore('copilot-local-review-surface')
    await store
      .getState()
      .handleStreamingResponse(streamFrom(bytes), 'copilot-local-review-surface-message')

    // Before the fix this was `success`: the browser never entered the review
    // flow, so the staged mutation could not be approved at all.
    const toolCall = store.getState().toolCallsById['call-1']
    expect(toolCall?.state).toBe(ClientToolCallState.review)
    const result = toolCall?.result as Record<string, unknown> | undefined
    expect(result?.requiresReview).toBe(true)
    expect(result?.reviewToken).toBe(REVIEW_TOKEN)
    expect(result?.entityId).toBe('wf-1')
  })

  it('approves the surfaced token through the existing review accept path', async () => {
    server.stage = true
    const { bytes } = await runLocalTurn()

    const store = freshStore('copilot-local-review-accept')
    await store
      .getState()
      .handleStreamingResponse(streamFrom(bytes), 'copilot-local-review-accept-message')
    expect(store.getState().toolCallsById['call-1']?.state).toBe(ClientToolCallState.review)

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/copilot/execute-copilot-server-tool') {
        return new Response(JSON.stringify({ success: true, result: server.appliedResult }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    // What the UI's Accept button (inline-tool-call.tsx) calls.
    await store.getState().executeCopilotToolCall('call-1')

    const acceptCall = fetchMock.mock.calls.find(([input]) => {
      const url = typeof input === 'string' ? input : input.toString()
      return url === '/api/copilot/execute-copilot-server-tool'
    })
    expect(acceptCall).toBeDefined()
    const body = JSON.parse(String((acceptCall?.[1] as RequestInit).body))
    expect(body.reviewAction).toBe('accept')
    expect(body.reviewToken).toBe(REVIEW_TOKEN)
    expect(store.getState().toolCallsById['call-1']?.state).toBe(ClientToolCallState.success)
  })

  /**
   * #16 made local turns execute at 'full' so mutations apply instead of being
   * stranded. That default stays: this is what fails if someone "fixes" the
   * review surface by lowering the level again.
   */
  it('still applies full-access mutations normally, without a review', async () => {
    server.stage = false
    const { frames, bytes } = await runLocalTurn()

    expect(server.accessLevels).toContain('full')
    const toolResult = frames.find((frame) => frame.type === 'tool_result')
    expect(toolResult?.requiresReview).toBeUndefined()
    expect(toolResult?.reviewToken).toBeUndefined()

    const store = freshStore('copilot-local-full-access-apply')
    await store
      .getState()
      .handleStreamingResponse(streamFrom(bytes), 'copilot-local-full-access-apply-message')

    const toolCall = store.getState().toolCallsById['call-1']
    expect(toolCall?.state).toBe(ClientToolCallState.success)
    expect(toolCall?.result).toEqual(server.appliedResult)
  })
})
