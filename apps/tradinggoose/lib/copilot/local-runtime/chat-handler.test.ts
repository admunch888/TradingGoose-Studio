import { describe, expect, it, vi } from 'vitest'

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
    sink: { send: (payload: Record<string, unknown>) => void }
  }) => {
    params.sink.send({
      event: 'response.output_text.delta',
      data: { item_id: 'local_assistant_text', delta: 'Hello' },
    })
    params.sink.send({
      event: 'response.output_item.done',
      data: { item: { type: 'function_call', id: 'call_1', name: 'list_workflows' } },
    })
    return { text: 'Hello', workingMessages: [], awaiting: null }
  },
}))

import { handleLocalCopilotChat } from '@/lib/copilot/local-runtime/chat-handler'

async function readFrames(response: Response) {
  const text = await new Response(response.body).text()
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>)
}

function startTurn() {
  return handleLocalCopilotChat({
    model: 'vllm/qwen3.8-fp8',
    message: 'hello',
    modelMessage: 'hello',
    userMessageId: 'user-item-1',
    reviewSessionId: 'session-1',
    userId: 'user-1',
    requestId: 'req-1',
  })
}

describe('local copilot chat handler', () => {
  it('returns headers that forbid transforming the stream', async () => {
    const response = await startTurn()

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('cache-control')).toContain('no-transform')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect(response.headers.get('connection')).toBe('keep-alive')
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
})
