import { createLogger } from '@/lib/logs/console/logger'
import { fetchBrokerJson, TradingBrokerRequestError } from '@/providers/trading/portfolio-utils'

const logger = createLogger('MarketProvider:IBKR:Pacing')

/**
 * Pacing and retry for IBKR READ-ONLY market data.
 *
 * WHY THIS EXISTS
 * The Client Portal Gateway enforces IBKR's own request pacing. A burst - the
 * dashboard's chart poll asking for a quote snapshot every ~15s while a
 * 'Historical Data -> Kronos Forecast' workflow asks for 300-500 daily bars in
 * one go - is answered with `429` (and sometimes `503`): the live operator log
 * held ~37 of them in 10 seconds, in bursts, and each one killed a workflow run.
 * A repeat of the SAME conid/period/bar combination in quick succession counts
 * as a pacing violation on its own.
 *
 * THE RULE: a pacing violation must WAIT, not fail. The gateway is telling the
 * caller to slow down; the limits are IBKR's and are not negotiable, so the only
 * correct response is to space the calls and try again. Failing the workflow
 * instead turned a transient throttle into a lost run.
 *
 * SCOPE - READ-ONLY ONLY
 * This applies to idempotent GETs against the gateway's market-data endpoints
 * (`/iserver/marketdata/history`, `/iserver/marketdata/snapshot`). It is NEVER
 * applied to anything that mutates a position: a retried order is a duplicated
 * order. The trading layer's order POST (lib/trading/orders.ts) keeps failing
 * fast, and a test pins that so a future refactor cannot wire the retry in too
 * broadly.
 *
 * 401/403 is deliberately NOT retried: an unauthenticated gateway session needs
 * the operator to log in, and retrying just delays the error they can act on.
 */

/**
 * Defaults sized so a single-workflow user never notices: 350ms between calls is
 * a rounding error against one history request, and the retry budget is generous
 * enough to ride out a real throttle window without holding a workflow hostage.
 */
export const IBKR_PACING_DEFAULTS = {
  /** Minimum spacing between two outbound gateway market-data calls. */
  minIntervalMs: 350,
  /** Total attempts for a rate-limited call, the first one included. */
  maxAttempts: 4,
  /** First backoff before jitter; doubles per attempt. */
  retryBaseMs: 500,
  /** Hard ceiling on a single backoff, so the cap is bounded. */
  retryMaxMs: 8_000,
  /** Total wall-clock budget for one paced operation, sleeps included. */
  retryBudgetMs: 20_000,
} as const

export interface IbkrPacingConfig {
  minIntervalMs: number
  maxAttempts: number
  retryBaseMs: number
  retryMaxMs: number
  retryBudgetMs: number
}

/**
 * The clock, the sleep and the randomness are all injectable: tests drive the
 * pacer and the backoff with a fake clock and never really sleep, so the
 * timing assertions are exact rather than a race against the wall clock.
 */
export interface IbkrPacingRuntime {
  now: () => number
  sleep: (ms: number) => Promise<void>
  random: () => number
}

/** `429 Too Many Requests` and `503 Service Unavailable` are the two refusals. */
const RETRYABLE_STATUSES = new Set([429, 503])

const readEnv = (variable: string): string | undefined => process.env[variable]?.trim() || undefined

const readPositiveInt = (variable: string, fallback: number): number => {
  const raw = readEnv(variable)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.floor(parsed)
}

/**
 * Configuration, defaulted, from the environment (registered in lib/env.ts).
 * An unparseable or negative value falls back to the default rather than
 * silently disabling pacing with a `NaN`.
 */
export const resolveIbkrPacingConfig = (): IbkrPacingConfig => ({
  minIntervalMs: readPositiveInt('IBKR_MARKET_MIN_INTERVAL_MS', IBKR_PACING_DEFAULTS.minIntervalMs),
  maxAttempts: Math.max(
    1,
    readPositiveInt('IBKR_MARKET_RETRY_MAX_ATTEMPTS', IBKR_PACING_DEFAULTS.maxAttempts)
  ),
  retryBaseMs: Math.max(
    1,
    readPositiveInt('IBKR_MARKET_RETRY_BASE_MS', IBKR_PACING_DEFAULTS.retryBaseMs)
  ),
  retryMaxMs: Math.max(
    1,
    readPositiveInt('IBKR_MARKET_RETRY_MAX_MS', IBKR_PACING_DEFAULTS.retryMaxMs)
  ),
  retryBudgetMs: readPositiveInt('IBKR_MARKET_RETRY_BUDGET_MS', IBKR_PACING_DEFAULTS.retryBudgetMs),
})

export const createIbkrPacingRuntime = (): IbkrPacingRuntime => ({
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
})

const statusOf = (error: unknown): number | null => {
  if (typeof error !== 'object' || error === null) return null
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

export const isIbkrRetryableStatus = (status: number | null): boolean =>
  status !== null && RETRYABLE_STATUSES.has(status)

/**
 * A SERIAL queue, per process, for outbound gateway market-data calls.
 *
 * Not per request: the point is that the chart poll and a workflow's history
 * fetch QUEUE BEHIND EACH OTHER instead of colliding. Every caller in the
 * process shares one pacer instance (see `fetchIbkrMarketJson`), and each call
 * is held until `minIntervalMs` has elapsed since the previous call STARTED, so
 * a burst cannot form no matter how many callers arrive at once. A call that
 * follows a slow answer does not wait again - the spacing is between start
 * times, not between "previous finished" and "next started".
 */
export class IbkrRequestPacer {
  private readonly config: IbkrPacingConfig
  private readonly runtime: IbkrPacingRuntime
  private tail: Promise<unknown> = Promise.resolve()
  private lastStartedAt = Number.NEGATIVE_INFINITY

  constructor({ config, runtime }: { config: IbkrPacingConfig; runtime: IbkrPacingRuntime }) {
    this.config = config
    this.runtime = runtime
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const start = async (): Promise<T> => {
      const waitMs = this.lastStartedAt + this.config.minIntervalMs - this.runtime.now()
      if (waitMs > 0) await this.runtime.sleep(waitMs)
      this.lastStartedAt = this.runtime.now()
      return task()
    }

    // `then(start, start)` so a rejected predecessor still releases the queue -
    // one failed call must not wedge every later one.
    const result = this.tail.then(start, start)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

/**
 * Bounded, JITTERED exponential backoff.
 *
 * The delay doubles from `retryBaseMs` and is capped at `retryMaxMs`, then
 * jittered into the 50-100% band of that cap. The jitter matters because the
 * live failure came in BURSTS: several callers refused together would otherwise
 * retry in lockstep and collide again. It is a bounded jitter, not full jitter,
 * so a retry cannot be spuriously immediate.
 */
export const computeIbkrBackoffMs = (
  attempt: number,
  config: IbkrPacingConfig,
  random: () => number
): number => {
  const exponential = config.retryBaseMs * 2 ** (attempt - 1)
  const capped = Math.min(config.retryMaxMs, exponential)
  return Math.round(capped * (0.5 + 0.5 * random()))
}

interface IbkrRetryEvent {
  label: string
  status: number
  attempt: number
  maxAttempts: number
  delayMs: number
}

const describeRefusal = (status: number): string =>
  status === 429
    ? `IBKR Client Portal Gateway rate-limited the request (HTTP ${status})`
    : `IBKR Client Portal Gateway refused the request (HTTP ${status})`

/**
 * Re-shape the refusal so the caller still sees a broker-status error (the
 * market error normalizer keys off `status`, so a 429 is NOT swallowed into a
 * generic provider error) but with a message that says the gateway throttle was
 * waited on rather than a bare "Broker request failed with status 429".
 */
const buildExhaustedError = ({
  error,
  status,
  attempts,
  budgetMs,
}: {
  error: unknown
  status: number
  attempts: number
  budgetMs?: number
}): TradingBrokerRequestError => {
  const broker = error instanceof TradingBrokerRequestError ? error : null
  const reason =
    budgetMs === undefined
      ? `waited and retried ${attempts} times; the retries were exhausted`
      : `waited ${budgetMs}ms in total across ${attempts} attempts; the retry time budget was exhausted`
  return new TradingBrokerRequestError({
    message: `${describeRefusal(status)} - the provider ${reason}.`,
    providerId: broker?.providerId ?? 'ibkr',
    status,
    url: broker?.url ?? '',
    payload: broker?.payload,
  })
}

/**
 * Retry a single READ-ONLY gateway call on 429/503.
 *
 * `task` must be idempotent - this helper does nothing to check that, which is
 * why the trading layer never calls it. Each retry is logged at warn with the
 * attempt number, the status and the wait, because the operator's log is the
 * only visibility they have into why a run is slow rather than failed.
 */
export async function withIbkrRateLimitRetry<T>({
  task,
  config,
  runtime,
  label,
  onRetry,
}: {
  task: () => Promise<T>
  config: IbkrPacingConfig
  runtime: IbkrPacingRuntime
  label: string
  onRetry?: (event: IbkrRetryEvent) => void
}): Promise<T> {
  const startedAt = runtime.now()

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      const status = statusOf(error)

      // Anything that is not a 429/503 - a 401/403 above all - fails fast: an
      // auth failure is not a rate limit and retrying it only delays the error
      // the operator can actually act on.
      if (!isIbkrRetryableStatus(status)) {
        throw error
      }

      const retryStatus = status as number

      if (attempt >= config.maxAttempts) {
        throw buildExhaustedError({ error, status: retryStatus, attempts: attempt })
      }

      const delayMs = computeIbkrBackoffMs(attempt, config, runtime.random)
      if (runtime.now() - startedAt + delayMs > config.retryBudgetMs) {
        throw buildExhaustedError({
          error,
          status: retryStatus,
          attempts: attempt,
          budgetMs: config.retryBudgetMs,
        })
      }

      const event: IbkrRetryEvent = {
        label,
        status: retryStatus,
        attempt,
        maxAttempts: config.maxAttempts,
        delayMs,
      }
      logger.warn('IBKR gateway refused a market-data request; waiting to retry', event)
      onRetry?.(event)

      await runtime.sleep(delayMs)
    }
  }
}

let sharedRuntime: IbkrPacingRuntime | null = null
let sharedPacer: IbkrRequestPacer | null = null

const runtimeOf = (): IbkrPacingRuntime => (sharedRuntime ??= createIbkrPacingRuntime())

/**
 * The process-wide pacer. One instance is shared by every IBKR market-data
 * caller (`market/ibkr/series.ts` and `market/ibkr/live.ts`), which is the whole
 * point: they queue behind each other.
 */
const pacerOf = (): IbkrRequestPacer =>
  (sharedPacer ??= new IbkrRequestPacer({
    config: resolveIbkrPacingConfig(),
    runtime: runtimeOf(),
  }))

/**
 * Fetch JSON from an IBKR gateway MARKET-DATA endpoint: paced behind the shared
 * serial queue, and retried on 429/503 with bounded jittered backoff.
 *
 * Do not use this for order placement or any other mutating call.
 */
export async function fetchIbkrMarketJson<T>({
  url,
  init,
  label,
  config,
  runtime,
  pacer,
}: {
  url: string
  init?: RequestInit
  label: string
  /** Injectable for tests; production uses the env-driven defaults. */
  config?: IbkrPacingConfig
  runtime?: IbkrPacingRuntime
  pacer?: IbkrRequestPacer
}): Promise<T> {
  const resolvedRuntime = runtime ?? runtimeOf()
  const resolvedConfig = config ?? resolveIbkrPacingConfig()
  const resolvedPacer = pacer ?? pacerOf()

  return withIbkrRateLimitRetry({
    config: resolvedConfig,
    runtime: resolvedRuntime,
    label,
    // Each outbound attempt goes through the pacer, so the minimum interval
    // applies to retries too - a retry is still a request to a gateway that is
    // refusing them.
    task: () => resolvedPacer.run(() => fetchBrokerJson<T>({ providerId: 'ibkr', url, init })),
  })
}

/** Test seam: drop the shared pacer/runtime so a fresh config is picked up. */
export const resetIbkrPacingForTests = (): void => {
  sharedRuntime = null
  sharedPacer = null
}
