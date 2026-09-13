import { createLogger } from '@/lib/logs/console/logger'
import type { AssetClass } from '@/providers/market/types'
import { buildIbkrAuthHeaders, isIbkrHostedApi } from '@/providers/trading/ibkr/auth'
import {
  buildIbkrApiUrl,
  cacheIbkrConid,
  getCachedIbkrConid,
} from '@/providers/trading/ibkr/client'
import { fetchBrokerJson } from '@/providers/trading/portfolio-utils'

const logger = createLogger('Provider:IBKR:Symbols')

export interface IbkrConidResolution {
  conid: number
  conidSpec: string
}

/**
 * The listing context that scopes a conid lookup.
 *
 * secType + symbol alone is not an identity. `STK:AAPL` used to be whichever
 * listing IBKR's search happened to return first - the NASDAQ share (265598)
 * even for a caller that meant Toronto (532640894) - and once futures
 * resolution learned to strip a catalogue marker, `FUT:MES` served every
 * exchange and (because futures rows carry no expiry filter) every expiry of
 * that root from a single entry.
 *
 * `exchange` is IBKR's own venue name (`NASDAQ`, `TSE`, `CME`); `marketCode` is
 * the app's market code (`XNAS`, `NAE`) and stands in for it when that is all
 * the caller has - an entry keyed by a market code still cannot serve another
 * market. `currency` is the listing quote currency; `expiry` is the contract
 * month for a future (`SEP26` / `202609`).
 */
export interface IbkrConidListingContext {
  exchange?: string | null
  marketCode?: string | null
  currency?: string | null
  expiry?: string | null
}

const ibkrSpecByAssetClass: Partial<Record<AssetClass, string>> = {
  stock: 'STK',
  etf: 'STK',
  future: 'FUT',
  currency: 'CASH',
  indice: 'IND',
  mutualfund: 'FUND',
}

export const resolveIbkrConidSpec = (assetClass?: AssetClass | null): string =>
  (assetClass && ibkrSpecByAssetClass[assetClass]) || 'STK'

const CONID_KEY_PLACEHOLDER = '-'

const normalizeConidKeyPart = (value?: string | null): string => {
  const trimmed = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return trimmed || CONID_KEY_PLACEHOLDER
}

/**
 * `STK:AAPL:NASDAQ:USD:-` - sec type, symbol, exchange (or the market code that
 * stands in for it), quote currency and contract month.
 *
 * Every dimension is written even when the caller does not have it, so one
 * caller always builds the same key for the same listing. `STK:AAPL` and
 * `STK:AAPL:NASDAQ:USD:-` would otherwise be two entries for one contract, and
 * the synchronous order-path read would miss the entry market data just wrote.
 */
export const buildIbkrConidCacheKey = (
  symbol: string,
  assetClass?: AssetClass | null,
  context?: IbkrConidListingContext | null
): string =>
  [
    `${resolveIbkrConidSpec(assetClass)}:${symbol.trim().toUpperCase()}`,
    normalizeConidKeyPart(context?.exchange ?? context?.marketCode),
    normalizeConidKeyPart(context?.currency),
    normalizeConidKeyPart(context?.expiry),
  ].join(':')

/**
 * The venue tokens a caller's context can be recognised by. IBKR's own venue
 * name wins; the app's market code is kept as a second candidate because the
 * provider configs carry no market-code -> exchange mapping to translate it
 * with (see matchesRequestedListing).
 */
export const ibkrListingExchangeTokens = (context?: IbkrConidListingContext | null): string[] => {
  const tokens = [context?.exchange, context?.marketCode]
    .map((value) => (typeof value === 'string' ? value.trim().toUpperCase() : ''))
    .filter(Boolean)
  return Array.from(new Set(tokens))
}

/**
 * The listings catalogue is not IBKR's vocabulary. A futures contract arrives
 * with a marker glued to the symbol - observed BOTH as `F*MES` and as `FMES`
 * with quote USD, for a contract the operator searched for as `MES` - while
 * IBKR's own contract search wants the bare symbol.
 *
 * So for FUTURES the marked form is tried FIRST and the stripped form second.
 * The order matters and the restriction matters:
 *  - a leading `F` is a legitimate ticker elsewhere (`F` is Ford), so nothing is
 *    stripped for other asset classes;
 *  - a real futures symbol can itself start with F (FDAX, FESX), so the marked
 *    form must be attempted first and stripping only a fallback - never the
 *    other way round, and never when the first attempt errors for a reason that
 *    is not "no match".
 */
export const ibkrSymbolCandidates = (symbol: string, assetClass?: AssetClass | null): string[] => {
  const normalized = symbol.trim().toUpperCase()
  if (resolveIbkrConidSpec(assetClass) !== 'FUT') {
    return [normalized]
  }
  const stripped = normalized.replace(/^F\*/, '').replace(/^F(?=[A-Z])/, '')
  return stripped && stripped !== normalized ? [normalized, stripped] : [normalized]
}

interface SecDefSection {
  secType?: string
  exchange?: string
  /**
   * Contract months a FUT section offers, comma separated (`SEP26,DEC26`) on
   * the live payload. Absent for everything else.
   */
  months?: string
}

/**
 * A row of POST /iserver/secdef/search. The endpoint returns a BARE ARRAY of
 * these (not an object) and nests the available security types under
 * `sections`, with the conid delivered as a string.
 */
interface SecDefResponseItem {
  conid?: number | string
  symbol?: string | null
  description?: string | null
  secType?: string
  exchange?: string
  sections?: SecDefSection[]
}

const normalizeListingToken = (value?: string | null): string =>
  typeof value === 'string' ? value.trim().toUpperCase() : ''

/**
 * Every venue name a row can be recognised by. `sections[].exchange` is the
 * precise one; the flat `exchange` and `description` fields are what the live
 * endpoint carries instead for a listing row, so all three are considered.
 */
const ibkrRowExchangeTokens = (row: SecDefResponseItem): string[] => {
  const sections = Array.isArray(row?.sections) ? row.sections : []
  return Array.from(
    new Set(
      [...sections.map((section) => section?.exchange), row?.exchange, row?.description]
        .map(normalizeListingToken)
        .filter(Boolean)
    )
  )
}

const sectionMonths = (section: SecDefSection): string[] =>
  typeof section?.months === 'string'
    ? section.months.split(',').map(normalizeListingToken).filter(Boolean)
    : []

/**
 * An expiry filter only rules a section out when the section actually
 * enumerates its months - an older-shaped section without `months` cannot be
 * disproved by a contract month, so it stays a candidate.
 */
const sectionOffersExpiry = (section: SecDefSection, expiry: string[]): boolean =>
  expiry.length === 0 ||
  sectionMonths(section).length === 0 ||
  sectionMonths(section).some((month) => expiry.includes(month))

/**
 * Resolve an IBKR contract identifier for a symbol and seed the in-memory
 * conid cache. Call this ahead of order submission — the shared order pipeline
 * is synchronous and reads conid values from the cache (see resolveIbkrConid).
 */
export async function resolveIbkrConidFromApi({
  symbol,
  assetClass,
  context,
  accessToken,
}: {
  symbol: string
  assetClass?: AssetClass | null
  context?: IbkrConidListingContext | null
  accessToken?: string
}): Promise<IbkrConidResolution> {
  const normalizedSymbol = symbol.trim().toUpperCase()
  if (!normalizedSymbol) {
    throw new Error('IBKR order requires a symbol')
  }

  const conidSpec = resolveIbkrConidSpec(assetClass)
  const cacheKey = buildIbkrConidCacheKey(normalizedSymbol, assetClass, context)
  const cachedConid = getCachedIbkrConid(cacheKey)
  if (cachedConid !== undefined) {
    return { conid: cachedConid, conidSpec }
  }

  // The local Client Portal Gateway carries auth in its browser session, so no
  // token is involved; only the hosted API needs one here. Requiring it
  // unconditionally is what made gateway market data fail before the request
  // was even sent.
  if (isIbkrHostedApi() && !accessToken) {
    throw new Error('IBKR hosted API requires an access token to resolve contracts')
  }

  const requestedExchanges = ibkrListingExchangeTokens(context)
  const requestedExpiry = context?.expiry ? [normalizeListingToken(context.expiry)] : []

  // Sec types live under `sections` on the real payload; the flat `secType`
  // field is kept for older shapes. A row matching no section is skipped.
  const matchesRequestedSpec = (row: SecDefResponseItem): boolean => {
    const sections = Array.isArray(row?.sections) ? row.sections : []
    if (sections.length === 0) {
      return (row?.secType ?? '').toUpperCase() === conidSpec
    }
    return sections.some(
      (section) =>
        (section?.secType ?? '').toUpperCase() === conidSpec &&
        sectionOffersExpiry(section, requestedExpiry)
    )
  }

  /**
   * The venue check. IBKR returns one row per listing of the symbol (AAPL on
   * NASDAQ and AAPL on TSE); taking the first section of the first row is how
   * one listing's conid ended up serving another's.
   *
   * A caller that knows the venue (`exchange`) or at least the app's market
   * code (`marketCode`) gets the matching row. The app's market codes are MIC
   * codes (`XNAS`) while IBKR names venues `NASDAQ`, and neither provider
   * config carries a market-code -> exchange map to translate between them, so
   * a context that matches nothing still falls back to the first matching row
   * - scoped to its own cache entry, and logged, rather than failing every
   * listing whose market code does not happen to be an IBKR venue string.
   */
  const matchesRequestedListing = (row: SecDefResponseItem): boolean =>
    requestedExchanges.length === 0 ||
    ibkrRowExchangeTokens(row).some((token) => requestedExchanges.includes(token))

  let resolvedConid: number | undefined

  for (const candidate of ibkrSymbolCandidates(normalizedSymbol, assetClass)) {
    const searchParams = new URLSearchParams({ symbol: candidate })
    if (conidSpec !== 'STK') {
      searchParams.set('secType', conidSpec)
    }

    // A transport or auth failure throws straight out: retrying a session error
    // with a different spelling would only hide the real cause.
    const response = await fetchBrokerJson<
      SecDefResponseItem[] | { contracts?: SecDefResponseItem[] }
    >({
      providerId: 'ibkr',
      url: `${buildIbkrApiUrl('/iserver/secdef/search')}?${searchParams.toString()}`,
      init: {
        method: 'POST',
        headers: {
          ...buildIbkrAuthHeaders({ accessToken }),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ symbol: candidate }),
      },
    })

    // The live endpoint answers with a bare array; accept the wrapped shape too
    // so a future/edge response cannot silently resolve to nothing.
    const rows = Array.isArray(response) ? response : (response?.contracts ?? [])
    const specMatches = rows.filter(matchesRequestedSpec)
    const venueMatch = requestedExchanges.length
      ? specMatches.find(matchesRequestedListing)
      : undefined
    if (requestedExchanges.length && !venueMatch && specMatches.length > 0) {
      logger.warn('IBKR returned no listing for the requested venue', {
        symbol: candidate,
        requestedExchanges,
        availableExchanges: specMatches.flatMap(ibkrRowExchangeTokens),
      })
    }
    const rawConid = (venueMatch ?? specMatches[0])?.conid
    const conid = typeof rawConid === 'string' ? Number(rawConid) : rawConid

    if (typeof conid === 'number' && Number.isFinite(conid)) {
      resolvedConid = conid
      break
    }
  }

  if (resolvedConid === undefined) {
    throw new Error(`Unable to resolve IBKR contract identifier for symbol ${normalizedSymbol}`)
  }

  cacheIbkrConid(cacheKey, resolvedConid)
  return { conid: resolvedConid, conidSpec }
}

/**
 * Synchronous conid lookup against the in-memory cache.
 * See resolveIbkrConidFromApi for how the cache is seeded.
 */
export function resolveIbkrConid({
  symbol,
  assetClass,
  context,
}: {
  symbol: string
  assetClass?: AssetClass | null
  context?: IbkrConidListingContext | null
}): IbkrConidResolution {
  const normalizedSymbol = symbol.trim().toUpperCase()
  if (!normalizedSymbol) {
    throw new Error('IBKR order requires a symbol')
  }

  const conidSpec = resolveIbkrConidSpec(assetClass)
  const cacheKey = buildIbkrConidCacheKey(normalizedSymbol, assetClass, context)
  const cachedConid = getCachedIbkrConid(cacheKey)
  if (cachedConid !== undefined) {
    return { conid: cachedConid, conidSpec }
  }

  throw new Error(
    `IBKR contract identifier not resolved for symbol ${normalizedSymbol}. ` +
      'Run resolveIbkrConidFromApi first so the conid cache is seeded for order submission.'
  )
}
