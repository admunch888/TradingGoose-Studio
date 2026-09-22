import { type NextRequest, NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/auth/internal'
import { createLogger } from '@/lib/logs/console/logger'
import {
  DEFAULT_STUCK_EXECUTION_GRACE_MS,
  DEFAULT_STUCK_EXECUTION_SWEEP_LIMIT,
  sweepStuckWorkflowExecutionLogs,
} from '@/lib/logs/execution/stuck-execution-sweeper'

const logger = createLogger('StuckExecutionSweepCron')

const DRY_RUN_VALUES = new Set(['true', '1'])

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function readPositiveNumber(raw: string | null, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export async function GET(request: NextRequest) {
  try {
    const authError = verifyCronAuth(request, 'Stuck execution sweep')
    if (authError) {
      return authError
    }

    const params = request.nextUrl.searchParams
    const graceSeconds = readPositiveNumber(
      params.get('graceSeconds'),
      DEFAULT_STUCK_EXECUTION_GRACE_MS / 1000
    )

    const result = await sweepStuckWorkflowExecutionLogs({
      dryRun: DRY_RUN_VALUES.has((params.get('dryRun') ?? '').toLowerCase()),
      graceMs: graceSeconds * 1000,
      limit: readPositiveNumber(params.get('limit'), DEFAULT_STUCK_EXECUTION_SWEEP_LIMIT),
    })

    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    logger.error('Error in stuck execution sweep job:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
