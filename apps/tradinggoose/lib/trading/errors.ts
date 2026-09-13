export class TradingServiceError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'TradingServiceError'
    this.status = status
  }
}

export const isTradingServiceError = (error: unknown): error is TradingServiceError =>
  error instanceof TradingServiceError

/**
 * A trading error becomes an HTTP response, so its status has to BE an HTTP status.
 *
 * A broker transport failure reaches the trading layer as `status: 0` (the shared
 * request helper in providers/trading/portfolio-utils.ts reports "could not
 * connect" that way, and providers/trading/ibkr/client.ts routes its calls
 * through the same helper) and `Response` rejects any status outside 200-599.
 * Forwarding such a value threw
 * `RangeError: init["status"] must be in the range of 200 to 599` OUT of the
 * route handler, so the broker error body never reached the caller: an operator
 * placing an order saw a framework error instead of the broker's complaint and
 * could not tell whether the order was rejected, never sent, or sent and lost.
 *
 * Every status this codebase produces (400/401/403/404/422/429/500/502) passes
 * through untouched. Only a value that cannot be an HTTP status - 0, absent,
 * negative, non-integer, or above 599 - becomes 502, because that failure is
 * upstream of the app (the broker could not be reached or gave no usable
 * response), not a problem with the caller's request.
 */
export const resolveTradingErrorStatus = (status?: number): number =>
  typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : 502
