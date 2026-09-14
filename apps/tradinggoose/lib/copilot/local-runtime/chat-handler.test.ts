import { beforeEach, describe, expect, it, vi } from 'vitest'

type TurnResult = {
  text: string
  workingMessages: Array<Record<string, unknown>>
  awaiting: { toolCallId: string; toolName: string } | null
}

const turnState = vi.hoisted(() => ({
  result: { text: 'Hello', workingMessages: [], awaiting: null } as TurnResult,
  /** Text of each working-history reply the handler saved. */
  workingReplies: [] as string[],
}))

const capturedTurnCtx = vi.hoisted(() => ({
  accessLevel: undefined as string | undefined,
  contextEntityKind: undefined as string | undefined,
  contextEntityId: undefined as string | undefined,
  workspaceId: undefined as string | undefined,
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

// Drive the sink with the exact payloads agent.ts sends.
vi.mock('@/lib/copilot/local-runtime/agent', () => ({
  runLocalCopilotTurn: async (params: {
    ctx?: {
      accessLevel?: string
      contextEntityKind?: string
      contextEntityId?: string
      workspaceId?: string
    }
    sink: { send: (payload: Record<string, unknown>) => void }
  }) => {
    capturedTurnCtx.accessLevel = params.ctx?.accessLevel
    capturedTurnCtx.contextEntityKind = params.ctx?.contextEntityKind
    capturedTurnCtx.contextEntityId = params.ctx?.contextEntityId
    capturedTurnCtx.workspaceId = params.ctx?.workspaceId
    params.sink.send({
      event: 'response.output_text.delta',
      data: { item_id: 'local_assistant_text', delta: 'Hello' },
    })
    params.sink.send({
      event: 'response.output_item.done',
      data: { item: { type: 'function_call', id: 'call_1', name: 'list_workflows' } },
    })
    return turnState.result
  },
}))

vi.mock('@/lib/copilot/local-runtime/persistence', () => ({
  persistLocalWorkingMessage: async () => {},
  persistLocalWorkingUserMessage: async () => {},
  persistLocalWorkingAssistantMessage: async (params: { text: string }) => {
    turnState.workingReplies.push(params.text)
  },
  persistLocalReviewMessage: async () => {},
  appendLocalAssistantText: async () => {},
  loadLocalWorkingMessages: async () => [{ role: 'user', content: 'Build the workflow' }],
}))

import {
  handleLocalCopilotChat,
  handleLocalCopilotContinuation,
} from '@/lib/copilot/local-runtime/chat-handler'

async function readFrames(response: Response) {
  const text = await new Response(response.body).text()
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>)
}

function startTurn(
  params: { contextEntityKind?: string; contextEntityId?: string; workspaceId?: string } = {}
) {
  return handleLocalCopilotChat({
    model: 'vllm/qwen3.8-fp8',
    message: 'hello',
    modelMessage: 'hello',
    userMessageId: 'user-item-1',
    reviewSessionId: 'session-1',
    userId: 'user-1',
    requestId: 'req-1',
    ...params,
  })
}

describe('local copilot chat handler', () => {
  beforeEach(() => {
    capturedTurnCtx.accessLevel = undefined
    capturedTurnCtx.contextEntityKind = undefined
    capturedTurnCtx.contextEntityId = undefined
    capturedTurnCtx.workspaceId = undefined
    turnState.result = { text: 'Hello', workingMessages: [], awaiting: null }
    turnState.workingReplies = []
  })

  it('returns headers that forbid transforming the stream', async () => {
    const response = await startTurn()

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('cache-control')).toContain('no-transform')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect(response.headers.get('connection')).toBe('keep-alive')
  })

  /**
   * At 'limited' every mutating tool stages a review (access-policy.ts: only
   * 'full' auto-executes) and returns `{ requiresReview: true, ... }` with no
   * entityId and no database write. Nothing in the local path can accept one, so
   * mutations were stranded while still reporting success: create_workflow then
   * produced zero rows and no id, five times over. This fails if the level is
   * ever lowered back to 'limited'.
   */
  it('executes local turns at full access so mutations are applied, not staged', async () => {
    // The handler streams, so the turn (and therefore the tool context) only runs
    // once the body is read.
    await readFrames(await startTurn())

    expect(capturedTurnCtx.accessLevel).toBe('full')
  })

  /**
   * The client dispatches on the frame and reads fields straight off it
   * (streaming.ts: `typeof data?.delta !== 'string'` -> return). Nesting the agent's
   * payload under `data` made every delta invisible: the reply was persisted but the
   * user saw nothing. These assertions fail on the nested shape.
   */
  it('emits flat frames the client can read', async () => {
    const frames = await readFrames(await startTurn())

    const delta = frames.find((frame) => frame.type === 'response.output_text.delta')
    expect(delta?.item_id).toBe('local_assistant_text')
    expect(delta?.delta).toBe('Hello')

    const done = frames.find((frame) => frame.type === 'response.output_item.done')
    expect((done?.item as Record<string, unknown>)?.name).toBe('list_workflows')
  })

  /**
   * The route derives the open entity from the request's contexts (the managed
   * client's source of truth) and hands it to the turn; every ctx field has to
   * land, or the in-process server tools cannot target it.
   */
  it('carries the turn entity context into the agent context', async () => {
    await readFrames(
      await startTurn({
        contextEntityKind: 'workflow',
        contextEntityId: 'wf-open',
        workspaceId: 'workspace-1',
      })
    )

    expect(capturedTurnCtx).toMatchObject({
      accessLevel: 'full',
      contextEntityKind: 'workflow',
      contextEntityId: 'wf-open',
      workspaceId: 'workspace-1',
    })
  })

  /**
   * Safety: a turn with no entity context must stay that way - no field may be
   * fabricated, so the tools keep requiring an explicit id.
   */
  it('passes no entity context when the turn has none', async () => {
    await readFrames(await startTurn({ workspaceId: 'workspace-1' }))

    expect(capturedTurnCtx.contextEntityId).toBeUndefined()
    expect(capturedTurnCtx.contextEntityKind).toBeUndefined()
    expect(capturedTurnCtx.workspaceId).toBe('workspace-1')
  })

  const planStep = {
    role: 'assistant',
    content: 'Planning the workflow',
    tool_calls: [
      { id: 'call_plan', type: 'function', function: { name: 'plan', arguments: '{}' } },
    ],
  }

  /**
   * The step's text is saved with its plan call. Saving the turn's text as a
   * reply as well put it between the call and the result the browser sends
   * back, and SGLang refused the resumed request.
   */
  it('saves no working reply for a turn that stops for a browser tool', async () => {
    turnState.result = {
      text: 'Planning the workflow',
      workingMessages: [{ role: 'user', content: 'Build the workflow' }, planStep],
      awaiting: { toolCallId: 'call_plan', toolName: 'plan' },
    }

    await readFrames(await startTurn())

    expect(turnState.workingReplies).toEqual([])
  })

  it('saves only the final reply of a finished turn', async () => {
    turnState.result = {
      text: 'Checking blocks. The workflow is ready.',
      workingMessages: [
        { role: 'user', content: 'Build the workflow' },
        { ...planStep, content: 'Checking blocks. ' },
        { role: 'tool', tool_call_id: 'call_plan', content: '{"ok":true}' },
        { role: 'assistant', content: 'The workflow is ready.' },
      ],
      awaiting: null,
    }

    await readFrames(await startTurn())

    expect(turnState.workingReplies).toEqual(['The workflow is ready.'])
  })

  it('saves no working reply when a continuation stops for another browser tool', async () => {
    turnState.result = {
      text: 'Planning again',
      workingMessages: [{ role: 'user', content: 'Build the workflow' }, planStep],
      awaiting: { toolCallId: 'call_plan', toolName: 'plan' },
    }

    const stream = await handleLocalCopilotContinuation({
      model: 'qwen3.8-fp8',
      reviewSessionId: 'session-1',
      userId: 'user-1',
      requestId: 'req-1',
      continuation: { toolCallId: 'call_previous', toolName: 'plan', status: 200 },
    })
    await new Response(stream).text()

    expect(turnState.workingReplies).toEqual([])
  })
})
