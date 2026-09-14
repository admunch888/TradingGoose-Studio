import { StructuredServerToolError } from '@/lib/copilot/server-tool-errors'
import {
  type BaseServerTool,
  type ServerToolExecutionContext,
  throwIfServerToolAborted,
} from '@/lib/copilot/tools/server/base-tool'
import { getListingIdentityKey, type ListingResolved } from '@/lib/listing/identity'
import { fetchListings } from '@/lib/listing/search'
import { createLogger } from '@/lib/logs/console/logger'

const logger = createLogger('CopilotSearchListing')

type IbkrSearchAssetClass = 'stock' | 'etf' | 'indice' | 'future'

type SearchListingArgs = {
  query: string
  provider?: 'ibkr'
  assetClass?: IbkrSearchAssetClass
}

/**
 * The manual identity the model can fall back to. Spelled out in the error
 * because a hint that only says "retry" is what made a local model call this
 * tool five times against a rate-limited catalogue and then give up.
 */
export const SEARCH_LISTING_MANUAL_IDENTITY_HINT =
  'Do not retry search_listing with the same query. Use a listing supplied by identity instead: ' +
  '{"listing_id":"MESZ26","base_id":"","quote_id":"","listing_type":"default","manual":{"assetClass":"future","marketCode":"CME"}} ' +
  '(futures symbol = root + month letter F G H J K M N Q U V X Z + two-digit year; for a stock use assetClass "stock" and its exchange, e.g. NASDAQ). ' +
  'In watchlist listing items, put the listingIdentity under the listing key.'

const dedupe = (listings: readonly ListingResolved[]): ListingResolved[] => {
  const seen = new Set<string>()
  const results: ListingResolved[] = []
  for (const listing of listings) {
    const key = getListingIdentityKey(listing.listingIdentity)
    if (seen.has(key)) continue
    seen.add(key)
    results.push(listing)
  }
  return results
}

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError'

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message ? error.message : String(error)

/**
 * IBKR gateway search (the same one the listing picker uses). Results are
 * listings supplied by identity, so they never need the hosted catalogue again.
 */
async function searchIbkr(query: string, assetClass?: IbkrSearchAssetClass) {
  const { isIbkrHostedApi } = await import('@/providers/trading/ibkr/auth')
  if (isIbkrHostedApi()) {
    throw new Error('IBKR search needs the Client Portal Gateway')
  }
  const { searchIbkrListings } = await import('@/providers/market/ibkr/listing-search')
  return searchIbkrListings({ query, assetClass })
}

export const searchListingServerTool: BaseServerTool<
  SearchListingArgs,
  { results: ListingResolved[] }
> = {
  name: 'search_listing',
  async execute(args: SearchListingArgs, context?: ServerToolExecutionContext) {
    const query = args.query.trim()
    if (!query) {
      throw new Error('query is required')
    }

    throwIfServerToolAborted(context)

    if (args.provider === 'ibkr') {
      try {
        const results = dedupe(await searchIbkr(query, args.assetClass))
        throwIfServerToolAborted(context)
        return { results }
      } catch (error) {
        if (isAbortError(error)) throw error
        throw new StructuredServerToolError({
          status: 502,
          body: {
            code: 'search_listing_ibkr_failed',
            error: `IBKR listing search failed: ${errorMessage(error)}`,
            hint: SEARCH_LISTING_MANUAL_IDENTITY_HINT,
            retryable: false,
          },
        })
      }
    }

    let catalogueError: unknown
    try {
      const results = dedupe(await fetchListings({ search_query: query }, context?.signal))
      throwIfServerToolAborted(context)
      if (results.length > 0) return { results }
    } catch (error) {
      if (isAbortError(error)) throw error
      catalogueError = error
    }

    // The hosted catalogue failed (it is rate limited per day) or had nothing -
    // it has no futures contract months at all. Ask the IBKR gateway before
    // telling the model to build the identity itself.
    try {
      const results = dedupe(await searchIbkr(query, args.assetClass))
      throwIfServerToolAborted(context)
      if (results.length > 0 || !catalogueError) return { results }
    } catch (error) {
      if (isAbortError(error)) throw error
      logger.info('IBKR fallback for search_listing unavailable', { error: errorMessage(error) })
      if (!catalogueError) return { results: [] }
    }

    throw new StructuredServerToolError({
      status: 502,
      body: {
        code: 'search_listing_backend_failed',
        error: `Listing search failed: ${errorMessage(catalogueError)}`,
        hint: SEARCH_LISTING_MANUAL_IDENTITY_HINT,
        retryable: false,
      },
    })
  },
}
