/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  selectWhere: vi.fn(),
  selectLimit: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  updateReturning: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
}))

vi.mock('@tradinggoose/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: mocks.selectWhere,
      })),
    })),
    update: vi.fn(() => ({
      set: mocks.updateSet,
    })),
  },
}))

vi.mock('@tradinggoose/db/schema', () => ({
  pendingExecution: {
    id: 'pendingExecution.id',
    payload: 'pendingExecution.payload',
  },
  workflowExecutionLogs: {
    endedAt: 'workflowExecutionLogs.endedAt',
    executionData: 'workflowExecutionLogs.executionData',
    executionId: 'workflowExecutionLogs.executionId',
    startedAt: 'workflowExecutionLogs.startedAt',
    workflowId: 'workflowExecutionLogs.workflowId',
  },
}))

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  eq: vi.fn((field: unknown, value: unknown) => ({ eq: [field, value] })),
  isNull: vi.fn((field: unknown) => ({ isNull: field })),
  lt: vi.fn((field: unknown, value: unknown) => ({ lt: [field, value] })),
  notExists: vi.fn((query: unknown) => ({ notExists: query })),
  or: vi.fn((...conditions: unknown[]) => ({ or: conditions })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: strings.join('?'),
    values,
  })),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: () => ({ error: mocks.loggerError, info: mocks.loggerInfo }),
}))

import { sweepStuckWorkflowExecutionLogs } from './stuck-execution-sweeper'

const NOW = new Date('2026-09-21T12:00:00.000Z')

const stuckRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  executionId: 'exec-stuck-1',
  workflowId: 'workflow-1',
  startedAt: new Date('2026-09-21T10:00:00.000Z'),
  ...overrides,
})

const conditions = () => mocks.selectWhere.mock.calls.map(([condition]) => condition as unknown)

const findCondition = (key: string) =>
  conditions().find(
    (condition) => typeof condition === 'object' && condition !== null && key in condition
  ) as Record<string, unknown>

const setValues = () => mocks.updateSet.mock.calls[0]?.[0] as Record<string, unknown>

describe('sweepStuckWorkflowExecutionLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.selectWhere.mockImplementation(() => ({ limit: mocks.selectLimit }))
    mocks.selectLimit.mockReset().mockResolvedValue([])
    mocks.updateSet.mockReset().mockImplementation(() => ({ where: mocks.updateWhere }))
    mocks.updateWhere.mockReset().mockImplementation(() => ({ returning: mocks.updateReturning }))
    mocks.updateReturning.mockReset().mockResolvedValue([])
  })

  it('closes a stale log that has no pending execution row', async () => {
    const row = stuckRow()
    mocks.selectLimit.mockResolvedValue([row])
    mocks.updateReturning.mockResolvedValue([{ executionId: row.executionId }])

    const result = await sweepStuckWorkflowExecutionLogs({ now: NOW })

    expect(result).toEqual({ scanned: 1, swept: [row], failed: 0, dryRun: false })
    expect(setValues()).toMatchObject({
      endedAt: NOW,
      level: 'error',
      totalDurationMs: 2 * 60 * 60 * 1000,
    })
    expect(setValues().executionData).toMatchObject({
      sql: expect.stringContaining('jsonb_set'),
    })
    expect(mocks.loggerInfo).toHaveBeenCalledOnce()
  })

  it('only considers rows older than the grace period with no queue row', async () => {
    await sweepStuckWorkflowExecutionLogs({ now: NOW })

    const where = findCondition('and')
    const guards = where.and as unknown[]

    expect(guards).toEqual(
      expect.arrayContaining([
        { isNull: 'workflowExecutionLogs.endedAt' },
        { lt: ['workflowExecutionLogs.startedAt', new Date('2026-09-21T11:00:00.000Z')] },
        { notExists: expect.anything() },
      ])
    )
    expect(guards).toHaveLength(3)
    expect(findCondition('or')).toEqual({
      or: [
        { eq: ['pendingExecution.id', 'workflowExecutionLogs.executionId'] },
        expect.objectContaining({
          values: ['pendingExecution.payload', 'workflowExecutionLogs.executionId'],
        }),
      ],
    })
    expect(mocks.selectLimit).toHaveBeenCalledWith(50)
  })

  it('reports a candidate without writing when dryRun is set', async () => {
    const row = stuckRow()
    mocks.selectLimit.mockResolvedValue([row])

    const result = await sweepStuckWorkflowExecutionLogs({ now: NOW, dryRun: true })

    expect(result).toEqual({ scanned: 1, swept: [row], failed: 0, dryRun: true })
    expect(mocks.updateSet).not.toHaveBeenCalled()
  })

  it('does not report a log that a real completion closed first', async () => {
    mocks.selectLimit.mockResolvedValue([stuckRow()])
    mocks.updateReturning.mockResolvedValue([])

    const result = await sweepStuckWorkflowExecutionLogs({ now: NOW })

    expect(result).toEqual({ scanned: 1, swept: [], failed: 0, dryRun: false })
    expect(mocks.updateReturning).toHaveBeenCalledOnce()
    expect(mocks.loggerInfo).not.toHaveBeenCalled()
    expect(mocks.updateWhere).toHaveBeenCalledWith(
      expect.objectContaining({
        and: expect.arrayContaining([{ isNull: 'workflowExecutionLogs.endedAt' }]),
      })
    )
  })

  it('continues sweeping later rows when one row fails to update', async () => {
    const failing = stuckRow({ executionId: 'exec-failing' })
    const succeeding = stuckRow({ executionId: 'exec-succeeding' })
    mocks.selectLimit.mockResolvedValue([failing, succeeding])
    mocks.updateReturning
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce([{ executionId: succeeding.executionId }])

    const result = await sweepStuckWorkflowExecutionLogs({ now: NOW })

    expect(result).toEqual({ scanned: 2, swept: [succeeding], failed: 1, dryRun: false })
    expect(mocks.updateReturning).toHaveBeenCalledTimes(2)
    expect(mocks.loggerError).toHaveBeenCalledWith(
      'Failed to sweep stuck workflow execution log',
      expect.objectContaining({ executionId: 'exec-failing' })
    )
    expect(mocks.loggerInfo).toHaveBeenCalledOnce()
  })

  it('honors a caller supplied grace period and limit', async () => {
    await sweepStuckWorkflowExecutionLogs({ now: NOW, graceMs: 5 * 60 * 1000, limit: 5 })

    expect(findCondition('and').and).toEqual(
      expect.arrayContaining([
        { lt: ['workflowExecutionLogs.startedAt', new Date('2026-09-21T11:55:00.000Z')] },
      ])
    )
    expect(mocks.selectLimit).toHaveBeenCalledWith(5)
  })
})
