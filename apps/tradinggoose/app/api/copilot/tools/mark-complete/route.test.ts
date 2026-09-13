/**
 * @vitest-environment node
 */

import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_COPILOT_MODEL_PREFIX } from '@/lib/copilot/local-runtime/runtime-models'
import { COPILOT_SESSION_KIND } from '@/lib/copilot/session-scope'

function createSseStream(events: unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  })
}

function createMarkCompleteRequest(data?: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/copilot/tools/mark-complete', {
    method: 'POST',
    body: JSON.stringify({
      id: 'tool-1',
      name: 'edit_workflow',
      status: 200,
      message: 'ok',
      ...(data ? { data } : {}),
    }),
  })
}

/**
 * The route resolves the runtime model from the session row it loaded, so a
 * stored model that the local runtime wrote reads back as `<prefix><model>`.
 *
 * The pre-existing `isCopilotLocalRuntimeModel` guard in the local branch
 * compares the model value the branch recovered, and the pre-fix code recovered
 * it through a helper that strips the runtime prefix. A stored model therefore
 * has to carry a repeated prefix for the guard to match and the local branch to
 * run at all. That pre-existing mismatch is untouched by this fix (it is called
 * out in the PR body); LOCAL_BRANCH_SESSION_MODEL is the shape the branch
 * requires, so the ownership gate is exercised on both the reject and the allow
 * side. LOCAL_SESSION_MODEL is the ordinary shape a local turn writes.
 */
const LOCAL_SESSION_MODEL = `${LOCAL_COPILOT_MODEL_PREFIX}llama-3`
const LOCAL_BRANCH_SESSION_MODEL = `${LOCAL_COPILOT_MODEL_PREFIX}${LOCAL_SESSION_MODEL}`

describe('Copilot mark-complete API', () => {
  let POST: typeof import('./route').POST
  const mockAuthenticateCopilotRequestSessionOnly = vi.fn()
  const mockProxyCopilotRequest = vi.fn()
  const mockLoadReviewSessionForUser = vi.fn()
  const mockPersistLocalContinuation = vi.fn()
  const mockHandleLocalCopilotContinuation = vi.fn()
  const mockLocalWorkingRows = vi.fn()
  const mockSelect = vi.fn()
  /** Model stored on the session row, used by the pre-fix model read. */
  let storedSessionModel: string | null = null

  beforeEach(async () => {
    vi.resetModules()
    mockAuthenticateCopilotRequestSessionOnly.mockReset()
    mockProxyCopilotRequest.mockReset()
    mockLoadReviewSessionForUser.mockReset()
    mockPersistLocalContinuation.mockReset()
    mockHandleLocalCopilotContinuation.mockReset()
    mockLocalWorkingRows.mockReset()
    mockSelect.mockReset()
    storedSessionModel = null

    mockAuthenticateCopilotRequestSessionOnly.mockResolvedValue({
      userId: 'user-1',
      isAuthenticated: true,
    })

    // `isLocalReviewSession` lists working items for a session: select().from().where().limit().
    mockLocalWorkingRows.mockResolvedValue([{ itemId: 'local_turn_1' }])
    mockSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLocalWorkingRows }),
      }),
    })

    mockPersistLocalContinuation.mockResolvedValue(undefined)
    mockHandleLocalCopilotContinuation.mockImplementation(async () =>
      createSseStream([
        { type: 'turn_state', status: 'completed', phase: 'completed' },
        { type: 'response.completed' },
        { type: 'stream_end' },
      ])
    )
    mockProxyCopilotRequest.mockResolvedValue(Response.json({ success: true }, { status: 200 }))

    vi.doMock('@/lib/copilot/auth', () => ({
      authenticateCopilotRequestSessionOnly: (...args: any[]) =>
        mockAuthenticateCopilotRequestSessionOnly(...args),
      createBadRequestResponse: vi.fn((message: string) =>
        Response.json({ error: message }, { status: 400 })
      ),
      createInternalServerErrorResponse: vi.fn((message: string) =>
        Response.json({ error: message }, { status: 500 })
      ),
      createNotFoundResponse: vi.fn((message: string) =>
        Response.json({ error: message }, { status: 404 })
      ),
      createRequestTracker: vi.fn(() => ({
        requestId: 'request-1',
      })),
      createUnauthorizedResponse: vi.fn(() =>
        Response.json({ error: 'Unauthorized' }, { status: 401 })
      ),
    }))

    vi.doMock('@/lib/logs/console/logger', () => ({
      createLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    }))

    vi.doMock('@/lib/copilot/completion-usage-billing', () => ({
      mirrorLocalCopilotCompletionUsageReports: vi.fn().mockResolvedValue(undefined),
    }))

    vi.doMock('@/lib/utils', () => ({
      encodeSSE: vi.fn((event: unknown) =>
        new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
      ),
      SSE_HEADERS: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    }))

    vi.doMock('@/app/api/copilot/proxy', () => ({
      getCopilotApiUrl: vi.fn(() => 'https://copilot.example.test/api/tools/mark-complete'),
      proxyCopilotRequest: (...args: any[]) => mockProxyCopilotRequest(...args),
    }))

    vi.doMock('@/lib/copilot/review-sessions/permissions', () => ({
      loadReviewSessionForUser: (...args: any[]) => mockLoadReviewSessionForUser(...args),
    }))

    vi.doMock('@/lib/copilot/local-runtime/persistence', async () => {
      const actual = await vi.importActual<
        typeof import('@/lib/copilot/local-runtime/persistence')
      >('@/lib/copilot/local-runtime/persistence')
      return {
        ...actual,
        persistLocalContinuation: (...args: any[]) => mockPersistLocalContinuation(...args),
        // The pre-fix route read the model by session id alone through this
        // helper (now folded into the ownership-checked path). It stays in the
        // mock, mirroring the original prefix-stripping behaviour, so this file
        // can also be run against the un-fixed route to confirm it fails.
        readLocalSessionModelFromMessage: async () =>
          actual.toLocalRuntimeModelName(storedSessionModel),
      }
    })

    vi.doMock('@/lib/copilot/local-runtime/chat-handler', () => ({
      handleLocalCopilotContinuation: (...args: any[]) =>
        mockHandleLocalCopilotContinuation(...args),
    }))

    vi.doMock('@tradinggoose/db', () => ({
      db: { select: mockSelect },
      copilotReviewItems: {
        sessionId: 'copilot_review_items.session_id',
        itemId: 'copilot_review_items.item_id',
      },
    }))

    ;({ POST } = await import('./route'))
  })

  it('passes through a continuation SSE stream from copilot', async () => {
    mockProxyCopilotRequest.mockResolvedValue(
      new Response(
        createSseStream([
          {
            type: 'response.output_item.added',
            item: {
              id: 'assistant-item-1',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '' }],
            },
          },
          {
            type: 'response.output_text.delta',
            item_id: 'assistant-item-1',
            delta: 'continued',
          },
          {
            type: 'response.output_item.done',
            item: {
              id: 'assistant-item-1',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'continued' }],
            },
          },
          { type: 'response.completed', response: { id: 'response-continued' } },
        ]),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        }
      )
    )

    const response = await POST(
      new NextRequest('http://localhost:3000/api/copilot/tools/mark-complete', {
        method: 'POST',
        body: JSON.stringify({
          id: 'tool-1',
          name: 'edit_workflow',
          status: 200,
          message: 'ok',
        }),
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
    expect(response.headers.get('X-Accel-Buffering')).toBe('no')
    const responseText = await response.text()
    expect(responseText).toContain('"type":"turn_state"')
    expect(responseText).toContain('"phase":"streaming"')
    expect(responseText).toContain('"phase":"completed"')
    expect(responseText).toContain('"type":"response.output_item.added"')
    expect(await mockProxyCopilotRequest.mock.calls[0]?.[0]).toEqual({
      endpoint: '/api/tools/mark-complete',
      body: {
        id: 'tool-1',
        name: 'edit_workflow',
        status: 200,
        message: 'ok',
      },
      signal: expect.any(AbortSignal),
    })
  })

  it('rejects a local continuation for a review session owned by another user', async () => {
    mockAuthenticateCopilotRequestSessionOnly.mockResolvedValue({
      userId: 'attacker-user',
      isAuthenticated: true,
    })
    // The victim's session exists, but the ownership helper resolves it as
    // inaccessible for this caller.
    mockLoadReviewSessionForUser.mockResolvedValue(null)
    storedSessionModel = LOCAL_BRANCH_SESSION_MODEL

    const response = await POST(
      createMarkCompleteRequest({ local: true, reviewSessionId: 'victim-session-id' })
    )

    expect(mockLoadReviewSessionForUser).toHaveBeenCalledWith('victim-session-id', 'attacker-user')
    expect(response.status).toBe(404)
    // Same generic body as /api/copilot/chat: the existence of the victim's
    // session must not be observable from the response.
    expect(await response.json()).toEqual({ error: 'Review session not found or unauthorized' })
    // No read of the victim's working history...
    expect(mockSelect).not.toHaveBeenCalled()
    // ...no write of the attacker's tool result into the victim's review items...
    expect(mockPersistLocalContinuation).not.toHaveBeenCalled()
    // ...no continuation run against the victim's session...
    expect(mockHandleLocalCopilotContinuation).not.toHaveBeenCalled()
    // ...and the request is not forwarded upstream either.
    expect(mockProxyCopilotRequest).not.toHaveBeenCalled()
  })

  it('rejects a local continuation for an owned session that is not a copilot chat', async () => {
    mockLoadReviewSessionForUser.mockResolvedValue({
      id: 'review-session-1',
      userId: 'user-1',
      entityKind: 'workflow',
      model: LOCAL_BRANCH_SESSION_MODEL,
    })
    storedSessionModel = LOCAL_BRANCH_SESSION_MODEL

    const response = await POST(
      createMarkCompleteRequest({ local: true, reviewSessionId: 'review-session-1' })
    )

    expect(response.status).toBe(404)
    expect(mockPersistLocalContinuation).not.toHaveBeenCalled()
    expect(mockHandleLocalCopilotContinuation).not.toHaveBeenCalled()
  })

  it('continues the local turn when the caller owns the review session', async () => {
    mockLoadReviewSessionForUser.mockResolvedValue({
      id: 'review-session-1',
      userId: 'user-1',
      entityKind: COPILOT_SESSION_KIND,
      model: LOCAL_BRANCH_SESSION_MODEL,
    })
    storedSessionModel = LOCAL_BRANCH_SESSION_MODEL

    const response = await POST(
      createMarkCompleteRequest({ local: true, reviewSessionId: 'review-session-1' })
    )

    expect(mockLoadReviewSessionForUser).toHaveBeenCalledWith('review-session-1', 'user-1')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
    expect(await response.text()).toContain('"type":"response.completed"')
    expect(mockPersistLocalContinuation).toHaveBeenCalledWith({
      reviewSessionId: 'review-session-1',
      toolCallId: 'tool-1',
      toolName: 'edit_workflow',
      status: 200,
      message: 'ok',
      data: { local: true, reviewSessionId: 'review-session-1' },
    })
    // The model is derived from the owned session row, not read back by id.
    expect(mockHandleLocalCopilotContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        model: LOCAL_SESSION_MODEL,
        reviewSessionId: 'review-session-1',
        userId: 'user-1',
      })
    )
    expect(mockProxyCopilotRequest).not.toHaveBeenCalled()
  })

  it('does not reject a local continuation for an owned session the runtime writes', async () => {
    mockLoadReviewSessionForUser.mockResolvedValue({
      id: 'review-session-1',
      userId: 'user-1',
      entityKind: COPILOT_SESSION_KIND,
      model: LOCAL_SESSION_MODEL,
    })
    storedSessionModel = LOCAL_SESSION_MODEL

    const response = await POST(
      createMarkCompleteRequest({ local: true, reviewSessionId: 'review-session-1' })
    )

    // Ownership is what this fix adds; the owner must never be turned away.
    expect(mockLoadReviewSessionForUser).toHaveBeenCalledWith('review-session-1', 'user-1')
    expect(response.status).not.toBe(404)
    expect(response.status).toBe(200)
  })
})
