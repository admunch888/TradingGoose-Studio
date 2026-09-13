import { beforeEach, describe, expect, it, vi } from 'vitest'

const loggerMock = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: () => loggerMock,
}))

import { logForecastError } from '@/lib/kronos/ledger'

describe('logForecastError', () => {
  beforeEach(() => {
    loggerMock.error.mockClear()
  })

  /**
   * The handler passed its payload to a function that does not exist, so logging a
   * failed forecast threw a ReferenceError instead of logging anything. That
   * replaced the real error with the logging failure and turned the route's
   * 503/504 mapping into a generic 502 - the failure was hardest to diagnose
   * exactly when something had already gone wrong.
   */
  it('logs a failed forecast instead of throwing', () => {
    expect(() =>
      logForecastError('req-1', new Error('boom'), { workspaceId: 'w1' })
    ).not.toThrow()

    expect(loggerMock.error).toHaveBeenCalledTimes(1)
    const [message, payload] = loggerMock.error.mock.calls[0] as [string, Record<string, unknown>]
    expect(message).toContain('Kronos forecast failed')
    expect(payload).toMatchObject({
      requestId: 'req-1',
      errorCode: 'UNKNOWN',
      errorMessage: 'boom',
      workspaceId: 'w1',
    })
  })

  it('carries a non-Error rejection through as its string form', () => {
    expect(() => logForecastError('req-2', 'plain failure', {})).not.toThrow()

    const [, payload] = loggerMock.error.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload).toMatchObject({ requestId: 'req-2', errorMessage: 'plain failure' })
  })
})
