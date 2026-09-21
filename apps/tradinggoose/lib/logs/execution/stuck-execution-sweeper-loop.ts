import { randomUUID } from 'node:crypto'
import { env, isFalsy } from '@/lib/env'
import { createLogger } from '@/lib/logs/console/logger'
import {
  DEFAULT_STUCK_EXECUTION_GRACE_MS,
  sweepStuckWorkflowExecutionLogs,
} from '@/lib/logs/execution/stuck-execution-sweeper'
import { acquireLock, releaseLock } from '@/lib/redis'

const logger = createLogger('StuckExecutionSweeperLoop')

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000
const SWEEPER_LOCK_KEY = 'workflow-execution-log-sweeper'
const SWEEPER_LOCK_EXPIRY_SECONDS = 60

const sweeperState = globalThis as typeof globalThis & {
  __TRADINGGOOSE_STUCK_EXECUTION_SWEEPER__?: {
    timer?: NodeJS.Timeout
  }
}

// A NaN interval makes setInterval fire back-to-back, so an unparseable value falls back to the default.
function readPositiveMs(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

async function sweepOnce() {
  const lockValue = randomUUID()

  if (!(await acquireLock(SWEEPER_LOCK_KEY, lockValue, SWEEPER_LOCK_EXPIRY_SECONDS))) {
    return
  }

  try {
    await sweepStuckWorkflowExecutionLogs({
      graceMs: readPositiveMs(env.WORKFLOW_LOG_SWEEPER_GRACE_MS, DEFAULT_STUCK_EXECUTION_GRACE_MS),
    })
  } finally {
    await releaseLock(SWEEPER_LOCK_KEY, lockValue)
  }
}

export function startStuckExecutionSweeperLoop(): void {
  if (isFalsy(env.WORKFLOW_LOG_SWEEPER_ENABLED)) {
    logger.info('Stuck execution sweeper disabled via WORKFLOW_LOG_SWEEPER_ENABLED')
    return
  }

  const state = (sweeperState.__TRADINGGOOSE_STUCK_EXECUTION_SWEEPER__ ??= {})
  if (state.timer) {
    return
  }

  const intervalMs = readPositiveMs(env.WORKFLOW_LOG_SWEEPER_INTERVAL_MS, DEFAULT_SWEEP_INTERVAL_MS)
  const timer = setInterval(() => {
    void sweepOnce().catch((error) => logger.error('Stuck execution sweep tick failed', error))
  }, intervalMs)
  timer.unref?.()

  state.timer = timer
  logger.info(`Stuck execution sweeper started (interval ${intervalMs}ms)`)
}

export function stopStuckExecutionSweeperLoop(): void {
  const state = sweeperState.__TRADINGGOOSE_STUCK_EXECUTION_SWEEPER__
  if (state?.timer) {
    clearInterval(state.timer)
  }
  sweeperState.__TRADINGGOOSE_STUCK_EXECUTION_SWEEPER__ = undefined
}
