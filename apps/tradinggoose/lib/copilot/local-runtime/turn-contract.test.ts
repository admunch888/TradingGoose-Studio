/**
 * The wire contract between the LOCAL runtime's SSE handler and the browser's
 * SSE client, exercised end to end: the frames the handler really emits are fed
 * through the real store that renders them.
 *
 * Neither side's own suite can catch a mismatch at this seam. The handler's
 * suite decodes frames without dispatching them, and the store's suite builds
 * its own frames - with the terminal `turn_state` placed BEFORE
 * `response.completed`, which is the opposite of what the handler emits.
 *
 * Both real defects found here lived in this gap:
 *   1. nested frames            -> every text delta dropped, reply invisible
 *   2. terminal frame ordering  -> the store breaks the read loop as soon as
 *      `response.completed` arrives, so a `turn_state: completed` that follows
 *      is never dispatched and the turn stays in_progress forever.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

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

// Drive the sink with the payloads agent.ts actually sends, including the
// function_call item's call_id/arguments (the client requires call_id).
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
      data: {
        item: {
          type: 'function_call',
          id: 'call_1',
          call_id: 'call_1',
          name: 'list_workflows',
          arguments: '{}',
        },
      },
    })
    return { text: 'Hello', workingMessages: [], awaiting: null }
  },
}))

import { handleLocalCopilotChat } from '@/lib/copilot/local-runtime/chat-handler'
import { getCopilotStore } from '@/stores/copilot/store'

async function localTurnBytes(): Promise<Uint8Array> {
  const response = await handleLocalCopilotChat({
    model: 'vllm/qwen3.8-fp8',
    message: 'hello',
    modelMessage: 'hello',
    userMessageId: 'user-item-1',
    reviewSessionId: 'session-1',
    userId: 'user-1',
    requestId: 'req-1',
  })
  return new Uint8Array(await new Response(response.body).arrayBuffer())
}

function streamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )
  )
})

afterEach(() => {
  const store = getCopilotStore('copilot-local-turn-contract')
  store.setState({ messages: [], toolCallsById: {}, isSendingMessage: false, currentChat: null })
})

describe('local turn wire contract', () => {
  it('ends the turn, so the transcript is not left in_progress', async () => {
    const bytes = await localTurnBytes()

    const store = getCopilotStore('copilot-local-turn-contract')
    store.setState({
      currentChat: null,
      chats: [],
      messages: [
        {
          id: 'assistant-local-1',
          role: 'assistant',
          content: '',
          timestamp: '2026-09-12T00:00:00.000Z',
        },
      ],
      isSendingMessage: true,
      abortController: null,
      toolCallsById: {},
    })

    await store.getState().handleStreamingResponse(streamFrom(bytes), 'assistant-local-1')

    // A finished turn. If the terminal `turn_state` never lands, this stays true
    // and the turn is persisted as in_progress forever.
    expect(store.getState().isSendingMessage).toBe(false)
  })

  it('renders the reply text', async () => {
    const bytes = await localTurnBytes()

    const store = getCopilotStore('copilot-local-turn-contract-text')
    store.setState({
      currentChat: null,
      chats: [],
      messages: [
        {
          id: 'assistant-local-2',
          role: 'assistant',
          content: '',
          timestamp: '2026-09-12T00:00:00.000Z',
        },
      ],
      isSendingMessage: true,
      abortController: null,
      toolCallsById: {},
    })

    await store.getState().handleStreamingResponse(streamFrom(bytes), 'assistant-local-2')

    const message = store.getState().messages.find((entry) => entry.id === 'assistant-local-2')
    const blocks = (message?.contentBlocks ?? []) as Array<{ type?: string; content?: string }>
    const rendered = blocks
      .filter((block) => block?.type === 'text')
      .map((block) => block.content ?? '')
      .join('')
    expect(rendered).toContain('Hello')
  })
})
