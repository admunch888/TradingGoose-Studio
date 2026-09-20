import { createLogger } from '@/lib/logs/console/logger'
import { fetchIbkrMarketJson } from '@/providers/market/ibkr/pacing'
import {
  isRetryableStatus,
  parseRetryAfter,
  YahooRateLimitError,
  yahooRequestPolicy,
} from '@/providers/market/yahoo-finance/request-policy'
import { buildIbkrAuthHeaders } from '@/providers/trading/ibkr/auth'
import { buildIbkrApiUrl } from '@/providers/trading/ibkr/client'
import { ensureIbkrSession } from '@/providers/trading/ibkr/session'
import { resolveIbkrConidFromApi } from '@/providers/trading/ibkr/symbols'

const logger = createLogger('Market:Volatility')

/**
 * The VIX complex as a trading cycle needs it: the 30-day index and the 3-month
 * one, each with its last print and the print it opened on.
 *
 * WHY THIS IS A FILTER AND NOT AN INPUT
 * Neither number is fed to the model. What they decide is whether a forecast may
 * trade at all, how strong it has to be before it may, and how far the stop
 * sits - the regime around the forecast, which belongs to the caller. So all
 * this module owes that caller is the quote plus enough provenance to tell a
 * live one from a frozen one: `asOf` is the SOURCE'S OWN timestamp and not the
 * time of the fetch, and `isStale` is exported rather than applied internally,
 * because a module that refuses its own quotes cannot be debugged and one that
 * hides an old quote is worse.
 *
 * TWO SOURCES, ONE SHAPE
 * IBKR is asked first: it is the broker the orders go to, so its index feed is
 * the one that agrees with the account. Every IBKR failure - a throw, an empty
 * row, an expiry of the gateway session, a hosted API with no token - is logged
 * and falls through to Yahoo instead of surfacing, because a missing volatility
 * filter must not be the reason a cycle dies. Yahoo is unauthenticated and
 * carries its own quote timestamp, which is what makes it usable as a freshness
 * fallback rather than a second opinion. Its requests go through
 * `yahooRequestPolicy`, the same policy the quote providers use, so the retry on
 * a rate limit, the shared budget across every Yahoo caller in the app, and the
 * per-attempt abort are the app's existing rules rather than this module's.
 *
 * Each symbol resolves on its own and falls back on its own. One source or one
 * symbol failing must not blank the other: a VIX quote with no VIX3M quote is
 * still a VIX quote, and a caller that wants the spread can see for itself that
 * the second leg is missing.
 */

export type VolatilitySymbol = 'VIX' | 'VIX3M'

export type VolatilitySource = 'ibkr' | 'yahoo'

export interface VolatilityQuote {
  symbol: VolatilitySymbol
  /** The last price the source reports. */
  last: number
  /**
   * Today's opening print, or null when the source carried no session bar yet
   * (an index before its first print, or a payload whose rows are all null).
   */
  open: number | null
  /** ISO 8601 timestamp of the QUOTE, not of the fetch. */
  asOf: string
  source: VolatilitySource
}

export interface VolatilityContext {
  vix: VolatilityQuote | null
  vix3m: VolatilityQuote | null
}

export interface FetchVolatilityContextOptions {
  /**
   * Required only by IBKR's hosted OAuth API; the Client Portal Gateway keeps
   * its own browser session and sends no bearer token.
   */
  accessToken?: string
  /**
   * The clock a payload with no timestamp of its own is stamped with, and the
   * clock callers compare against when they ask whether a quote is stale.
   * Injected rather than read from the ambient one so a freshness test does not
   * rot, the way parseIbkrFuturesContractMonth takes its own.
   */
  now?: Date
  /**
   * Per-request abort budget for the IBKR path; production uses
   * VOLATILITY_QUOTE_TIMEOUT_MS. The Yahoo path takes its own timeout from
   * `yahooRequestPolicy` instead, which is the budget its rate limiter needs to
   * be honest about.
   */
  quoteTimeoutMs?: number
}

/**
 * How long ONE outbound quote request may take before it is aborted.
 *
 * A stalled short-horizon quote must not hold a trading cycle: observed live, a
 * script asking for exactly this kind of quote sat on a socket until the caller
 * itself was killed, and nothing in the request would ever have ended on its
 * own. Five seconds is generous for a single top-of-book row or one day of
 * five-minute bars, and a slow answer is worth abandoning rather than waiting
 * for when the alternative is a cycle that never completes.
 */
export const VOLATILITY_QUOTE_TIMEOUT_MS = 5_000

/**
 * A hard ceiling on the whole IBKR attempt - session priming, conid resolution
 * and up to two snapshot reads.
 *
 * The snapshot fetch carries its own abort signal, but `ensureIbkrSession`
 * makes calls of its own and takes none, so a gateway that ACCEPTS the
 * connection and then never answers would hang the attempt before any signal
 * was ever consulted. The attempt is therefore abandoned at the ceiling and the
 * Yahoo path is taken; the abandoned request is left to finish or die on its
 * own, and its answer is discarded. Scaling with the per-request budget keeps
 * the two in step.
 */
export const VOLATILITY_IBKR_BUDGET_MS = VOLATILITY_QUOTE_TIMEOUT_MS * 3

/**
 * Default freshness allowance. The module does not apply it - `isStale` takes it
 * per call, because how old a volatility print may be is the caller's rule, not
 * this module's. Ten minutes is the default a short-horizon cycle is expected
 * to want.
 */
export const VOLATILITY_STALE_AFTER_MS = 10 * 60_000

/** Yahoo's ticker for each index. The caret is part of it (`^VIX3M`, not `VIX3M`). */
const YAHOO_TICKERS: Record<VolatilitySymbol, string> = {
  VIX: '^VIX',
  VIX3M: '^VIX3M',
}

const YAHOO_CHART_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart'

/**
 * One day of five-minute bars. The range is what makes the first row of the
 * session available at all, and the interval keeps a day to ~80-160 rows rather
 * than the whole index history.
 */
const YAHOO_CHART_QUERY = { range: '1d', interval: '5m' } as const

/**
 * IBKR market-data field ids, as /iserver/marketdata/snapshot names them:
 *   31  last price
 *   7295 open - "Today's opening price"
 * Only these two are requested. 7296 (today's CLOSING price) and 7741 (prior
 * close) are documented siblings and deliberately not read: a closing price
 * reported as a live last is the stale quote this module exists to prevent, and
 * a prior close is not today's open.
 */
const IBKR_LAST_FIELD = '31'
const IBKR_OPEN_FIELD = '7295'
const IBKR_SNAPSHOT_FIELDS = [IBKR_LAST_FIELD, IBKR_OPEN_FIELD]

const IBKR_SNAPSHOT_PATH = '/iserver/marketdata/snapshot'

const resolveNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** The first non-null number in a payload series - how an open is found. */
const resolveFirstNumber = (values?: Array<number | null>): number | null => {
  for (const value of values ?? []) {
    const parsed = resolveNumber(value)
    if (parsed !== null) return parsed
  }
  return null
}

/** The last non-null number in a payload series - how a last is found. */
const resolveLastNumber = (values?: Array<number | null>): number | null => {
  const series = values ?? []
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const parsed = resolveNumber(series[index])
    if (parsed !== null) return parsed
  }
  return null
}

/**
 * A payload timestamp as ISO 8601, or null when there is none to report.
 *
 * Yahoo sends these in epoch SECONDS - `regularMarketTime` for a chart payload
 * was 1789762501 for 2026-09-18T20:15:01Z - while other Yahoo surfaces and IBKR
 * use milliseconds, so the magnitude is checked rather than assumed. A missing
 * or zero timestamp yields null and lets the caller fall through to the next
 * piece of evidence rather than reporting the epoch as a quote time.
 */
const toIsoFromEpoch = (value: unknown): string | null => {
  const stamp = resolveNumber(value)
  if (stamp === null || stamp <= 0) return null
  const date = new Date(stamp > 1e12 ? stamp : stamp * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * An IBKR snapshot field as a number, plus whether the value is flagged as a
 * PREVIOUS day's close.
 *
 * IBKR prefixes field 31 with a marker when the value is not a live print
 * (`C` - previous day's closing price, `H` - trading has halted), and the
 * marker is stripped exactly as the live provider strips it. `C` is the one
 * worth acting on: the number is then yesterday's close, and the row's
 * `_updated` describes the ROW rather than the price, so a value from the
 * previous session can arrive looking freshly updated. Handing that to a regime
 * filter as "last" is the stale quote this module is here to catch, and Yahoo
 * answers the same question with a timestamp of its own, so a `C` value is
 * reported as no quote at all and the fallback is taken. A halt (`H`) is not
 * that case - the price is from today - so its marker is stripped and the value
 * kept.
 */
const resolveIbkrField = (
  raw?: string | number
): { value: number | null; previousDayClose: boolean } => {
  if (raw === undefined || raw === null) return { value: null, previousDayClose: false }
  const previousDayClose = typeof raw === 'string' && /^\s*C/i.test(raw)
  const cleaned = typeof raw === 'string' ? raw.replace(/[^0-9.-]/g, '') : raw
  const parsed = typeof cleaned === 'number' ? cleaned : Number.parseFloat(cleaned)
  return { value: Number.isFinite(parsed) ? parsed : null, previousDayClose }
}

/**
 * A row of /iserver/marketdata/snapshot. The price fields are string-keyed by
 * field id and arrive as strings or numbers depending on the gateway build.
 */
interface IbkrSnapshotRow {
  conid?: number
  /** Epoch milliseconds of the row's own last update. */
  _updated?: number
  [field: string]: string | number | undefined
}

interface YahooChartResult {
  meta?: {
    regularMarketPrice?: number
    regularMarketTime?: number
    chartPreviousClose?: number
    previousClose?: number
  }
  timestamp?: number[]
  indicators?: {
    quote?: Array<{ open?: Array<number | null>; close?: Array<number | null> }>
  }
}

interface YahooChartPayload {
  chart?: {
    result?: YahooChartResult[]
    error?: { code?: string; description?: string } | null
  }
}

/**
 * Run a task under a wall-clock ceiling, answering null when the ceiling is
 * reached. Used for the IBKR attempt, whose constituent calls are not all
 * signal-aware (see VOLATILITY_IBKR_BUDGET_MS). The timer is always cleared, so
 * a fast answer does not leave a pending timeout behind it.
 */
const withBudget = async <T>({
  budgetMs,
  task,
  onTimeout,
}: {
  budgetMs: number
  task: () => Promise<T>
  onTimeout: () => void
}): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          onTimeout()
          resolve(null)
        }, budgetMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Read the snapshot row for one conid.
 *
 * The first call to this endpoint SUBSCRIBES and frequently answers with a row
 * that carries no price fields; the immediate follow-up carries the data. Two
 * reads is what the live provider does and what its comment describes, and both
 * share the one abort signal, so the pair is bounded by a single budget rather
 * than one each.
 */
const readIbkrSnapshotRow = async ({
  conid,
  headers,
  signal,
}: {
  conid: number
  headers: Record<string, string>
  signal: AbortSignal
}): Promise<IbkrSnapshotRow | undefined> => {
  const url = `${buildIbkrApiUrl(IBKR_SNAPSHOT_PATH)}?${new URLSearchParams({
    conids: String(conid),
    fields: IBKR_SNAPSHOT_FIELDS.join(','),
  }).toString()}`
  const init: RequestInit = { method: 'GET', headers, signal }

  let rows = await fetchIbkrMarketJson<IbkrSnapshotRow[]>({
    url,
    init,
    label: 'volatility-snapshot',
  })
  if (resolveIbkrField(rows?.[0]?.[IBKR_LAST_FIELD]).value === null) {
    rows = await fetchIbkrMarketJson<IbkrSnapshotRow[]>({
      url,
      init,
      label: 'volatility-snapshot',
    })
  }
  return rows?.[0]
}

/**
 * IBKR's quote for one index, or null when IBKR cannot answer.
 *
 * UNVERIFIED FROM THIS MACHINE - the gateway runs on a remote host with no
 * access from the development one, so nothing below has been observed against a
 * live IBKR response. Assumed, not verified: that IBKR files these indices as
 * `IND` contracts under the symbols `VIX` and `VIX3M`, that the snapshot row for
 * an index carries 31 and 7295, and that 7295 is populated for an IND contract.
 * Every one of those assumptions has the same failure path - the row comes back
 * without a usable 31, this returns null, and Yahoo answers - which is why the
 * fallback is not optional.
 *
 * The conid lookup is called without a listing context. This module holds no
 * listing identity for either symbol (they are indices the catalogue does not
 * list, not contracts the operator picked), and a made-up venue or currency
 * would only scope the conid cache entry to a listing nobody else asks for.
 */
const fetchIbkrVolatilityQuote = async ({
  symbol,
  accessToken,
  timeoutMs,
}: {
  symbol: VolatilitySymbol
  accessToken?: string
  timeoutMs: number
}): Promise<VolatilityQuote | null> => {
  try {
    // Throws when the hosted API is configured without a token, which is the
    // "IBKR is not set up here" case rather than a broker failure.
    const headers = buildIbkrAuthHeaders({ accessToken })
    await ensureIbkrSession({ accessToken })

    const { conid } = await resolveIbkrConidFromApi({
      symbol,
      assetClass: 'indice',
      accessToken,
    })

    const row = await readIbkrSnapshotRow({
      conid,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const last = resolveIbkrField(row?.[IBKR_LAST_FIELD])
    if (last.value === null || last.previousDayClose) {
      logger.debug('IBKR carried no live volatility print; falling back to Yahoo', {
        symbol,
        conid,
        previousDayClose: last.previousDayClose,
      })
      return null
    }

    return {
      symbol,
      last: last.value,
      open: resolveIbkrField(row?.[IBKR_OPEN_FIELD]).value,
      // `_updated` is the row's own update time; a row that carries no timestamp
      // is stamped now, which is the only evidence available in that case.
      asOf: toIsoFromEpoch(row?._updated) ?? new Date().toISOString(),
      source: 'ibkr',
    }
  } catch (error) {
    logger.warn('IBKR volatility quote unavailable; falling back to Yahoo', { symbol, error })
    return null
  }
}

/**
 * The Yahoo chart payload as a quote, or null when the payload carries no price
 * at all.
 *
 * WHICH FIELDS, AND WHY
 * A captured `^VIX` payload for 2026-09-18 (range=1d, interval=5m) carried
 * `meta.regularMarketPrice` 14.81 with `meta.regularMarketTime` 1789762501, and
 * `indicators.quote[0].close` ending on the same 14.81 - for an index the last
 * bar repeats the current print rather than a traded one. The last price is
 * therefore taken from `meta.regularMarketPrice` first, with the last non-null
 * bar close as the fallback, because `regularMarketPrice` is the field Yahoo
 * itself calls the current price and it is the one that agrees with the bar
 * series.
 *
 * `meta.chartPreviousClose` on that payload was 15.44 (and `meta.previousClose`
 * the same) while `indicators.quote[0].open[0]` was 15.07. So today's open is
 * the FIRST non-null bar open - the session's own opening print - and the
 * previous close is deliberately NOT used as a substitute for it: a rule asking
 * where the session opened would otherwise be handed yesterday's close, which
 * is a different question with a different answer.
 *
 * `regularMarketTime` is preferred for `asOf` because it is the source's own
 * clock; the last bar timestamp and then the injected `now` are fallbacks for a
 * payload that omits it.
 */
const parseYahooVolatilityQuote = ({
  payload,
  symbol,
  now,
}: {
  payload: YahooChartPayload
  symbol: VolatilitySymbol
  now: Date
}): VolatilityQuote | null => {
  const result = payload?.chart?.result?.[0]
  if (!result) return null

  const meta = result.meta ?? {}
  const bars = result.indicators?.quote?.[0] ?? {}
  const last = resolveNumber(meta.regularMarketPrice) ?? resolveLastNumber(bars.close)
  if (last === null) return null

  return {
    symbol,
    last,
    open: resolveFirstNumber(bars.open),
    asOf:
      toIsoFromEpoch(meta.regularMarketTime) ??
      toIsoFromEpoch(resolveLastNumber(result.timestamp)) ??
      now.toISOString(),
    source: 'yahoo',
  }
}

/**
 * Yahoo's quote for one index, or null when Yahoo cannot answer.
 *
 * THIS SOURCE IS POLICY-GOVERNED, NOT TIMED HERE. The request runs under
 * `yahooRequestPolicy` keyed by its own URL, so the retry, the shared
 * rate-limit budget, the short-window cache and the per-attempt abort are the
 * policy's. The signal handed to `fetch` is the policy's own
 * `AbortSignal.timeout`, which is why this function takes no timeout of its
 * own - passing a second one would bound an attempt by a rule the policy does
 * not know about.
 *
 * WHAT THE CALLBACK OWES THE POLICY. The policy caches whatever the callback
 * RESOLVES with and retries only a `YahooRateLimitError` or its own timeout, so
 * a non-OK response has to be thrown rather than returned: returning null would
 * both skip the retry and freeze the failure into the shared cache for the
 * whole TTL, for every other caller asking for the same URL. A retryable status
 * (429, 5xx) is thrown as `YahooRateLimitError` so the policy backs off and
 * honours `Retry-After`; anything else is thrown as a plain error, which the
 * policy does not retry.
 *
 * A non-200 and a stalled request remain failures of this source alone: what
 * survives the policy's retries is caught here, and the symbol ends up with no
 * quote rather than an exception travelling up into a trading cycle.
 */
const fetchYahooVolatilityQuote = async ({
  symbol,
  now,
}: {
  symbol: VolatilitySymbol
  now: Date
}): Promise<VolatilityQuote | null> => {
  const params = new URLSearchParams(YAHOO_CHART_QUERY)
  const url = `${YAHOO_CHART_BASE_URL}/${encodeURIComponent(YAHOO_TICKERS[symbol])}?${params.toString()}`

  try {
    const payload = await yahooRequestPolicy.run(url, async (signal) => {
      const response = await fetch(url, {
        headers: {
          // Yahoo serves an unauthenticated request with no user agent a 429 more
          // often than not; the same browser-shaped header the series provider
          // sends is used here for the same reason.
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json',
        },
        signal,
      })

      if (!response.ok) {
        if (isRetryableStatus(response.status)) {
          throw new YahooRateLimitError(
            response.status,
            parseRetryAfter(response.headers.get('retry-after'))
          )
        }
        throw new Error(`Yahoo Finance request failed with status ${response.status}`)
      }

      return (await response.json()) as YahooChartPayload
    })

    const quote = parseYahooVolatilityQuote({ payload, symbol, now })
    if (!quote) {
      logger.debug('Yahoo returned no volatility price', {
        symbol,
        error: payload?.chart?.error?.description,
      })
    }
    return quote
  } catch (error) {
    logger.warn('Yahoo volatility quote unavailable', { symbol, error })
    return null
  }
}

/** One symbol: IBKR first, Yahoo when IBKR cannot answer. Never throws. */
const resolveVolatilityQuote = async ({
  symbol,
  accessToken,
  now,
  timeoutMs,
}: {
  symbol: VolatilitySymbol
  accessToken?: string
  now: Date
  timeoutMs: number
}): Promise<VolatilityQuote | null> => {
  const fromIbkr = await withBudget({
    budgetMs: timeoutMs * 3,
    task: () => fetchIbkrVolatilityQuote({ symbol, accessToken, timeoutMs }),
    onTimeout: () =>
      logger.warn('IBKR volatility quote did not answer within its budget; falling back to Yahoo', {
        symbol,
      }),
  })
  if (fromIbkr) return fromIbkr

  return fetchYahooVolatilityQuote({ symbol, now })
}

/**
 * VIX and VIX3M, each from whichever source could answer.
 *
 * The two symbols are fetched together and resolved independently, so the cycle
 * waits for one round trip rather than two and a failure on either side leaves
 * the other quote intact. A symbol with no usable quote comes back as null and
 * is never an exception.
 */
export const fetchVolatilityContext = async (
  options: FetchVolatilityContextOptions = {}
): Promise<VolatilityContext> => {
  const { accessToken, now = new Date(), quoteTimeoutMs = VOLATILITY_QUOTE_TIMEOUT_MS } = options

  const [vix, vix3m] = await Promise.all([
    resolveVolatilityQuote({ symbol: 'VIX', accessToken, now, timeoutMs: quoteTimeoutMs }),
    resolveVolatilityQuote({ symbol: 'VIX3M', accessToken, now, timeoutMs: quoteTimeoutMs }),
  ])

  return { vix, vix3m }
}

/**
 * Whether a quote is older than the caller's allowance.
 *
 * A quote with no timestamp, or an unparseable one, counts as stale: freshness
 * that cannot be demonstrated is not freshness. An age exactly at the allowance
 * is NOT stale - the quote is still within the window it was given, and only
 * beyond it has it expired. A null quote is stale as well, because there is no
 * fresh quote to trade on; a caller that needs to tell "no source answered"
 * from "the answer was old" has the null to check.
 */
export const isStale = (
  quote: VolatilityQuote | null,
  now: Date = new Date(),
  maxAgeMs: number = VOLATILITY_STALE_AFTER_MS
): boolean => {
  if (!quote) return true
  const asOf = Date.parse(quote.asOf)
  if (!Number.isFinite(asOf)) return true
  return now.getTime() - asOf > maxAgeMs
}
