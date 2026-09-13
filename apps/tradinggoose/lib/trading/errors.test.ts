/**
 * @vitest-environment node
 *
 * A trading error becomes an HTTP response, so its status has to be an HTTP
 * status: `Response` rejects anything outside 200-599 and the thrown RangeError
 * discards the error body the caller needs to read.
 */

import { describe, expect, it } from 'vitest'
import { resolveTradingErrorStatus } from '@/lib/trading/errors'

describe('resolveTradingErrorStatus', () => {
  it('documents the constraint it exists for', () => {
    expect(() => new Response(null, { status: 0 })).toThrow(RangeError)
    expect(() => new Response(null, { status: 600 })).toThrow(RangeError)
  })

  it.each([400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 599])(
    'keeps the real status %i',
    (status) => {
      expect(resolveTradingErrorStatus(status)).toBe(status)
    }
  )

  it.each([
    ['a transport failure', 0],
    ['an absent status', undefined],
    ['a negative status', -1],
    ['an informational status', 100],
    ['a redirect status', 302],
    ['a status below the error range', 399],
    ['a status above the HTTP range', 600],
    ['a non-integer status', 422.5],
    ['a NaN status', Number.NaN],
    ['an infinite status', Number.POSITIVE_INFINITY],
  ])('answers 502 for %s', (_label, status) => {
    expect(resolveTradingErrorStatus(status)).toBe(502)
  })
})
