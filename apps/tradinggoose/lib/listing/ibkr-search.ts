import { type ListingResolved, ListingResolvedSchema } from '@/lib/listing/identity'

export const IBKR_LISTING_SEARCH_PROVIDER_ID = 'ibkr'

/**
 * Whether the picker searches the IBKR gateway instead of the listing
 * catalogue. The market provider decides, because it is what charts the
 * listing; a trading-only picker (no market provider) follows its broker.
 */
export const shouldSearchIbkrListings = ({
  marketProviderId,
  tradingProviderId,
}: {
  marketProviderId?: string
  tradingProviderId?: string
}): boolean =>
  marketProviderId
    ? marketProviderId === IBKR_LISTING_SEARCH_PROVIDER_ID
    : tradingProviderId === IBKR_LISTING_SEARCH_PROVIDER_ID

export async function fetchIbkrListings(
  { query, assetClass }: { query: string; assetClass?: string | null },
  signal?: AbortSignal
): Promise<ListingResolved[]> {
  const params = new URLSearchParams({ q: query })
  if (assetClass) params.set('asset_class', assetClass)

  const response = await fetch(`/api/providers/trading/ibkr/listing-search?${params.toString()}`, {
    signal,
  })
  const payload = (await response.json().catch(() => null)) as {
    data?: unknown[]
    error?: string
  } | null
  if (!response.ok) {
    throw new Error(payload?.error || `IBKR search failed with ${response.status}`)
  }

  return (payload?.data ?? []).flatMap((row) => {
    const parsed = ListingResolvedSchema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
}
