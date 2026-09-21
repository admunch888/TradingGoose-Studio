import { db } from '@tradinggoose/db'
import { pendingExecution, workflowExecutionLogs } from '@tradinggoose/db/schema'
import { and, eq, isNull, lt, notExists, or, sql } from 'drizzle-orm'
import { createLogger } from '@/lib/logs/console/logger'

const logger = createLogger('StuckExecutionSweeper')

export const DEFAULT_STUCK_EXECUTION_GRACE_MS = 60 * 60 * 1000
export const DEFAULT_STUCK_EXECUTION_SWEEP_LIMIT = 50
export const STUCK_EXECUTION_SWEEP_MESSAGE =
  'Workflow execution stopped before it could report a result'

export interface SweptExecution {
  executionId: string
  workflowId: string | null
  startedAt: Date
}

export interface SweepStuckExecutionsResult {
  scanned: number
  swept: SweptExecution[]
  failed: number
  dryRun: boolean
}

export interface SweepStuckWorkflowExecutionLogsArgs {
  graceMs?: number
  limit?: number
  now?: Date
  dryRun?: boolean
}

export async function sweepStuckWorkflowExecutionLogs(
  args: SweepStuckWorkflowExecutionLogsArgs = {}
): Promise<SweepStuckExecutionsResult> {
  const now = args.now ?? new Date()
  const graceMs = Math.max(0, args.graceMs ?? DEFAULT_STUCK_EXECUTION_GRACE_MS)
  const limit = Math.max(1, Math.floor(args.limit ?? DEFAULT_STUCK_EXECUTION_SWEEP_LIMIT))
  const dryRun = args.dryRun ?? false

  const candidates = await db
    .select({
      executionId: workflowExecutionLogs.executionId,
      workflowId: workflowExecutionLogs.workflowId,
      startedAt: workflowExecutionLogs.startedAt,
    })
    .from(workflowExecutionLogs)
    .where(
      and(
        isNull(workflowExecutionLogs.endedAt),
        lt(workflowExecutionLogs.startedAt, new Date(now.getTime() - graceMs)),
        // A live run always still holds its queue row, so a missing row is the only proof the run is gone.
        notExists(
          db
            .select({ id: pendingExecution.id })
            .from(pendingExecution)
            .where(
              or(
                eq(pendingExecution.id, workflowExecutionLogs.executionId),
                sql`${pendingExecution.payload}->>'executionId' = ${workflowExecutionLogs.executionId}`
              )
            )
        )
      )
    )
    .limit(limit)

  if (dryRun) {
    return { scanned: candidates.length, swept: [...candidates], failed: 0, dryRun: true }
  }

  const swept: SweptExecution[] = []
  let failed = 0

  for (const candidate of candidates) {
    try {
      // Re-asserting endedAt IS NULL keeps a genuine completion that wins the race from being overwritten.
      const updated = await db
        .update(workflowExecutionLogs)
        .set({
          endedAt: now,
          level: 'error',
          totalDurationMs: Math.max(0, now.getTime() - candidate.startedAt.getTime()),
          executionData: sql`jsonb_set(coalesce(${workflowExecutionLogs.executionData}, '{}'::jsonb), '{errorMessage}', to_jsonb(${STUCK_EXECUTION_SWEEP_MESSAGE}::text))`,
        })
        .where(
          and(
            eq(workflowExecutionLogs.executionId, candidate.executionId),
            isNull(workflowExecutionLogs.endedAt)
          )
        )
        .returning({ executionId: workflowExecutionLogs.executionId })

      if (updated.length === 0) continue

      swept.push(candidate)
    } catch (error) {
      failed += 1
      logger.error('Failed to sweep stuck workflow execution log', {
        executionId: candidate.executionId,
        error,
      })
    }
  }

  if (swept.length > 0 || failed > 0) {
    logger.info('Swept stuck workflow execution logs', {
      scanned: candidates.length,
      swept: swept.length,
      failed,
    })
  }

  return { scanned: candidates.length, swept, failed, dryRun: false }
}
