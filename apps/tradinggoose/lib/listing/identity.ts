import { z } from 'zod'
import { MARKET_ASSET_CLASSES } from '@/providers/market/types'

const LISTING_TYPES = ['default', 'crypto', 'currency'] as const

export type ListingType = (typeof LISTING_TYPES)[number]

export const LISTING_IDENTITY_VALUE_TYPE = 'listingIdentity' as const

/**
 * The asset classes a listing supplied BY IDENTITY may name.
 *
 * Exactly the classes whose catalogue row is what carries their asset class,
 * minus the pair families: a crypto or currency listing already states its
 * base/quote codes and takes its details from the currency/crypto catalogues,
 * so there is no symbol to supply by identity. Derived from the canonical list
 * so a new asset class cannot be forgotten here.
 */
export const MANUAL_LISTING_ASSET_CLASSES = MARKET_ASSET_CLASSES.filter(
  (assetClass) => assetClass !== 'crypto' && assetClass !== 'currency'
)

export type ManualListingAssetClass = (typeof MANUAL_LISTING_ASSET_CLASSES)[number]

/**
 * What a listing supplied by identity has to carry that its catalogue row
 * would have carried: the asset class the provider picks its instrument type
 * from (IBKR's secType is `FUT` only because the row said `future`), and
 * optionally the venue, which scopes a symbol listed in several places.
 *
 * Its presence is the opt-in. It is what tells the provider to resolve the
 * listing from the identity itself instead of the catalogue, so an identity
 * without it keeps behaving exactly as before.
 */
export const ListingManualEntrySchema = z
  .object({
    assetClass: z.enum(
      MANUAL_LISTING_ASSET_CLASSES as unknown as [
        ManualListingAssetClass,
        ...ManualListingAssetClass[],
      ]
    ),
    marketCode: z.string().trim().min(1).optional(),
  })
  .strict()

export type ListingManualEntry = z.infer<typeof ListingManualEntrySchema>

export const LISTING_IDENTITY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    listing_id: {
      type: 'string',
      description: 'Listing id for default listings; otherwise empty.',
    },
    base_id: { type: 'string', description: 'Base asset id for pair listings; otherwise empty.' },
    quote_id: { type: 'string', description: 'Quote asset id for pair listings; otherwise empty.' },
    listing_type: {
      type: 'string',
      enum: LISTING_TYPES,
      description: 'Listing type.',
    },
    manual: {
      type: 'object',
      description:
        'Present when the listing is supplied by identity because the catalogue has no row for it. Sets the asset class the provider resolves the symbol with, and optionally the market. Omit for catalogue listings.',
      properties: {
        assetClass: {
          type: 'string',
          enum: MANUAL_LISTING_ASSET_CLASSES,
          description: 'Asset class of the listing supplied by identity.',
        },
        marketCode: {
          type: 'string',
          description: 'Market the symbol trades on; empty when unknown.',
        },
      },
      required: ['assetClass'],
      additionalProperties: false,
    },
  },
  required: ['listing_id', 'base_id', 'quote_id', 'listing_type'],
  additionalProperties: false,
}

export const ListingIdentitySchema = z
  .object({
    listing_id: z.string().trim(),
    base_id: z.string().trim(),
    quote_id: z.string().trim(),
    listing_type: z.enum(LISTING_TYPES),
    manual: ListingManualEntrySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.listing_type === 'default') {
      if (!value.listing_id || value.base_id || value.quote_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Default listing identities require listing_id and empty base_id/quote_id',
        })
      }
      return
    }

    if (value.manual) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only default listing identities may be supplied by identity',
      })
    }

    if (value.listing_id || !value.base_id || !value.quote_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Pair listing identities require base_id/quote_id and empty listing_id',
      })
    }
  })

export type ListingIdentity = z.infer<typeof ListingIdentitySchema>

const OptionalListingDetailSchema = z.string().trim().nullable().optional()

export const ListingResolvedSchema = z
  .object({
    listingIdentity: ListingIdentitySchema,
    base: z.string().trim().min(1),
    quote: OptionalListingDetailSchema,
    name: OptionalListingDetailSchema,
    iconUrl: OptionalListingDetailSchema,
    assetClass: OptionalListingDetailSchema,
    primaryMicCode: OptionalListingDetailSchema,
    marketCode: OptionalListingDetailSchema,
    countryCode: OptionalListingDetailSchema,
    cityName: OptionalListingDetailSchema,
    timeZoneName: OptionalListingDetailSchema,
    base_asset_class: OptionalListingDetailSchema,
    quote_asset_class: OptionalListingDetailSchema,
  })
  .strict()

export type ListingResolved = z.infer<typeof ListingResolvedSchema>

export type ListingInputValue = ListingIdentity | ListingResolved | string | null | undefined

export const getListingIdentitySymbol = (listing: ListingIdentity) =>
  listing.listing_type === 'default' ? listing.listing_id : `${listing.base_id}/${listing.quote_id}`

export const toListingValueObject = (value: unknown): ListingIdentity | null => {
  const resolved = ListingResolvedSchema.safeParse(value)
  if (resolved.success) return resolved.data.listingIdentity

  const identity = ListingIdentitySchema.safeParse(value)
  return identity.success ? identity.data : null
}

export const areListingIdentitiesEqual = (
  left?: ListingIdentity | null,
  right?: ListingIdentity | null
) => {
  if (!left || !right) return false
  return (
    left.listing_type === right.listing_type &&
    left.listing_id === right.listing_id &&
    left.base_id === right.base_id &&
    left.quote_id === right.quote_id &&
    getListingManualSignature(left.manual) === getListingManualSignature(right.manual)
  )
}

/**
 * A listing supplied by identity is a different listing from the catalogue
 * listing that happens to share its symbol: the manual one carries an asset
 * class the catalogue row would have carried, and the chart must reload when
 * one is swapped for the other. Identities carrying no manual entry keep the
 * key they have always had.
 */
const getListingManualSignature = (manual?: ListingManualEntry | null): string =>
  manual ? `manual:${manual.assetClass}:${manual.marketCode ?? ''}` : ''

export const getListingIdentityKey = (listing: ListingIdentity) => {
  const signature = getListingManualSignature(listing.manual)
  const base = `${listing.listing_type}|${listing.listing_id}|${listing.base_id}|${listing.quote_id}`
  return signature ? `${base}|${signature}` : base
}

export const parseListingIdentityValueStrict = (value: unknown): ListingIdentity => {
  let parsedValue = value
  if (typeof value === 'string' && value.trim()) {
    try {
      parsedValue = JSON.parse(value.trim())
    } catch {
      throw new Error('Invalid listingIdentity value')
    }
  }

  const listing = ListingIdentitySchema.safeParse(parsedValue)
  if (!listing.success) throw new Error('Invalid listingIdentity value')
  return listing.data
}
