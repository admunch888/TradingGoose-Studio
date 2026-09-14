import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeSSE } from '@/lib/utils'
import { getCopilotStore } from '@/stores/copilot/store'

/**
 * A self-hosted Copilot turn as the browser receives it. The first stream
 * (chat-handler.ts handleLocalCopilotChat) hands `plan` to the browser and
 * ends; the browser runs `plan`, posts mark-complete, and must render the
 * resumed turn mark-complete streams back.
 *
 * The first stream settled the turn as completed as soon as `plan` succeeded,
 * before mark-complete returned, and the continuation handler then cancelled
 * the resumed stream because the turn no longer read as in progress. Every
 * turn stopped after "Finished planning".
 *
 * Each test uses its own tool call id: client tool instances are kept per id.
 */

const streamEvents: string[] = []

function sseStream(events: unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encodeSSE(event))
      controller.close()
    },
  })
}

/** A stream that records whether the browser cancelled it. */
function tracedStream(events: unknown[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index >= events.length) {
          controller.close()
          return
        }
        controller.enqueue(encodeSSE(events[index++]))
      },
      cancel() {
        streamEvents.push('cancelled')
      },
    },
    { highWaterMark: 0 }
  )
}

/** Frames handleLocalCopilotChat sends for a turn that stops for plan. */
const firstTurnFrames = (reviewSessionId: string, toolCallId: string) => [
  { type: 'review_session_id', reviewSessionId },
  { type: 'start', data: { conversationId: reviewSessionId } },
  { type: 'turn_state', status: 'in_progress', phase: 'streaming' },
  {
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      id: toolCallId,
      call_id: toolCallId,
      name: 'plan',
      arguments: '{"objective":"Build the MES workflow","todoList":["Add blocks"]}',
    },
  },
  { type: 'awaiting_tools', toolCallId, toolName: 'plan' },
  { type: 'turn_state', status: 'in_progress', phase: 'waiting_for_tools' },
  { type: 'stream_end' },
]

/** Frames handleLocalCopilotContinuation sends for a resumed turn that replies. */
const continuationFrames = [
  { type: 'turn_state', status: 'in_progress', phase: 'streaming' },
  { type: 'response.output_text.delta', item_id: 'local_assistant_text', delta: 'Building now.' },
  { type: 'turn_state', status: 'completed', phase: 'completed' },
  { type: 'response.completed' },
  { type: 'stream_end' },
]

function installFetch(options: { beforeContinuation?: () => void } = {}) {
  streamEvents.length = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url === '/api/copilot/tools/mark-complete') {
      options.beforeContinuation?.()
      return new Response(tracedStream(continuationFrames), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response(JSON.stringify({ success: true, chats: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  return fetchMock
}

const calledUrls = (fetchMock: ReturnType<typeof installFetch>) =>
  fetchMock.mock.calls.map(([input]) => (typeof input === 'string' ? input : input.toString()))

afterEach(() => vi.unstubAllGlobals())

const chat = (reviewSessionId: string) =>
  ({
    reviewSessionId,
    workspaceId: 'workspace-1',
    entityKind: 'copilot',
    entityId: null,
    draftSessionId: null,
    title: 'MES workflow',
    messages: [],
    messageCount: 0,
    conversationId: null,
    latestTurnStatus: 'in_progress',
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
    updatedAt: new Date('2026-09-14T00:00:00.000Z'),
  }) as any

function startStore(channelId: string, currentChat: unknown, messageId: string) {
  const store = getCopilotStore(channelId)
  store.setState({
    accessLevel: 'full',
    selectedModel: 'vllm/qwen3.8-fp8',
    currentChat,
    chats: [],
    messages: [
      { id: messageId, role: 'assistant', content: '', timestamp: '2026-09-14T00:00:00.000Z' },
    ],
    isSendingMessage: true,
    abortController: new AbortController(),
    toolCallsById: {},
  } as any)
  return store
}

describe('self-hosted Copilot turn resumed after plan', () => {
  it('renders the resumed turn in an existing chat', async () => {
    const fetchMock = installFetch()
    const store = startStore('local-continuation-existing', chat('review-existing'), 'assistant-1')

    await store
      .getState()
      .handleStreamingResponse(
        sseStream(firstTurnFrames('review-existing', 'call_plan_existing')),
        'assistant-1'
      )

    await vi.waitFor(() => expect(store.getState().messages[0]?.content).toContain('Building now.'))
    expect(calledUrls(fetchMock)).toContain('/api/copilot/tools/mark-complete')
    expect(streamEvents).not.toContain('cancelled')
    expect(store.getState().currentChat?.latestTurnStatus).toBe('completed')
  })

  it('renders the resumed turn in a new chat', async () => {
    installFetch()
    const store = startStore('local-continuation-new', null, 'assistant-2')

    await store
      .getState()
      .handleStreamingResponse(
        sseStream(firstTurnFrames('review-new', 'call_plan_new')),
        'assistant-2'
      )

    await vi.waitFor(() => expect(store.getState().messages[0]?.content).toContain('Building now.'))
    expect(streamEvents).not.toContain('cancelled')
  })

  it('drops the resumed turn when Stop was pressed after plan finished', async () => {
    let store: ReturnType<typeof getCopilotStore> | null = null
    // Stop pressed while the turn still shows as running, after plan posted
    // its completion and before the resumed turn arrived.
    installFetch({
      beforeContinuation: () => {
        store?.setState({ isSendingMessage: true })
        store?.getState().abortMessage()
      },
    })
    store = startStore('local-continuation-stopped', chat('review-stopped'), 'assistant-3')

    await store
      .getState()
      .handleStreamingResponse(
        sseStream(firstTurnFrames('review-stopped', 'call_plan_stopped')),
        'assistant-3'
      )

    await vi.waitFor(() => expect(streamEvents).toEqual(['cancelled']))
    expect(store.getState().messages[0]?.content).not.toContain('Building now.')
  })
})
