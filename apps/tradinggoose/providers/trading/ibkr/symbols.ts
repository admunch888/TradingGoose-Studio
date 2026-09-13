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
 * Futures contract months as the exchanges name them inside a symbol: one
 * letter, mapped to the three-letter month a secdef section lists its
 * `months` in (`DEC25`).
 *
 * F JAN  G FEB  H MAR  J APR  K MAY  M JUN  N JUL  Q AUG  U SEP  V OCT
 * X NOV  Z DEC
 */
const IBKR_FUTURES_MONTH_NAMES: Record<string, string> = {
  F: 'JAN',
  G: 'FEB',
  H: 'MAR',
  J: 'APR',
  K: 'MAY',
  M: 'JUN',
  N: 'JUL',
  Q: 'AUG',
  U: 'SEP',
  V: 'OCT',
  X: 'NOV',
  Z: 'DEC',
}

/**
 * The trailing contract month of a catalogue futures symbol, anchored at the
 * end and requiring a root in front of it: `MESZ25` is `MES` + `Z25`,
 * `ESZ5` is `ES` + `Z5` and `MESZ2025` is `MES` + `Z2025`.
 *
 * A three-digit trailing number is deliberately not matched: nothing observed
 * writes a year that way, and guessing which end is the year is how the wrong
 * contract gets resolved to.
 */
const IBKR_FUTURES_CONTRACT_MONTH = new RegExp(
  `^(.+?)([${Object.keys(IBKR_FUTURES_MONTH_NAMES).join('')}])(\\d{4}|\\d{1,2})$`
)

export interface IbkrFuturesContractMonth {
  /** The symbol without its contract month. A catalogue marker is kept. */
  root: string
  /** The contract month in the `MMMYY` form a section's `months` uses. */
  expiry: string
}

/**
 * A two-digit year is already the year as the section's `months` writes it, so
 * it passes through; a four-digit year is shortened to those two digits. A
 * SINGLE digit (`ESZ5`) is expanded against the decade the current year is in,
 * so `5` is 2025 in the 2020s. That is the one real ambiguity - one digit
 * cannot tell 2025 from 2035 - and this rule reads a digit below the current
 * year's last digit as the current decade as well, so `Z4` in 2026 is 2024
 * rather than 2034. The catalogue observed live emits the two-digit form.
 */
const expandFuturesYearDigits = (digits: string, now: Date): string => {
  if (digits.length === 2) return digits
  if (digits.length === 4) return digits.slice(-2)
  const decade = Math.floor(now.getUTCFullYear() / 10) * 10
  return String(decade + Number(digits)).slice(-2)
}

/**
 * The contract month a catalogue futures symbol carries, or null when it
 * carries none.
 *
 * The listing catalogue names a futures contract by root + month (`MESZ25`
 * for the December 2025 Micro E-mini S&P), while IBKR's contract search only
 * knows the ROOT: asking it for `MESZ25` matches no section at all, which is
 * the live failure. The month is not lost, it is a second question -
 * resolveIbkrConidFromApi searches the root and lets the section's `months`
 * answer it, exactly as it already did for a caller that supplied an expiry.
 *
 * Only futures symbols are parsed. The restriction is what keeps every other
 * ticker intact: a trailing `<month letter><digits>` is part of the symbol
 * for anything that is not a futures contract month.
 */
export const parseIbkrFuturesContractMonth = (
  symbol: string,
  assetClass?: AssetClass | null,
  now: Date = new Date()
): IbkrFuturesContractMonth | null => {
  if (resolveIbkrConidSpec(assetClass) !== 'FUT') {
    return null
  }
  const match = IBKR_FUTURES_CONTRACT_MONTH.exec(symbol.trim().toUpperCase())
  if (!match) {
    return null
  }
  const [, root, monthLetter, yearDigits] = match
  const month = IBKR_FUTURES_MONTH_NAMES[monthLetter]
  return month ? { root, expiry: `${month}${expandFuturesYearDigits(yearDigits, now)}` } : null
}

/**
 * `STK:AAPL:NASDAQ:USD:-` / `FUT:MES:CME:USD:DEC25` - sec type, symbol,
 * exchange (or the market code that stands in for it), quote currency and
 * contract month.
 *
 * Every dimension is written even when the caller does not have it, so one
 * caller always builds the same key for the same listing. `STK:AAPL` and
 * `STK:AAPL:NASDAQ:USD:-` would otherwise be two entries for one contract, and
 * the synchronous order-path read would miss the entry market data just wrote.
 *
 * A contract-month symbol is keyed as the ROOT it resolves to plus that month,
 * so `MESZ25` shares one entry with (`MES`, `DEC25`) instead of opening a
 * second entry for a symbol the search can no longer be asked about. That is
 * what keeps both ends in agreement: the market path writes from the catalogue
 * symbol, and the order path has nothing but that symbol to read it back with.
 * A month stated in the context wins over the one in the symbol - both ends
 * read the same context, so both land on the same key either way.
 */
export const buildIbkrConidCacheKey = (
  symbol: string,
  assetClass?: AssetClass | null,
  context?: IbkrConidListingContext | null
): string => {
  const normalizedSymbol = symbol.trim().toUpperCase()
  const contractMonth = parseIbkrFuturesContractMonth(normalizedSymbol, assetClass)
  return [
    `${resolveIbkrConidSpec(assetClass)}:${contractMonth?.root ?? normalizedSymbol}`,
    normalizeConidKeyPart(context?.exchange ?? context?.marketCode),
    normalizeConidKeyPart(context?.currency),
    normalizeConidKeyPart(context?.expiry ?? contractMonth?.expiry),
  ].join(':')
}

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
 * The symbol forms to try against IBKR's contract search, in order.
 *
 * Two catalogue conventions break the symbol IBKR is asked for, and both are
 * futures-only:
 *  - a marker glued in front of the root - observed BOTH as `F*MES` and as
 *    `FMES` with quote USD, for a contract the operator searched for as `MES`;
 *  - a contract month glued on the end (`MESZ25`), which is how the listing
 *    dropdown supplies a specific expiry.
 *
 * The contract month comes off FIRST and the marker SECOND. One is a suffix and
 * the other a prefix, so neither can hide the other, and stripping the suffix
 * first leaves the marked form the marker logic already handles: a symbol
 * carrying both (`FMESZ25`) resolves through the same two candidates `FMES`
 * does. The verbatim contract-month form is not offered at all - `symbol=MESZ25`
 * is the request that failed live, because the endpoint matches roots and
 * answers the month from the section's `months`.
 *
 * The order and the restriction matter equally: a leading `F` is a legitimate
 * ticker elsewhere (`F` is Ford), so nothing is stripped for other asset
 * classes; a real futures symbol can itself start with F (FDAX, FESX), so the
 * marked form must be attempted first and stripping only a fallback - never the
 * other way round, and never when the first attempt errors for a reason that is
 * not "no match".
 */
export const ibkrSymbolCandidates = (symbol: string, assetClass?: AssetClass | null): string[] => {
  const normalized = symbol.trim().toUpperCase()
  if (resolveIbkrConidSpec(assetClass) !== 'FUT') {
    return [normalized]
  }
  const base = parseIbkrFuturesContractMonth(normalized, assetClass)?.root ?? normalized
  const stripped = base.replace(/^F\*/, '').replace(/^F(?=[A-Z])/, '')
  return stripped && stripped !== base ? [base, stripped] : [base]
}

interface SecDefSection {
  secType?: string
  exchange?: string
  /**
   * Contract months a FUT section offers, SEMICOLON separated
   * (`SEP26;DEC26;MAR27`) on the live payload: IBKR's own docs call it the
   * "List of expiration month(s) and year(s) in MMMYY format separated by
   * semicolon". Absent for everything else.
   */
  months?: string
}

/**
 * A row of GET /iserver/secdef/info - the contract a specific contract month
 * resolves to. A BARE ARRAY like the search, with the conid as a string.
 */
interface IbkrContractInfoItem {
  conid?: number | string
  symbol?: string | null
  secType?: string
  exchange?: string
  listingExchange?: string
  desc1?: string
  desc2?: string
  maturityDate?: string
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

/**
 * A contract month as IBKR writes it in a section's `months` - three letters
 * and a two-digit year (`DEC25`). Anything that is not one is not a month.
 */
const IBKR_CONTRACT_MONTH_TOKEN = /^[A-Z]{3}\d{2}$/

/**
 * The contract months a section lists.
 *
 * IBKR separates them with SEMICOLONS, so parsing on a comma turned a real
 * payload's whole list (`SEP26;DEC26;MAR27`) into ONE token that could never
 * equal a requested month: every section was ruled out and contract-month
 * resolution failed live. Semicolon, comma and whitespace are all accepted (a
 * comma was the older assumption, and a payload may still be shaped that way),
 * and only tokens that really are contract months are kept - so an
 * unanticipated delimiter yields no month rather than one giant token that
 * silently never matches.
 */
const sectionMonths = (section: SecDefSection): string[] => {
  if (typeof section?.months !== 'string') {
    return []
  }
  return section.months
    .split(/[;,\s]+/)
    .map(normalizeListingToken)
    .filter((token) => IBKR_CONTRACT_MONTH_TOKEN.test(token))
}

const IBKR_MONTH_LABELS = [
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
]

/**
 * A caller's expiry in the `MMMYY` form /iserver/secdef/info takes as `month`.
 * `SEP26` passes through; `202609` is read as the `YYYYMM` form
 * IbkrConidListingContext also documents and rewritten. Anything else yields
 * null, so the hop is skipped rather than sent a month the endpoint cannot read.
 */
const toIbkrContractMonth = (expiry?: string | null): string | null => {
  const token = normalizeListingToken(expiry)
  if (!token) {
    return null
  }
  const named = /^([A-Z]{3})(\d{2,4})$/.exec(token)
  if (named) {
    return `${named[1]}${named[2].slice(-2)}`
  }
  const numeric = /^(\d{4})(\d{2})$/.exec(token)
  if (!numeric) {
    return null
  }
  const label = IBKR_MONTH_LABELS[Number(numeric[2]) - 1]
  return label ? `${label}${numeric[1].slice(-2)}` : null
}

/** A conid as a usable number, from the string or number the API sends. */
const toConid = (value?: number | string | null): number | undefined => {
  const conid = typeof value === 'string' ? Number(value) : value
  return typeof conid === 'number' && Number.isFinite(conid) ? conid : undefined
}

/**
 * Every exchange a secdef/info contract names. `exchange` is the field the docs
 * list; `listingExchange` is accepted as a second spelling.
 */
const ibkrContractExchangeTokens = (row: IbkrContractInfoItem): string[] =>
  Array.from(
    new Set([row?.exchange, row?.listingExchange].map(normalizeListingToken).filter(Boolean))
  )

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
 * Resolve one contract month's own identifier.
 *
 * A section's `months` only LISTS which expiries exist - it carries no conid per
 * month - and the row /iserver/secdef/search returned is the UNDERLYING, so its
 * conid is the root's, not the requested month's. `/iserver/secdef/info` is the
 * documented next hop: hand it the underlying conid, `sectype=FUT`, the month in
 * `MMMYY` and the section's exchange, and it answers with the contract's own
 * conid (with its maturity, multiplier and valid exchanges).
 *
 * The response is an array of contracts. The entries whose `symbol` and
 * `secType` match the request are kept; when the section named an exchange, an
 * entry on that exchange wins - one month can be listed on several venues and
 * the section's venue is the one whose months were matched. Remaining ties keep
 * the order IBKR returned and are logged. Nothing usable answers `undefined`,
 * and the caller fails rather than falling back to the underlying conid, which
 * is a different contract.
 */
const fetchIbkrContractMonthConid = async ({
  underlyingConid,
  secType,
  month,
  exchange,
  rootSymbol,
  accessToken,
}: {
  underlyingConid: number
  secType: string
  month: string
  exchange: string
  rootSymbol: string
  accessToken?: string
}): Promise<number | undefined> => {
  const searchParams = new URLSearchParams({
    conid: String(underlyingConid),
    // The docs spell this query parameter lowercase (`sectype`).
    sectype: secType,
    month,
    exchange,
  })

  const response = await fetchBrokerJson<
    IbkrContractInfoItem[] | { contracts?: IbkrContractInfoItem[] }
  >({
    providerId: 'ibkr',
    url: `${buildIbkrApiUrl('/iserver/secdef/info')}?${searchParams.toString()}`,
    init: {
      method: 'GET',
      headers: buildIbkrAuthHeaders({ accessToken }),
    },
  })

  const rows = Array.isArray(response) ? response : (response?.contracts ?? [])
  const requestedSymbol = normalizeListingToken(rootSymbol)
  const requestedSpec = normalizeListingToken(secType)
  const matchingRows = rows.filter((row) => {
    const rowSymbol = normalizeListingToken(row?.symbol)
    const rowSpec = normalizeListingToken(row?.secType)
    return (!rowSymbol || rowSymbol === requestedSymbol) && (!rowSpec || rowSpec === requestedSpec)
  })
  const pool = matchingRows.length > 0 ? matchingRows : rows
  const requestedExchange = normalizeListingToken(exchange)
  const venueMatch = pool.find((row) => ibkrContractExchangeTokens(row).includes(requestedExchange))
  const chosen = venueMatch ?? pool[0]
  if (pool.length > 1) {
    logger.warn('IBKR secdef/info answered one contract month with several contracts', {
      underlyingConid,
      secType,
      month,
      exchange,
      matched: pool.length,
      chosenConid: chosen?.conid,
    })
  }
  return toConid(chosen?.conid)
}

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
  // A catalogue symbol can carry its contract month (`MESZ25`). It is split off
  // here so the key is the root plus the month (see buildIbkrConidCacheKey) and
  // the search asks for the root (see ibkrSymbolCandidates).
  const contractMonth = parseIbkrFuturesContractMonth(normalizedSymbol, assetClass)
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

  /**
   * The contract month a section is selected by. An explicit one from the
   * caller is authoritative. Otherwise a contract-month symbol supplies it -
   * the only way a market-data caller has one today, because the catalogue
   * hands the expiry over glued to the symbol rather than as a field, and
   * without it the search would answer with whichever section came back first.
   *
   * A caller that states both, and states them differently, is sending a
   * contract month that is not the one it named in the symbol; that is an
   * upstream disagreement worth a log line, but the explicit month decides,
   * because it is the more specific instruction.
   */
  const explicitExpiry = context?.expiry ? normalizeListingToken(context.expiry) : ''
  const requestedExpiry = explicitExpiry
    ? [explicitExpiry]
    : contractMonth
      ? [contractMonth.expiry]
      : []
  if (explicitExpiry && contractMonth && explicitExpiry !== contractMonth.expiry) {
    logger.warn('IBKR requested expiry disagrees with the contract month in the symbol', {
      symbol: normalizedSymbol,
      symbolExpiry: contractMonth.expiry,
      requestedExpiry: explicitExpiry,
    })
  }

  /**
   * The contract month to resolve, in the `MMMYY` form secdef/info takes. It is
   * what decides whether the extra hop runs at all: a root-only lookup resolves
   * to the row's own conid exactly as before.
   */
  const requestedContractMonth = requestedExpiry.length
    ? toIbkrContractMonth(requestedExpiry[0])
    : null

  /**
   * The section a row is selected by, plus the row itself. Sec types live under
   * `sections` on the real payload; the flat `secType` field is kept for older
   * shapes. A row matching no section is skipped.
   *
   * The section is returned, not just a boolean, because the secdef/info hop
   * needs the venue those months were listed on.
   */
  const matchRequestedSection = (row: SecDefResponseItem): SecDefSection | null | undefined => {
    const sections = Array.isArray(row?.sections) ? row.sections : []
    if (sections.length === 0) {
      return (row?.secType ?? '').toUpperCase() === conidSpec ? null : undefined
    }
    return sections.find(
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
    const specMatches = rows
      .map((row) => ({ row, section: matchRequestedSection(row) }))
      .filter((match) => match.section !== undefined)
    const venueMatch = requestedExchanges.length
      ? specMatches.find((match) => matchesRequestedListing(match.row))
      : undefined
    if (requestedExchanges.length && !venueMatch && specMatches.length > 0) {
      logger.warn('IBKR returned no listing for the requested venue', {
        symbol: candidate,
        requestedExchanges,
        availableExchanges: specMatches.flatMap((match) => ibkrRowExchangeTokens(match.row)),
      })
    }

    const chosen = venueMatch ?? specMatches[0]
    const underlyingConid = toConid(chosen?.row?.conid)
    if (underlyingConid === undefined) {
      continue
    }

    // No contract month requested: the underlying's own conid is the answer,
    // exactly as before - no extra hop.
    if (!requestedContractMonth) {
      resolvedConid = underlyingConid
      break
    }

    // A specific month was requested, so the row's conid (the UNDERLYING
    // contract) is not the answer: the month has its own conid, and
    // /iserver/secdef/info is the documented hop that returns it.
    const sectionExchange = normalizeListingToken(chosen?.section?.exchange)
    if (!sectionExchange) {
      logger.warn(
        'IBKR secdef section names no exchange; falling back to the documented SMART default',
        { symbol: candidate, month: requestedContractMonth }
      )
    }
    resolvedConid = await fetchIbkrContractMonthConid({
      underlyingConid,
      secType: conidSpec,
      month: requestedContractMonth,
      exchange: sectionExchange || 'SMART',
      // The contract's own `symbol` is the underlying's, which the row names
      // more reliably than the candidate spelling that matched it (`FMES` ->
      // `MES`).
      rootSymbol: chosen?.row?.symbol || candidate,
      accessToken,
    })
    if (resolvedConid !== undefined) {
      break
    }
    // The hop named no contract for the requested month. The next candidate is
    // a different spelling of the same root, not a different month, so it is
    // worth one attempt; if it also fails the caller gets the clear error below
    // rather than the underlying's identifier, which is another contract.
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
 *
 * The key is built from the same inputs the seeding call had, which is why a
 * contract-month symbol works here without this function ever seeing an expiry:
 * buildIbkrConidCacheKey derives the month from the symbol, so a catalogue
 * symbol the caller holds (`MESZ25`) reads the entry its own lookup wrote.
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
