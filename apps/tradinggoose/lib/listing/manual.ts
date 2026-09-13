import {
  ListingIdentitySchema,
  ListingResolvedSchema,
  MANUAL_LISTING_ASSET_CLASSES,
  type ListingIdentity,
  type ListingResolved,
} from '@/lib/listing/identity'

/**
 * A listing supplied BY IDENTITY: the operator names a symbol the hosted
 * catalogue has no row for, and says what asset class it is.
 *
 * The catalogue stays the default path. Nothing here reads it, invents an id
 * or fabricates a catalogue row: the identity carries the symbol verbatim and
 * the provider decides whether it resolves. A symbol that does not resolve
 * fails with the provider's own error, in the chart, rather than charting some
 * other listing.
 */

export type ManualListingDraft = {
  /** The symbol, exactly as the operator typed it. Trimmed, never rewritten. */
  symbol: string
  assetClass: string
  marketCode?: string | null
}

/**
 * Whether the picker offers the manual path. Only when a search came back with
 * nothing: an empty query, a search still running, a failed search and a
 * search that returned rows all leave the catalogue path exactly as it was,
 * and a variable/tag value (`<block.value>`) is not a symbol at all.
 */
export const shouldOfferManualListing = ({
  query,
  busy,
  error,
  resultCount,
}: {
  query: string
  busy: boolean
  error?: string | null
  resultCount: number
}): boolean => {
  const trimmed = query.trim()
  if (!trimmed || trimmed.startsWith('<')) return false
  if (busy || error) return false
  return resultCount === 0
}

const ASSET_CLASS_PREFIX = /^([A-Za-z]+)\s*:\s*(.*)$/

/**
 * What the operator already typed, read as the picker's existing categorized
 * query syntax (`future: MESZ26`). A prefix that is not a known asset class is
 * part of the symbol, and a bare symbol leaves the asset class unset rather
 * than guessing one - the form then requires it.
 */
export const parseManualListingQuery = (raw: string): { symbol: string; assetClass?: string } => {
  const trimmed = raw.trim()
  const match = ASSET_CLASS_PREFIX.exec(trimmed)
  if (match) {
    const prefix = match[1].toLowerCase()
    if ((MANUAL_LISTING_ASSET_CLASSES as readonly string[]).includes(prefix)) {
      return { symbol: (match[2] ?? '').trim(), assetClass: prefix }
    }
  }
  return { symbol: trimmed }
}

/**
 * The identity for a draft, or null when it is not one the schema accepts.
 *
 * Validation is the identity schema's own, so the manual path cannot produce a
 * listing the rest of the app would reject. `null` is the refusal: the caller
 * shows it and hands nothing over.
 */
export const buildManualListingIdentity = (draft: ManualListingDraft): ListingIdentity | null => {
  const marketCode = draft.marketCode?.trim()
  const parsed = ListingIdentitySchema.safeParse({
    listing_id: draft.symbol.trim(),
    base_id: '',
    quote_id: '',
    listing_type: 'default',
    manual: {
      assetClass: draft.assetClass.trim().toLowerCase(),
      ...(marketCode ? { marketCode } : {}),
    },
  })
  return parsed.success ? parsed.data : null
}

/**
 * The picker's selection value: what it can show without a catalogue row.
 *
 * Name, asset class and market come from the draft; every other resolved field
 * (icon, timezone, MIC, rank) is genuinely absent and stays absent, because
 * the catalogue is the only thing that has it.
 */
export const buildManualListingValue = (
  draft: ManualListingDraft
): ListingResolved | null => {
  const listingIdentity = buildManualListingIdentity(draft)
  if (!listingIdentity) return null

  const parsed = ListingResolvedSchema.safeParse({
    listingIdentity,
    base: listingIdentity.listing_id,
    name: listingIdentity.listing_id,
    assetClass: listingIdentity.manual?.assetClass ?? null,
    marketCode: listingIdentity.manual?.marketCode ?? null,
  })
  return parsed.success ? parsed.data : null
}
