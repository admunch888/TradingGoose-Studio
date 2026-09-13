import type { AssetClass } from '@/providers/market/types'
import { buildIbkrAuthHeaders, isIbkrHostedApi } from '@/providers/trading/ibkr/auth'
import {
  buildIbkrApiUrl,
  cacheIbkrConid,
  getCachedIbkrConid,
} from '@/providers/trading/ibkr/client'
import { fetchBrokerJson } from '@/providers/trading/portfolio-utils'

export interface IbkrConidResolution {
  conid: number
  conidSpec: string
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

export const buildIbkrConidCacheKey = (symbol: string, assetClass?: AssetClass | null): string =>
  `${resolveIbkrConidSpec(assetClass)}:${symbol.trim().toUpperCase()}`

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
  conid?: string | number
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
  sections?: SecDefSection[]
}

/**
 * Resolve an IBKR contract identifier for a symbol and seed the in-memory
 * conid cache. Call this ahead of order submission — the shared order pipeline
 * is synchronous and reads conid values from the cache (see resolveIbkrConid).
 */
export async function resolveIbkrConidFromApi({
  symbol,
  assetClass,
  accessToken,
}: {
  symbol: string
  assetClass?: AssetClass | null
  accessToken?: string
}): Promise<IbkrConidResolution> {
  const normalizedSymbol = symbol.trim().toUpperCase()
  if (!normalizedSymbol) {
    throw new Error('IBKR order requires a symbol')
  }

  const conidSpec = resolveIbkrConidSpec(assetClass)
  const cacheKey = buildIbkrConidCacheKey(normalizedSymbol, assetClass)
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

  // Sec types live under `sections` on the real payload; the flat `secType`
  // field is kept for older shapes. A row matching no section is skipped.
  const matchesRequestedSpec = (row: SecDefResponseItem): boolean => {
    const sections = Array.isArray(row?.sections) ? row.sections : []
    if (sections.length === 0) {
      return (row?.secType ?? '').toUpperCase() === conidSpec
    }
    return sections.some((section) => (section?.secType ?? '').toUpperCase() === conidSpec)
  }

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
    const rawConid = rows.find(matchesRequestedSpec)?.conid
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
}: {
  symbol: string
  assetClass?: AssetClass | null
}): IbkrConidResolution {
  const normalizedSymbol = symbol.trim().toUpperCase()
  if (!normalizedSymbol) {
    throw new Error('IBKR order requires a symbol')
  }

  const conidSpec = resolveIbkrConidSpec(assetClass)
  const cacheKey = buildIbkrConidCacheKey(normalizedSymbol, assetClass)
  const cachedConid = getCachedIbkrConid(cacheKey)
  if (cachedConid !== undefined) {
    return { conid: cachedConid, conidSpec }
  }

  throw new Error(
    `IBKR contract identifier not resolved for symbol ${normalizedSymbol}. ` +
      'Run resolveIbkrConidFromApi first so the conid cache is seeded for order submission.'
  )
}
