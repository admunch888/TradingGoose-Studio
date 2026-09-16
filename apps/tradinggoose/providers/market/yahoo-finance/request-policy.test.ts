/**
 * The failure this prevents: a watchlist or a dashboard mounts, twenty symbols
 * are requested at once, Yahoo rate-limits most of them, and the user sees "no
 * data" for whichever ones lost - intermittently, and differently each reload.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  isRetryableStatus,
  parseRetryAfter,
  YahooRateLimitError,
  YahooRequestPolicy,
} from '@/providers/market/yahoo-finance/request-policy'

const policy = (overrides = {}) =>
  new YahooRequestPolicy({
    ttlMs: 1000,
    concurrency: 2,
    attempts: 3,
    backoffMs: 1,
    timeoutMs: 1000,
    ...overrides,
  })

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('identical requests in flight', () => {
  it('share one call instead of racing each other', async () => {
    const gate = deferred<string>()
    const request = vi.fn(() => gate.promise)
    const subject = policy()

    const all = Promise.all([
      subject.run('same', request),
      subject.run('same', request),
      subject.run('same', request),
    ])
    gate.resolve('bars')

    expect(await all).toEqual(['bars', 'bars', 'bars'])
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('are only shared per key', async () => {
    const request = vi.fn(async () => 'bars')
    const subject = policy()

    await Promise.all([subject.run('a', request), subject.run('b', request)])

    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe('the response cache', () => {
  it('serves a repeat within the window without calling again', async () => {
    const request = vi.fn(async () => 'bars')
    const subject = policy()

    await subject.run('k', request)
    await subject.run('k', request)

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('calls again once the window has passed', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn(async () => 'bars')
      const subject = policy({ ttlMs: 50 })

      await subject.run('k', request)
      vi.advanceTimersByTime(51)
      await subject.run('k', request)

      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never caches a failure', async () => {
    // A cached error would make one bad moment stick for the whole window, for
    // every caller asking for that symbol.
    const request = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('bars')
    const subject = policy({ attempts: 1 })

    await expect(subject.run('k', request)).rejects.toThrow('boom')
    await expect(subject.run('k', request)).resolves.toBe('bars')
  })

  it('can be switched off entirely', async () => {
    const request = vi.fn(async () => 'bars')
    const subject = policy({ ttlMs: 0 })

    await subject.run('k', request)
    await subject.run('k', request)

    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe('concurrency', () => {
  it('keeps only a few requests outstanding at once', async () => {
    let active = 0
    let peak = 0
    const gates = Array.from({ length: 6 }, () => deferred<string>())
    const subject = policy({ concurrency: 2, ttlMs: 0 })

    const runs = gates.map((gate, index) =>
      subject.run(`key-${index}`, async () => {
        active++
        peak = Math.max(peak, active)
        const value = await gate.promise
        active--
        return value
      })
    )

    // Let the first slots fill, then release everything.
    await Promise.resolve()
    for (const gate of gates) gate.resolve('bars')
    await Promise.all(runs)

    // Exactly the cap, not merely under it: with the cap raised to 6 this same
    // shape peaks at 6, so the assertion is not passing vacuously.
    expect(peak).toBe(2)
  })
})

describe('retrying', () => {
  it('retries a rate limit and returns the eventual success', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new YahooRateLimitError(429, null))
      .mockResolvedValueOnce('bars')

    await expect(policy().run('k', request)).resolves.toBe('bars')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('gives up after the configured attempts', async () => {
    const request = vi.fn().mockRejectedValue(new YahooRateLimitError(503, null))

    await expect(policy({ attempts: 2 }).run('k', request)).rejects.toBeInstanceOf(
      YahooRateLimitError
    )
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not retry an error that will not change', async () => {
    // A 404 for a symbol Yahoo does not know is not worth three attempts.
    const request = vi.fn().mockRejectedValue(new Error('Not Found'))

    await expect(policy().run('k', request)).rejects.toThrow('Not Found')
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('reading Retry-After', () => {
  it('understands seconds', () => {
    expect(parseRetryAfter('30')).toBe(30_000)
  })

  it('understands an HTTP date', () => {
    const now = Date.parse('2026-09-16T12:00:00Z')
    expect(parseRetryAfter('Wed, 16 Sep 2026 12:00:30 GMT', now)).toBe(30_000)
  })

  it('never returns a negative wait for a date already past', () => {
    const now = Date.parse('2026-09-16T12:00:00Z')
    expect(parseRetryAfter('Wed, 16 Sep 2026 11:59:00 GMT', now)).toBe(0)
  })

  it.each([
    ['absent', null],
    ['nonsense', 'soon'],
  ])('returns nothing when it is %s', (_label, header) => {
    expect(parseRetryAfter(header)).toBeNull()
  })
})

describe('which statuses are worth retrying', () => {
  it.each([429, 500, 502, 503, 504])('retries %i', (status) => {
    expect(isRetryableStatus(status)).toBe(true)
  })

  it.each([400, 401, 403, 404, 422])('does not retry %i', (status) => {
    expect(isRetryableStatus(status)).toBe(false)
  })
})
