/**
 * How the app is allowed to talk to Yahoo Finance.
 *
 * Yahoo is an unauthenticated public endpoint with undocumented limits, and the
 * app asks it for many symbols at once - a watchlist, or a dashboard of charts,
 * all mounting together. A bare fetch per symbol means twenty simultaneous
 * requests, no timeout, and a 429 surfacing to the user as "no data" for
 * whichever symbols happened to lose.
 *
 * Four rules, in the order a request meets them:
 *
 *   1. Serve a very recent identical response from memory.
 *   2. Join an identical request already in flight rather than making a second.
 *   3. Wait for a slot, so only a few requests are outstanding at once.
 *   4. Retry a 429 or a 5xx with backoff, honouring Retry-After.
 *
 * Only 1 can serve stale data, which is why its window is seconds rather than
 * minutes: this is a trading app, and a chart quietly showing a price from two
 * minutes ago is worse than a chart that takes another moment to load.
 */

const readNumber = (name: string, fallback: number): number => {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

export interface YahooRequestPolicyOptions {
  /** How long an identical response may be reused. */
  ttlMs: number
  /** Requests allowed to be outstanding at once. */
  concurrency: number
  /** Attempts in total, including the first. */
  attempts: number
  /** Base delay for the backoff between attempts. */
  backoffMs: number
  /** Abort a single attempt after this long. */
  timeoutMs: number
}

export const defaultYahooRequestPolicyOptions = (): YahooRequestPolicyOptions => ({
  ttlMs: readNumber('YAHOO_CACHE_TTL_MS', 15_000),
  concurrency: readNumber('YAHOO_MAX_CONCURRENCY', 3),
  attempts: readNumber('YAHOO_MAX_ATTEMPTS', 3),
  backoffMs: readNumber('YAHOO_BACKOFF_MS', 500),
  timeoutMs: readNumber('YAHOO_TIMEOUT_MS', 20_000),
})

export class YahooRateLimitError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null
  ) {
    super(`Yahoo Finance is rate limiting requests (${status})`)
    this.name = 'YahooRateLimitError'
  }
}

/** `Retry-After` is either seconds or an HTTP date; both are worth honouring. */
export const parseRetryAfter = (header: string | null, now = Date.now()): number | null => {
  if (!header) return null

  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000

  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}

/** 429 and 5xx are worth another attempt; a 404 for an unknown symbol is not. */
export const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export class YahooRequestPolicy {
  private readonly options: YahooRequestPolicyOptions
  private readonly cache = new Map<string, CacheEntry<unknown>>()
  private readonly inFlight = new Map<string, Promise<unknown>>()
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(options: Partial<YahooRequestPolicyOptions> = {}) {
    this.options = { ...defaultYahooRequestPolicyOptions(), ...options }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.options.concurrency) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active++
  }

  private release(): void {
    this.active--
    this.waiting.shift()?.()
  }

  /**
   * Run `request` under the policy, keyed by something that identifies the
   * response - the request URL.
   */
  async run<T>(key: string, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as T
    }
    this.cache.delete(key)

    const existing = this.inFlight.get(key)
    if (existing) return existing as Promise<T>

    const attempt = this.withRetries(request)
      .then((value) => {
        // Only a success is cached. Caching a failure would make one bad moment
        // stick for the whole window, across every caller asking for it.
        if (this.options.ttlMs > 0) {
          this.cache.set(key, { value, expiresAt: Date.now() + this.options.ttlMs })
        }
        return value
      })
      .finally(() => {
        this.inFlight.delete(key)
      })

    this.inFlight.set(key, attempt)
    return attempt
  }

  private async withRetries<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let lastError: unknown

    for (let attempt = 1; attempt <= Math.max(1, this.options.attempts); attempt++) {
      await this.acquire()
      try {
        return await request(AbortSignal.timeout(this.options.timeoutMs))
      } catch (error) {
        lastError = error
        const retryable =
          error instanceof YahooRateLimitError ||
          (error instanceof Error && error.name === 'TimeoutError')
        if (!retryable || attempt === this.options.attempts) throw error

        const suggested = error instanceof YahooRateLimitError ? error.retryAfterMs : null
        // Exponential, so a rate limit that persists is not hammered; Yahoo's
        // own Retry-After wins when it sends one.
        const delay = suggested ?? this.options.backoffMs * 2 ** (attempt - 1)
        await new Promise((resolve) => setTimeout(resolve, delay))
      } finally {
        this.release()
      }
    }

    throw lastError
  }

  /** Drops cached responses. Exposed for tests and for a forced refresh. */
  clear(): void {
    this.cache.clear()
  }
}

/** The instance the provider uses. */
export const yahooRequestPolicy = new YahooRequestPolicy()
