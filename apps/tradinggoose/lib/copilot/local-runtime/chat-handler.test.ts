import { describe, expect, it, vi } from 'vitest'

vi.mock('@tradinggoose/db', () => ({
  db: {
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    select: () => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
    }),
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
  },
  copilotReviewSessions: {},
  copilotReviewItems: {},
}))

import { handleLocalCopilotChat } from '@/lib/copilot/local-runtime/chat-handler'

/**
 * A streamed reply must be un-transformable. Without `no-transform`, compression
 * middleware and intermediaries buffer the stream and the user sees the reply arrive
 * in one lump at the end (or not at all behind a proxy) - which is exactly the
 * "CoPilot never answers" symptom this pins.
 */
describe('local copilot chat handler SSE contract', () => {
  it('returns headers that forbid transforming the stream', async () => {
    const response = await handleLocalCopilotChat({
      model: 'vllm/qwen3.8-fp8',
      message: 'hello',
      modelMessage: 'hello',
      userMessageId: 'user-item-1',
      reviewSessionId: 'session-1',
      userId: 'user-1',
      requestId: 'req-1',
    })

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('cache-control')).toContain('no-transform')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect(response.headers.get('connection')).toBe('keep-alive')
  })
})
