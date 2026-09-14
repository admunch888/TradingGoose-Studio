import { readServerJsonCache, writeServerJsonCache } from '@/lib/cache/server-json-cache'
import { createLogger } from '@/lib/logs/console/logger'
import type {
  IbkrSecDefSearchRow,
  IbkrSecDefSearchSection,
} from '@/providers/market/ibkr/listing-search'
import { fetchIbkrMarketJson } from '@/providers/market/ibkr/pacing'
import type { AssetClass } from '@/providers/market/types'
import { buildIbkrAuthHeaders } from '@/providers/trading/ibkr/auth'
import { buildIbkrApiUrl } from '@/providers/trading/ibkr/client'
import { ensureIbkrSession } from '@/providers/trading/ibkr/session'
import {
  isIbkrContractMonthInThePast,
  parseIbkrFuturesContractMonth,
  resolveIbkrConidFromApi,
} from '@/providers/trading/ibkr/symbols'

const logger = createLogger('MarketProvider:IBKR:Options')

/**
 * Option chains from the IBKR gateway: options on futures (FOP, e.g. MES/ES at
 * CME) and options on stocks, ETFs and indices (OPT). READ-ONLY - every call
 * goes through the shared market-data pacer, never the order path.
 *
 * The flow is the one IBKR documents for the Client Portal API:
 *   1. /iserver/secdef/search for the underlying root - its sections list the
 *      option months and exchange, and the call primes the strikes endpoint.
 *   2. /iserver/secdef/strikes for the month's call/put strikes.
 *   3. /iserver/secdef/info per strike and right for the contract ids; one month
 *      can hold several expiries (weeklies), told apart by `maturityDate`.
 *   4. /iserver/marketdata/snapshot for quotes, implied volatility and Greeks.
 * Contract lookups are cached; quotes never are.
 */

export type IbkrOptionSecType = 'OPT' | 'FOP'
export type IbkrOptionRight = 'C' | 'P'

export const DEFAULT_STRIKES_PER_SIDE = 5
export const MAX_STRIKES_PER_SIDE = 20

/** Snapshot fields for an option contract (IBKR market data field ids). */
export const IBKR_OPTION_SNAPSHOT_FIELDS = {
  last: '31',
  bid: '84',
  ask: '86',
  askSize: '85',
  bidSize: '88',
  volume: '87',
  mark: '7635',
  impliedVolatility: '7633',
  delta: '7308',
  gamma: '7309',
  theta: '7310',
  vega: '7311',
  openInterest: '7638',
  availability: '6509',
} as const

const UNDERLYING_SNAPSHOT_FIELDS = ['31', '84', '86', '6509']

const SEARCH_CACHE_TTL_SECONDS = 60 * 60 * 6
const STRIKES_CACHE_TTL_SECONDS = 60 * 60
const CONTRACT_CACHE_TTL_SECONDS = 60 * 60 * 12
const SNAPSHOT_BATCH_SIZE = 50
const SNAPSHOT_READ_ATTEMPTS = 3
const DAY_MS = 86_400_000

const MONTH_LABELS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const

export interface IbkrOptionQuote {
  conid: number
  bid?: number
  ask?: number
  mid?: number
  mark?: number
  last?: number
  bidSize?: number
  askSize?: number
  volume?: number
  openInterest?: number
  /** Percent, e.g. 18.4 for 18.4%. */
  impliedVolatility?: number
  delta?: number
  gamma?: number
  theta?: number
  vega?: number
}

export interface IbkrOptionChainRow {
  strike: number
  call?: IbkrOptionQuote
  put?: IbkrOptionQuote
}

export interface IbkrOptionChainSummary {
  atmStrike: number | null
  /** Call + put price at the at-the-money strike (mid, else mark, else last). */
  straddlePrice: number | null
  /** The straddle price read as the move options price in by expiry. */
  impliedMove: number | null
  impliedMovePct: number | null
  /** Average of the ATM call and put implied volatility, in percent. */
  atmImpliedVolatility: number | null
  putCallOpenInterestRatio: number | null
  daysToExpiry: number | null
}

export interface IbkrOptionChain {
  underlying: {
    symbol: string
    root: string
    assetClass: AssetClass
    exchange: string
    price: number | null
    priceSource: 'input' | 'snapshot' | 'strikes'
  }
  secType: IbkrOptionSecType
  /** Option month as IBKR lists it (`OCT26`). */
  month: string
  /** Every option month IBKR lists for the underlying, expired ones dropped. */
  months: string[]
  /** Expiry of the returned contracts, `YYYYMMDD`. */
  expiry: string
  /** Every expiry in the chosen month (weeklies included), `YYYYMMDD`. */
  expirations: string[]
  rows: IbkrOptionChainRow[]
  summary: IbkrOptionChainSummary
  /**
   * IBKR's market data availability code for the quotes (field 6509): `R` real
   * time, `D` delayed, `Z` frozen, `N` not subscribed. Options on CME futures
   * need the matching market data subscription on the account.
   */
  marketDataAvailability: string | null
  asOf: string
}

interface IbkrContractInfoRow {
  conid?: number | string
  maturityDate?: string
  right?: string
  strike?: number | string
}

type SnapshotRow = Record<string, unknown> & { conid?: number | string }

const normalizeToken = (value?: string | null): string =>
  typeof value === 'string' ? value.trim().toUpperCase() : ''

const firstExchange = (value?: string | null): string => normalizeToken(value?.split(';')[0])

const toConid = (value: unknown): number | undefined => {
  const conid = typeof value === 'string' ? Number(value) : value
  return typeof conid === 'number' && Number.isFinite(conid) ? conid : undefined
}

/** IBKR snapshot values are strings with markers (`C123.5`, `18.4%`); keep the number. */
export const parseIbkrSnapshotNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/[^0-9.eE-]/g, '')
  if (!cleaned) return undefined
  const parsed = Number.parseFloat(cleaned)
  return Number.isFinite(parsed) ? parsed : undefined
}

export const resolveIbkrOptionSecType = (assetClass?: AssetClass | null): IbkrOptionSecType => {
  if (assetClass === 'future') return 'FOP'
  if (assetClass === 'stock' || assetClass === 'etf' || assetClass === 'indice') return 'OPT'
  throw new Error(
    `Option chains are available for futures, stocks, ETFs and indices, not ${assetClass ?? 'this listing'}`
  )
}

const sectionMonths = (section: IbkrSecDefSearchSection): string[] =>
  typeof section.months === 'string'
    ? section.months
        .split(/[;,\s]+/)
        .map(normalizeToken)
        .filter((token) => /^[A-Z]{3}\d{2}$/.test(token))
    : []

/** `20261016` -> `OCT26`; `oct26` -> `OCT26`; anything else -> null. */
export const toIbkrOptionMonth = (expiry?: string | null): string | null => {
  const token = normalizeToken(expiry)
  if (/^[A-Z]{3}\d{2}$/.test(token)) return token
  const date = /^(\d{4})(\d{2})\d{2}$/.exec(token)
  const label = date ? MONTH_LABELS[Number(date[2]) - 1] : undefined
  return date && label ? `${label}${date[1].slice(-2)}` : null
}

/** The option month to load: the requested one when listed, else the nearest. */
export const selectIbkrOptionMonth = (
  months: readonly string[],
  expiry: string | undefined,
  now: Date
): { month: string; months: string[] } => {
  const live = months.filter((month) => !isIbkrContractMonthInThePast(month, now))
  if (live.length === 0) {
    throw new Error('IBKR lists no current option months for this underlying')
  }
  const requested = toIbkrOptionMonth(expiry)
  if (expiry?.trim() && !requested) {
    throw new Error(`Expiry "${expiry}" must be YYYYMMDD (20261016) or a month (OCT26)`)
  }
  if (requested && !live.includes(requested)) {
    throw new Error(
      `${requested} is not an option month IBKR offers for this underlying. Available: ${live.join(', ')}`
    )
  }
  return { month: requested ?? live[0], months: live }
}

/**
 * The strikes around the underlying price: the nearest strike plus `perSide` on
 * each side. Without a price the middle of the list stands in for it.
 */
export const selectIbkrStrikeWindow = (
  strikes: readonly number[],
  price: number | null,
  perSide: number
): number[] => {
  const sorted = Array.from(new Set(strikes.filter((strike) => Number.isFinite(strike)))).sort(
    (a, b) => a - b
  )
  if (sorted.length === 0) return []
  let center = Math.floor((sorted.length - 1) / 2)
  if (price !== null && Number.isFinite(price)) {
    center = sorted.reduce(
      (best, strike, index) =>
        Math.abs(strike - price) < Math.abs(sorted[best] - price) ? index : best,
      0
    )
  }
  return sorted.slice(Math.max(0, center - perSide), center + perSide + 1)
}

const utcDateKey = (date: Date): string => date.toISOString().slice(0, 10).replace(/-/g, '')

/** The expiry to load: the requested date when listed, else the nearest one not yet past. */
export const selectIbkrOptionExpiry = (
  maturities: readonly string[],
  expiry: string | undefined,
  now: Date
): { expiry: string; expirations: string[] } => {
  const expirations = Array.from(
    new Set(maturities.map(normalizeToken).filter((date) => /^\d{8}$/.test(date)))
  ).sort()
  if (expirations.length === 0) {
    throw new Error('IBKR returned no expiries for the option month')
  }
  const requested = normalizeToken(expiry)
  if (/^\d{8}$/.test(requested)) {
    if (!expirations.includes(requested)) {
      throw new Error(
        `${requested} is not an expiry in this option month. Available: ${expirations.join(', ')}`
      )
    }
    return { expiry: requested, expirations }
  }
  const today = utcDateKey(now)
  return { expiry: expirations.find((date) => date >= today) ?? expirations.at(-1)!, expirations }
}

export const buildIbkrOptionQuote = (conid: number, row?: SnapshotRow): IbkrOptionQuote => {
  const read = (field: string) => parseIbkrSnapshotNumber(row?.[field])
  const f = IBKR_OPTION_SNAPSHOT_FIELDS
  const bid = read(f.bid)
  const ask = read(f.ask)
  const quote: IbkrOptionQuote = {
    conid,
    bid,
    ask,
    mid: bid !== undefined && ask !== undefined ? (bid + ask) / 2 : undefined,
    mark: read(f.mark),
    last: read(f.last),
    bidSize: read(f.bidSize),
    askSize: read(f.askSize),
    volume: read(f.volume),
    openInterest: read(f.openInterest),
    impliedVolatility: read(f.impliedVolatility),
    delta: read(f.delta),
    gamma: read(f.gamma),
    theta: read(f.theta),
    vega: read(f.vega),
  }
  return Object.fromEntries(
    Object.entries(quote).filter(([, value]) => value !== undefined)
  ) as unknown as IbkrOptionQuote
}

const quotePrice = (quote?: IbkrOptionQuote): number | undefined =>
  quote?.mid ?? quote?.mark ?? quote?.last

const round = (value: number, digits = 4) => Number(value.toFixed(digits))

export const summarizeIbkrOptionChain = (
  rows: readonly IbkrOptionChainRow[],
  price: number | null,
  expiry: string,
  now: Date
): IbkrOptionChainSummary => {
  const paired = rows.filter((row) => row.call && row.put)
  const candidates = paired.length ? paired : rows
  const reference =
    price ?? (candidates.length ? candidates[Math.floor(candidates.length / 2)].strike : null)
  const atm =
    reference === null
      ? undefined
      : candidates.reduce<IbkrOptionChainRow | undefined>(
          (best, row) =>
            !best || Math.abs(row.strike - reference) < Math.abs(best.strike - reference)
              ? row
              : best,
          undefined
        )

  const callPrice = quotePrice(atm?.call)
  const putPrice = quotePrice(atm?.put)
  const straddlePrice =
    callPrice !== undefined && putPrice !== undefined ? round(callPrice + putPrice) : null
  const ivs = [atm?.call?.impliedVolatility, atm?.put?.impliedVolatility].filter(
    (value): value is number => value !== undefined
  )
  const callOi = rows.reduce((sum, row) => sum + (row.call?.openInterest ?? 0), 0)
  const putOi = rows.reduce((sum, row) => sum + (row.put?.openInterest ?? 0), 0)
  const expiryMs = Date.UTC(
    Number(expiry.slice(0, 4)),
    Number(expiry.slice(4, 6)) - 1,
    Number(expiry.slice(6, 8))
  )
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())

  return {
    atmStrike: atm?.strike ?? null,
    straddlePrice,
    impliedMove: straddlePrice,
    impliedMovePct:
      straddlePrice !== null && price !== null && price > 0
        ? round((straddlePrice / price) * 100, 3)
        : null,
    atmImpliedVolatility: ivs.length
      ? round(ivs.reduce((sum, value) => sum + value, 0) / ivs.length, 3)
      : null,
    putCallOpenInterestRatio: callOi > 0 ? round(putOi / callOi, 3) : null,
    daysToExpiry: Number.isFinite(expiryMs)
      ? Math.max(0, Math.round((expiryMs - todayMs) / DAY_MS))
      : null,
  }
}

const cached = async <T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> => {
  const hit = await readServerJsonCache<T>(key)
  if (hit !== null && hit !== undefined) return hit
  const value = await load()
  await writeServerJsonCache(key, value, ttlSeconds)
  return value
}

const hasQuoteFields = (row?: SnapshotRow) =>
  Boolean(row) &&
  [
    IBKR_OPTION_SNAPSHOT_FIELDS.bid,
    IBKR_OPTION_SNAPSHOT_FIELDS.ask,
    IBKR_OPTION_SNAPSHOT_FIELDS.last,
    IBKR_OPTION_SNAPSHOT_FIELDS.mark,
  ].some((field) => row?.[field] !== undefined)

export interface FetchIbkrOptionChainRequest {
  /** Provider symbol of the underlying: `MESZ26`, `AAPL`, `SPX`. */
  symbol: string
  assetClass: AssetClass
  /** Venue the underlying is listed on (`CME`, `NASDAQ`); scopes the option section. */
  marketCode?: string
  currency?: string
  /** `YYYYMMDD` or `MMMYY`; the nearest expiry when omitted. */
  expiry?: string
  strikesPerSide?: number
  /** Skips the underlying quote when the caller already has a price. */
  underlyingPrice?: number
  accessToken?: string
  now?: Date
}

export async function fetchIbkrOptionChain(
  request: FetchIbkrOptionChainRequest
): Promise<IbkrOptionChain> {
  const now = request.now ?? new Date()
  const symbol = normalizeToken(request.symbol)
  if (!symbol) throw new Error('An underlying symbol is required for an option chain')

  const secType = resolveIbkrOptionSecType(request.assetClass)
  const root =
    request.assetClass === 'future'
      ? (parseIbkrFuturesContractMonth(symbol, 'future', now)?.root ?? symbol)
      : symbol
  const perSide = Math.min(
    MAX_STRIKES_PER_SIDE,
    Math.max(1, Math.floor(request.strikesPerSide ?? DEFAULT_STRIKES_PER_SIDE))
  )
  const accessToken = request.accessToken
  const headers = buildIbkrAuthHeaders({ accessToken })
  const requestedExchange = normalizeToken(request.marketCode)

  await ensureIbkrSession({ accessToken })

  // 1. The underlying's option section. The search also primes secdef/strikes,
  // which answers empty arrays for an underlying it has not seen searched.
  const searchParams = new URLSearchParams({ symbol: root })
  if (request.assetClass === 'future') searchParams.set('secType', 'FUT')
  const searchRows = await cached(
    `ibkr:option-search:v1:${searchParams.toString()}`,
    SEARCH_CACHE_TTL_SECONDS,
    async () => {
      const response = await fetchIbkrMarketJson<
        IbkrSecDefSearchRow[] | { contracts?: IbkrSecDefSearchRow[] }
      >({
        url: `${buildIbkrApiUrl('/iserver/secdef/search')}?${searchParams.toString()}`,
        init: {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: root }),
        },
        label: 'option-search',
      })
      return Array.isArray(response) ? response : (response?.contracts ?? [])
    }
  )

  const candidates = searchRows.flatMap((row) =>
    (Array.isArray(row?.sections) ? row.sections : [])
      .filter((section) => normalizeToken(section?.secType) === secType)
      .map((section) => ({ row, section }))
  )
  const match =
    candidates.find(
      ({ row, section }) =>
        requestedExchange &&
        [firstExchange(section.exchange), normalizeToken(row.description)].includes(
          requestedExchange
        )
    ) ?? candidates[0]
  const underlyingConid = toConid(match?.row?.conid)
  if (!match || underlyingConid === undefined) {
    throw new Error(`IBKR lists no ${secType} options for ${root}`)
  }
  // Futures options need their exchange; stock and index options route SMART.
  const exchange = firstExchange(match.section.exchange) || (secType === 'FOP' ? '' : 'SMART')
  if (!exchange) throw new Error(`IBKR did not name an exchange for ${root} futures options`)

  const { month, months } = selectIbkrOptionMonth(sectionMonths(match.section), request.expiry, now)

  // 2. Strikes for the month.
  const strikeParams = new URLSearchParams({
    conid: String(underlyingConid),
    sectype: secType,
    month,
    exchange,
  })
  const strikes = await cached(
    `ibkr:option-strikes:v1:${strikeParams.toString()}`,
    STRIKES_CACHE_TTL_SECONDS,
    () =>
      fetchIbkrMarketJson<{ call?: number[]; put?: number[] }>({
        url: `${buildIbkrApiUrl('/iserver/secdef/strikes')}?${strikeParams.toString()}`,
        init: { method: 'GET', headers },
        label: 'option-strikes',
      })
  )
  const allStrikes = [...(strikes?.call ?? []), ...(strikes?.put ?? [])]
  if (allStrikes.length === 0) {
    throw new Error(`IBKR returned no strikes for ${root} ${month} options on ${exchange}`)
  }

  // 3. Underlying price, to centre the strike window.
  let price: number | null = null
  let priceSource: IbkrOptionChain['underlying']['priceSource'] = 'strikes'
  if (typeof request.underlyingPrice === 'number' && request.underlyingPrice > 0) {
    price = request.underlyingPrice
    priceSource = 'input'
  } else {
    try {
      const { conid } = await resolveIbkrConidFromApi({
        symbol,
        assetClass: request.assetClass,
        context: { marketCode: request.marketCode, currency: request.currency },
        accessToken,
        now,
      })
      const url = `${buildIbkrApiUrl('/iserver/marketdata/snapshot')}?${new URLSearchParams({
        conids: String(conid),
        fields: UNDERLYING_SNAPSHOT_FIELDS.join(','),
      })}`
      for (let attempt = 0; attempt < SNAPSHOT_READ_ATTEMPTS && price === null; attempt++) {
        const [row] = await fetchIbkrMarketJson<SnapshotRow[]>({
          url,
          init: { method: 'GET', headers },
          label: 'option-underlying-snapshot',
        })
        const last = parseIbkrSnapshotNumber(row?.['31'])
        const bid = parseIbkrSnapshotNumber(row?.['84'])
        const ask = parseIbkrSnapshotNumber(row?.['86'])
        const quoted =
          last ?? (bid !== undefined && ask !== undefined ? (bid + ask) / 2 : undefined)
        if (quoted !== undefined && quoted > 0) {
          price = quoted
          priceSource = 'snapshot'
        }
      }
    } catch (error) {
      logger.warn('IBKR underlying price unavailable; centring the chain on the strike list', {
        symbol,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const windowStrikes = selectIbkrStrikeWindow(allStrikes, price, perSide)

  // 4. Contract ids per strike and right; the ATM strike decides the expiry.
  const contractInfo = (strike: number, right: IbkrOptionRight) => {
    const params = new URLSearchParams({
      conid: String(underlyingConid),
      sectype: secType,
      month,
      exchange,
      strike: String(strike),
      right,
    })
    return cached(
      `ibkr:option-info:v1:${params.toString()}`,
      CONTRACT_CACHE_TTL_SECONDS,
      async () => {
        const response = await fetchIbkrMarketJson<
          IbkrContractInfoRow[] | { contracts?: IbkrContractInfoRow[] }
        >({
          url: `${buildIbkrApiUrl('/iserver/secdef/info')}?${params.toString()}`,
          init: { method: 'GET', headers },
          label: 'option-info',
        })
        return Array.isArray(response) ? response : (response?.contracts ?? [])
      }
    ).catch((error) => {
      logger.warn('IBKR option contract lookup failed', {
        root,
        month,
        strike,
        right,
        error: error instanceof Error ? error.message : String(error),
      })
      return [] as IbkrContractInfoRow[]
    })
  }

  const atmStrike = selectIbkrStrikeWindow(windowStrikes, price, 0)[0]
  const atmInfo = [...(await contractInfo(atmStrike, 'C')), ...(await contractInfo(atmStrike, 'P'))]
  const { expiry, expirations } = selectIbkrOptionExpiry(
    atmInfo.map((row) => String(row.maturityDate ?? '')),
    request.expiry,
    now
  )

  const legs = await Promise.all(
    windowStrikes.flatMap((strike) =>
      (['C', 'P'] as const).map(async (right) => {
        const info = await contractInfo(strike, right)
        const contract = info.find(
          (row) =>
            normalizeToken(String(row.maturityDate ?? '')) === expiry &&
            (!row.right || normalizeToken(row.right) === right)
        )
        return { strike, right, conid: toConid(contract?.conid) }
      })
    )
  )

  // 5. Quotes, implied volatility and Greeks. The first snapshot subscribes
  // and often answers without fields, so it is read again until it fills in.
  const conids = legs.flatMap((leg) => (leg.conid === undefined ? [] : [leg.conid]))
  const snapshots = new Map<number, SnapshotRow>()
  const fields = Object.values(IBKR_OPTION_SNAPSHOT_FIELDS).join(',')
  for (let offset = 0; offset < conids.length; offset += SNAPSHOT_BATCH_SIZE) {
    const batch = conids.slice(offset, offset + SNAPSHOT_BATCH_SIZE)
    const url = `${buildIbkrApiUrl('/iserver/marketdata/snapshot')}?${new URLSearchParams({
      conids: batch.join(','),
      fields,
    })}`
    for (let attempt = 0; attempt < SNAPSHOT_READ_ATTEMPTS; attempt++) {
      const rows = await fetchIbkrMarketJson<SnapshotRow[]>({
        url,
        init: { method: 'GET', headers },
        label: 'option-snapshot',
      })
      for (const row of Array.isArray(rows) ? rows : []) {
        const conid = toConid(row?.conid)
        if (conid !== undefined && (hasQuoteFields(row) || !snapshots.has(conid))) {
          snapshots.set(conid, row)
        }
      }
      if (batch.every((conid) => hasQuoteFields(snapshots.get(conid)))) break
    }
  }

  const byStrike = new Map<number, IbkrOptionChainRow>()
  for (const leg of legs) {
    const row = byStrike.get(leg.strike) ?? { strike: leg.strike }
    if (leg.conid !== undefined) {
      const quote = buildIbkrOptionQuote(leg.conid, snapshots.get(leg.conid))
      if (leg.right === 'C') row.call = quote
      else row.put = quote
    }
    byStrike.set(leg.strike, row)
  }
  const rows = [...byStrike.values()].sort((a, b) => a.strike - b.strike)
  const availability = [...snapshots.values()]
    .map((row) => row[IBKR_OPTION_SNAPSHOT_FIELDS.availability])
    .find((value) => typeof value === 'string' && value.trim())

  logger.info('IBKR option chain', {
    root,
    secType,
    month,
    expiry,
    strikes: rows.length,
    contracts: conids.length,
    priceSource,
  })

  return {
    underlying: { symbol, root, assetClass: request.assetClass, exchange, price, priceSource },
    secType,
    month,
    months,
    expiry,
    expirations,
    rows,
    summary: summarizeIbkrOptionChain(rows, price, expiry, now),
    marketDataAvailability: typeof availability === 'string' ? availability : null,
    asOf: now.toISOString(),
  }
}
