import { readServerJsonCache, writeServerJsonCache } from '@/lib/cache/server-json-cache'
import {
  getListingIdentityKey,
  type ListingResolved,
  ListingResolvedSchema,
} from '@/lib/listing/identity'
import { fetchIbkrMarketJson } from '@/providers/market/ibkr/pacing'
import type { AssetClass } from '@/providers/market/types'
import { buildIbkrAuthHeaders } from '@/providers/trading/ibkr/auth'
import { buildIbkrApiUrl } from '@/providers/trading/ibkr/client'
import { ensureIbkrSession } from '@/providers/trading/ibkr/session'
import {
  describeIbkrContractMonth,
  IBKR_FUTURES_MONTH_NAMES,
  isIbkrContractMonthInThePast,
} from '@/providers/trading/ibkr/symbols'

/**
 * Listing search answered by the IBKR gateway instead of the hosted listing
 * catalogue.
 *
 * Every result is a listing supplied BY IDENTITY (`listing.manual`): it names
 * its own asset class and venue, so charting or trading it never asks the
 * catalogue what it is. The symbol is the one the conid resolver already reads
 * (`AAPL` scoped to `NASDAQ`, `MESZ26` scoped to `CME`), so a picked result
 * resolves exactly as a hand-typed manual listing does.
 */

/** The asset classes IBKR search can answer, and the secType each asks for. */
const IBKR_SEARCH_SEC_TYPES: Partial<Record<AssetClass, string>> = {
  stock: 'STK',
  etf: 'STK',
  indice: 'IND',
  future: 'FUT',
}

export const IBKR_LISTING_SEARCH_ASSET_CLASSES = Object.keys(IBKR_SEARCH_SEC_TYPES) as AssetClass[]

/** Contract months offered per futures venue; IBKR lists years ahead for some roots. */
const MAX_FUTURES_MONTHS_PER_VENUE = 6
const MAX_QUERY_LENGTH = 32
const SEARCH_CACHE_PREFIX = 'ibkr:listing-search:v1:'
const SEARCH_CACHE_TTL_SECONDS = 60 * 10

export interface IbkrSecDefSearchSection {
  secType?: string
  months?: string
  exchange?: string
}

/** A row of /iserver/secdef/search: a bare array, conid as a string. */
export interface IbkrSecDefSearchRow {
  conid?: number | string
  symbol?: string | null
  companyName?: string | null
  companyHeader?: string | null
  /** The primary exchange for a listing row. */
  description?: string | null
  sections?: IbkrSecDefSearchSection[]
}

const MONTH_LETTER_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(IBKR_FUTURES_MONTH_NAMES).map(([letter, name]) => [name, letter])
)

const normalizeToken = (value?: string | null): string =>
  typeof value === 'string' ? value.trim().toUpperCase() : ''

/** `CME;QBALGO` -> `CME`: the first venue a semicolon list names. */
const firstExchange = (value?: string | null): string => normalizeToken(value?.split(';')[0]) || ''

const sectionMonths = (section: IbkrSecDefSearchSection): string[] =>
  typeof section.months === 'string'
    ? section.months
        .split(/[;,\s]+/)
        .map(normalizeToken)
        .filter((token) => /^[A-Z]{3}\d{2}$/.test(token))
    : []

/**
 * `MES` + `DEC26` -> `MESZ26`, the contract-month symbol the conid resolver
 * splits back into root and month. Null for a month token it cannot spell.
 */
export const buildIbkrFuturesContractSymbol = (root: string, month: string): string | null => {
  const match = /^([A-Z]{3})(\d{2})$/.exec(normalizeToken(month))
  const letter = match ? MONTH_LETTER_BY_NAME[match[1]] : undefined
  return match && letter ? `${normalizeToken(root)}${letter}${match[2]}` : null
}

const toListing = ({
  symbol,
  name,
  assetClass,
  marketCode,
}: {
  symbol: string
  name: string
  assetClass: AssetClass
  marketCode: string
}): ListingResolved | null => {
  const parsed = ListingResolvedSchema.safeParse({
    listingIdentity: {
      listing_id: symbol,
      base_id: '',
      quote_id: '',
      listing_type: 'default',
      manual: { assetClass, ...(marketCode ? { marketCode } : {}) },
    },
    base: symbol,
    name,
    assetClass,
    marketCode: marketCode || null,
  })
  return parsed.success ? parsed.data : null
}

/**
 * The listings a search response describes, filtered to one asset class when
 * the caller asked for one.
 *
 * A futures section becomes one listing per upcoming contract month on its
 * venue - IBKR charts a contract month, not the root - with expired months
 * dropped and the nearest ones first, in the order IBKR listed them.
 */
export const buildIbkrListingsFromSearchRows = (
  rows: readonly IbkrSecDefSearchRow[],
  { assetClass, now = new Date() }: { assetClass?: AssetClass | null; now?: Date } = {}
): ListingResolved[] => {
  const listings: ListingResolved[] = []
  const seen = new Set<string>()
  const push = (listing: ListingResolved | null) => {
    if (!listing) return
    const key = getListingIdentityKey(listing.listingIdentity)
    if (seen.has(key)) return
    seen.add(key)
    listings.push(listing)
  }
  const wants = (candidate: AssetClass) => !assetClass || assetClass === candidate

  for (const row of rows) {
    const symbol = normalizeToken(row?.symbol)
    if (!symbol) continue
    const companyName = row.companyName?.trim() || row.companyHeader?.trim() || symbol
    const sections = Array.isArray(row.sections) ? row.sections : []
    const secTypes = new Set(sections.map((section) => normalizeToken(section?.secType)))

    if (secTypes.has('STK') && (wants('stock') || wants('etf'))) {
      push(
        toListing({
          symbol,
          name: companyName,
          assetClass: assetClass === 'etf' ? 'etf' : 'stock',
          marketCode: firstExchange(row.description),
        })
      )
    }

    for (const section of sections) {
      const secType = normalizeToken(section?.secType)

      if (secType === 'IND' && wants('indice')) {
        push(
          toListing({
            symbol,
            name: companyName,
            assetClass: 'indice',
            marketCode: firstExchange(section.exchange) || firstExchange(row.description),
          })
        )
      }

      if (secType === 'FUT' && wants('future')) {
        const marketCode = firstExchange(section.exchange)
        const months = sectionMonths(section)
          .filter((month) => !isIbkrContractMonthInThePast(month, now))
          .slice(0, MAX_FUTURES_MONTHS_PER_VENUE)
        for (const month of months) {
          const contractSymbol = buildIbkrFuturesContractSymbol(symbol, month)
          if (!contractSymbol) continue
          const monthLabel = describeIbkrContractMonth(month, now) ?? month
          push(
            toListing({
              symbol: contractSymbol,
              name: `${companyName} ${monthLabel}`,
              assetClass: 'future',
              marketCode,
            })
          )
        }
      }
    }
  }

  return listings
}

/** The symbol IBKR is asked for, or null when the query cannot be one. */
export const normalizeIbkrSearchSymbol = (query: string): string | null => {
  const symbol = query.trim().toUpperCase()
  if (!symbol || symbol.length > MAX_QUERY_LENGTH || !/^[A-Z0-9.\-/ &]+$/.test(symbol)) {
    return null
  }
  return symbol
}

/**
 * Search IBKR for a symbol. Responses are cached per symbol and secType for ten
 * minutes: a picker re-opened or re-typed does not reach the gateway again, and
 * the gateway pacer keeps a burst from colliding with chart polling.
 */
export async function searchIbkrListings({
  query,
  assetClass,
  accessToken,
  now = new Date(),
}: {
  query: string
  assetClass?: AssetClass | null
  accessToken?: string
  now?: Date
}): Promise<ListingResolved[]> {
  const symbol = normalizeIbkrSearchSymbol(query)
  if (!symbol) return []
  if (assetClass && !IBKR_SEARCH_SEC_TYPES[assetClass]) return []

  const secType = assetClass ? IBKR_SEARCH_SEC_TYPES[assetClass] : undefined
  const cacheKey = `${SEARCH_CACHE_PREFIX}${secType ?? 'ANY'}:${symbol}`
  let rows = await readServerJsonCache<IbkrSecDefSearchRow[]>(cacheKey)

  if (!rows) {
    await ensureIbkrSession({ accessToken })
    const params = new URLSearchParams({ symbol })
    if (secType && secType !== 'STK') params.set('secType', secType)
    const response = await fetchIbkrMarketJson<
      IbkrSecDefSearchRow[] | { contracts?: IbkrSecDefSearchRow[] }
    >({
      url: `${buildIbkrApiUrl('/iserver/secdef/search')}?${params.toString()}`,
      init: {
        method: 'POST',
        headers: { ...buildIbkrAuthHeaders({ accessToken }), 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      },
      label: 'secdef-search',
    })
    rows = Array.isArray(response) ? response : (response?.contracts ?? [])
    await writeServerJsonCache(cacheKey, rows, SEARCH_CACHE_TTL_SECONDS)
  }

  return buildIbkrListingsFromSearchRows(rows, { assetClass, now })
}
