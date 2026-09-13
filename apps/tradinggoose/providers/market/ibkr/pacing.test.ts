/**
 * @vitest-environment node
 *
 * Pacing + retry for IBKR READ-ONLY market data.
 *
 * The live symptom: a 'Historical Data -> Kronos Forecast' run needs 300-500
 * daily bars, the dashboard's chart poll asks for a snapshot every ~15s, and the
 * Client Portal Gateway answers the burst with `429` (and sometimes `503`) ~37
 * times in 10 seconds. Before this module a 429 propagated as a terminal
 * provider error and killed the workflow run.
 *
 * Everything here is driven by an INJECTED clock and sleep: nothing really
 * sleeps, so the assertions are exact and deterministic. `random` is pinned to 1
 * so the jittered delay is the fully-jittered upper bound rather than a value
 * that changes between runs.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeMarketProviderError } from '@/providers/market/errors'
import {
  fetchIbkrMarketJson,
  type IbkrPacingConfig,
  type IbkrPacingRuntime,
  IbkrRequestPacer,
  withIbkrRateLimitRetry,
} from '@/providers/market/ibkr/pacing'

const testConfig: IbkrPacingConfig = {
  minIntervalMs: 350,
  maxAttempts: 4,
  retryBaseMs: 500,
  retryMaxMs: 8_000,
  retryBudgetMs: 20_000,
}

/** A clock that never sleeps: `sleep` just advances it and records the wait. */
class FakeClock implements IbkrPacingRuntime {
  time = 0
  readonly sleeps: number[] = []

  now = (): number => this.time

  sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms)
    this.time += ms
  }

  /** Pinned so the jittered delay is deterministic (the capped upper bound). */
  random = (): number => 1
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const stubFetchSequence = (...responses: Response[]) => {
  const mock = vi.fn(async () => responses.shift() ?? jsonResponse({}, 200))
  vi.stubGlobal('fetch', mock)
  return mock
}

const reconcileError = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the promise to reject')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchIbkrMarketJson - retry on a rate-limited gateway', () => {
  it('retries a 429 and returns the bars from the next attempt', async () => {
    const clock = new FakeClock()
    const pacer = new IbkrRequestPacer({ config: testConfig, runtime: clock })
    const fetchMock = stubFetchSequence(
      jsonResponse({ error: 'Pacing violation: repeat request' }, 429),
      jsonResponse({ data: [{ t: 1, c: 2 }] })
    )

    const result = await fetchIbkrMarketJson<{ data: unknown[] }>({
      url: 'http://127.0.0.1:5000/v1/api/iserver/marketdata/history?conid=265598',
      label: 'history',
      config: testConfig,
      runtime: clock,
      pacer,
    })

    expect(result.data).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // One backoff wait of `retryBaseMs` (attempt 1) before the second request.
    expect(clock.sleeps).toEqual([500])
  })

  it('retries a 503 the same way', async () => {
    const clock = new FakeClock()
    const pacer = new IbkrRequestPacer({ config: testConfig, runtime: clock })
    const fetchMock = stubFetchSequence(
      jsonResponse({ message: 'gateway unavailable' }, 503),
      jsonResponse({ data: [{ t: 1, c: 2 }] })
    )

    const result = await fetchIbkrMarketJson<{ data: unknown[] }>({
      url: 'http://127.0.0.1:5000/v1/api/iserver/marketdata/history?conid=265598',
      label: 'history',
      config: testConfig,
      runtime: clock,
      pacer,
    })

    expect(result.data).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(clock.sleeps).toEqual([500])
  })

  it('bounds the attempts and surfaces a message naming the status and exhaustion', async () => {
    const clock = new FakeClock()
    const pacer = new IbkrRequestPacer({ config: testConfig, runtime: clock })
    // Always refused: the cap, not the gateway, is what ends this.
    const fetchMock = stubFetchSequence(...Array.from({ length: 10 }, () => jsonResponse({}, 429)))

    const error = await reconcileError(
      fetchIbkrMarketJson<unknown>({
        url: 'http://127.0.0.1:5000/v1/api/iserver/marketdata/history?conid=265598',
        label: 'history',
        config: testConfig,
        runtime: clock,
        pacer,
      })
    )

    expect(fetchMock).toHaveBeenCalledTimes(testConfig.maxAttempts)
    // maxAttempts - 1 waits between them.
    expect(clock.sleeps).toHaveLength(testConfig.maxAttempts - 1)
    expect(error.message).toMatch(/429/)
    expect(error.message).toMatch(/exhaust/i)
    expect(error.message).toMatch(/retried/i)
    // The operator's log is the only visibility they have: say it was rate limited.
    expect(error.message).toMatch(/rate-limited/i)
  })

  it('keeps the status on the surfaced error so it is not swallowed', async () => {
    const clock = new FakeClock()
    const pacer = new IbkrRequestPacer({ config: testConfig, runtime: clock })
    stubFetchSequence(...Array.from({ length: 10 }, () => jsonResponse({}, 429)))

    const error = await reconcileError(
      fetchIbkrMarketJson<unknown>({
        url: 'http://127.0.0.1:5000/v1/api/iserver/marketdata/history?conid=265598',
        label: 'history',
        config: testConfig,
        runtime: clock,
        pacer,
      })
    )

    const normalized = normalizeMarketProviderError(error, 'ibkr')
    expect(normalized.code).toBe('PROVIDER ERROR')
    expect(normalized.status).toBe(429)
    expect(normalized.message).toMatch(/rate-limited/i)
  })

  it('does not retry a 401 - an auth failure must not be delayed', async () => {
    const clock = new FakeClock()
    const pacer = new IbkrRequestPacer({ config: testConfig, runtime: clock })
    const fetchMock = stubFetchSequence(jsonResponse({ error: 'not authenticated' }, 401))

    const error = await reconcileError(
      fetchIbkrMarketJson<unknown>({
        url: 'http://127.0.0.1:5000/v1/api/iserver/marketdata/history?conid=265598',
        label: 'history',
        config: testConfig,
        runtime: clock,
        pacer,
      })
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(clock.sleeps).toHaveLength(0)
    expect((error as { status?: number }).status).toBe(401)
  })

  it('does not retry a 403 either', async () => {
    const clock = new FakeClock()
    const pacer = new IbkrRequestPacer({ config: testConfig, runtime: clock })
    const fetchMock = stubFetchSequence(jsonResponse({ error: 'forbidden' }, 403))

    const error = await reconcileError(
      fetchIbkrMarketJson<unknown>({
        url: 'http://127.0.0.1:5000/v1/api/iserver/marketdata/snapshot?conids=265598',
        label: 'snapshot',
        config: testConfig,
        runtime: clock,
        pacer,
      })
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(clock.sleeps).toHaveLength(0)
    expect((error as { status?: number }).status).toBe(403)
  })
})

describe('IbkrRequestPacer - serial queue with a minimum interval', () => {
  it('spaces two concurrent calls by the minimum interval', async () => {
    const clock = new FakeClock()
    const config: IbkrPacingConfig = { ...testConfig, minIntervalMs: 350 }
    const pacer = new IbkrRequestPacer({ config, runtime: clock })
    const starts: number[] = []

    const task = async () => {
      starts.push(clock.now())
    }

    await Promise.all([pacer.run(task), pacer.run(task)])

    expect(starts).toHaveLength(2)
    // The second call is held until the interval has elapsed since the first.
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(350)
    expect(clock.sleeps).toEqual([350])
  })

  it('serializes concurrent calls - one task at a time, in order', async () => {
    const clock = new FakeClock()
    const pacer = new IbkrRequestPacer({ config: testConfig, runtime: clock })
    const events: string[] = []

    const first = pacer.run(async () => {
      events.push('first:start')
      await Promise.resolve()
      events.push('first:end')
    })
    const second = pacer.run(async () => {
      events.push('second:start')
      events.push('second:end')
    })

    await Promise.all([first, second])

    // Never interleaved: the second cannot start before the first has ended.
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('does not wait when the previous call was already longer than the interval', async () => {
    const clock = new FakeClock()
    const pacer = new IbkrRequestPacer({
      config: { ...testConfig, minIntervalMs: 350 },
      runtime: clock,
    })

    await pacer.run(async () => {
      clock.time += 5_000 // a slow gateway answer
    })
    await pacer.run(async () => {
      clock.time += 1
    })

    expect(clock.sleeps).toEqual([])
  })

  it('does not wait for the very first call', async () => {
    const clock = new FakeClock()
    const pacer = new IbkrRequestPacer({ config: testConfig, runtime: clock })
    await pacer.run(async () => {})
    expect(clock.sleeps).toEqual([])
  })
})

describe('withIbkrRateLimitRetry - backoff shape', () => {
  it('backs off exponentially, capped, and with jitter', async () => {
    const clock = new FakeClock()
    const config: IbkrPacingConfig = {
      ...testConfig,
      maxAttempts: 6,
      retryBaseMs: 500,
      retryMaxMs: 2_000,
      retryBudgetMs: 1_000_000,
      minIntervalMs: 0,
    }

    const attempt = { count: 0 }
    const error = await reconcileError(
      withIbkrRateLimitRetry({
        config,
        runtime: clock,
        label: 'history',
        task: async () => {
          attempt.count += 1
          const failure = new Error('refused') as Error & { status: number }
          failure.status = 429
          throw failure
        },
      })
    )

    expect(attempt.count).toBe(6)
    // 500, 1000, 2000, then capped at 2000 for the remaining waits.
    expect(clock.sleeps).toEqual([500, 1_000, 2_000, 2_000, 2_000])
    expect(error.message).toMatch(/429/)
  })

  it('stops before sleeping past the total time budget', async () => {
    const clock = new FakeClock()
    const config: IbkrPacingConfig = {
      ...testConfig,
      maxAttempts: 10,
      retryBaseMs: 500,
      retryMaxMs: 8_000,
      retryBudgetMs: 1_200,
      minIntervalMs: 0,
    }

    const error = await reconcileError(
      withIbkrRateLimitRetry({
        config,
        runtime: clock,
        label: 'history',
        task: async () => {
          const failure = new Error('refused') as Error & { status: number }
          failure.status = 503
          throw failure
        },
      })
    )

    // 500 + 1000 = 1500 would blow the 1200ms budget, so the second wait is
    // never taken and the error surfaces with the budget named.
    expect(clock.sleeps).toEqual([500])
    expect(error.message).toMatch(/503/)
    expect(error.message).toMatch(/budget/i)
  })

  it('rethrows a non-rate-limit status untouched', async () => {
    const clock = new FakeClock()
    const original = new Error('boom') as Error & { status: number }
    original.status = 500

    const error = await reconcileError(
      withIbkrRateLimitRetry({
        config: testConfig,
        runtime: clock,
        label: 'history',
        task: async () => {
          throw original
        },
      })
    )

    expect(error).toBe(original)
    expect(clock.sleeps).toEqual([])
  })
})

describe('non-idempotent trading calls are never paced or retried', () => {
  const collectSources = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        out.push(...collectSources(full))
      } else if (full.endsWith('.ts')) {
        out.push(full)
      }
    }
    return out
  }

  // A retried order is a duplicated order - this is the guard against a future
  // refactor wiring the market-data retry into the trading layer.
  it('no file under the trading layer imports the market pacing/retry helper', () => {
    const roots = ['providers/trading', 'lib/trading'].map((rel) =>
      path.resolve(process.cwd(), rel)
    )
    const offenders: string[] = []
    for (const root of roots) {
      for (const file of collectSources(root)) {
        const source = readFileSync(file, 'utf8')
        if (
          /ibkr\/pacing/.test(source) ||
          /fetchIbkrMarketJson/.test(source) ||
          /withIbkrRateLimitRetry/.test(source) ||
          /IbkrRequestPacer/.test(source)
        ) {
          offenders.push(path.relative(process.cwd(), file))
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the order submission call site still uses the plain broker fetch', () => {
    const orders = readFileSync(path.resolve(process.cwd(), 'lib/trading/orders.ts'), 'utf8')
    expect(orders).toContain('fetchBrokerJson<unknown>(')
    expect(orders).not.toContain('fetchIbkrMarketJson')
  })
})
