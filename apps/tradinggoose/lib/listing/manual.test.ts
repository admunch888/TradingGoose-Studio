/**
 * A listing supplied BY IDENTITY: the escape hatch for a symbol the hosted
 * catalogue has no row for (measured: no IBKR futures row exists for MES, so
 * `?search_query=MES` answers with fuzzy name matches and `?search_query=MESZ26`
 * answers `{"data":[]}`).
 *
 * The identity is authored locally and must never be silently replaced by a
 * catalogue row - the provider is asked for exactly the symbol the operator
 * named, and nothing else.
 */

import { describe, expect, it } from 'vitest'
import {
  getListingIdentityKey,
  ListingIdentitySchema,
  ListingResolvedSchema,
} from '@/lib/listing/identity'
import {
  buildManualListingIdentity,
  buildManualListingValue,
  parseManualListingQuery,
  shouldOfferManualListing,
} from '@/lib/listing/manual'

const catalogueIdentity = {
  listing_id: 'MESZ26',
  base_id: '',
  quote_id: '',
  listing_type: 'default' as const,
}

describe('manual listing identity schema', () => {
  it('accepts a hand-authored identity that names its own asset class', () => {
    const parsed = ListingIdentitySchema.parse({
      ...catalogueIdentity,
      manual: { assetClass: 'future' },
    })

    expect(parsed).toEqual({
      ...catalogueIdentity,
      manual: { assetClass: 'future' },
    })
  })

  it('carries an optional market and rejects anything else', () => {
    expect(
      ListingIdentitySchema.parse({
        ...catalogueIdentity,
        manual: { assetClass: 'future', marketCode: ' CME ' },
      }).manual
    ).toEqual({ assetClass: 'future', marketCode: 'CME' })

    for (const manual of [
      { assetClass: 'spaceship' },
      { assetClass: 'future', exchange: 'CME' },
      {},
      { assetClass: '' },
    ]) {
      expect(() => ListingIdentitySchema.parse({ ...catalogueIdentity, manual })).toThrow()
    }
  })

  it('refuses a manual descriptor on a pair listing', () => {
    // A pair listing's base/quote already come from the currency/crypto
    // catalogue families; there is no symbol to supply by identity.
    expect(() =>
      ListingIdentitySchema.parse({
        listing_id: '',
        base_id: 'BTC',
        quote_id: 'USD',
        listing_type: 'crypto',
        manual: { assetClass: 'future' },
      })
    ).toThrow()
  })

  it('keys a manual identity apart from a catalogue identity for the same symbol', () => {
    const manual = { ...catalogueIdentity, manual: { assetClass: 'future' as const } }

    expect(getListingIdentityKey(manual)).not.toBe(getListingIdentityKey(catalogueIdentity))
    // Every identity that carries no manual descriptor keeps its existing key.
    expect(getListingIdentityKey(catalogueIdentity)).toBe('default|MESZ26||')
  })
})

describe('building a listing by identity', () => {
  it('validates the draft and returns null instead of guessing', () => {
    for (const draft of [
      { symbol: '   ', assetClass: 'future' },
      { symbol: 'MESZ26', assetClass: '' },
      { symbol: 'MESZ26', assetClass: 'spaceship' },
    ]) {
      expect(buildManualListingIdentity(draft)).toBeNull()
      expect(buildManualListingValue(draft)).toBeNull()
    }
  })

  it('builds an identity whose symbol is the one typed, verbatim', () => {
    // Trimmed, never upcased or rewritten: a provider resolves the symbol, and
    // the app has no business changing it on the way there.
    expect(buildManualListingIdentity({ symbol: ' mesz26 ', assetClass: 'future' })).toEqual({
      listing_id: 'mesz26',
      base_id: '',
      quote_id: '',
      listing_type: 'default',
      manual: { assetClass: 'future' },
    })

    expect(
      buildManualListingValue({ symbol: 'MESZ26', assetClass: 'future', marketCode: 'CME' })
    ).toEqual({
      listingIdentity: {
        listing_id: 'MESZ26',
        base_id: '',
        quote_id: '',
        listing_type: 'default',
        manual: { assetClass: 'future', marketCode: 'CME' },
      },
      base: 'MESZ26',
      assetClass: 'future',
      marketCode: 'CME',
      name: 'MESZ26',
    })
  })

  it('produces a value the resolved-listing schema accepts', () => {
    const value = buildManualListingValue({ symbol: 'MESZ26', assetClass: 'future' })

    expect(value && ListingResolvedSchema.safeParse(value).success).toBe(true)
  })
})

describe('whether the picker offers the manual path', () => {
  const base = { query: 'MESZ26', busy: false, error: undefined, resultCount: 0 }

  it('offers it when a search came back with nothing', () => {
    expect(shouldOfferManualListing(base)).toBe(true)
    expect(shouldOfferManualListing({ ...base, query: '  MESZ26 ' })).toBe(true)
  })

  it('stays out of the way of the catalogue in every other case', () => {
    expect(shouldOfferManualListing({ ...base, resultCount: 1 })).toBe(false)
    expect(shouldOfferManualListing({ ...base, busy: true })).toBe(false)
    expect(shouldOfferManualListing({ ...base, error: 'Market search failed' })).toBe(false)
    expect(shouldOfferManualListing({ ...base, query: '   ' })).toBe(false)
    expect(shouldOfferManualListing({ ...base, query: '<block.value>' })).toBe(false)
  })
})

describe('prefilling the manual form from what was typed', () => {
  it('reads the asset-class prefix the search syntax already supports', () => {
    expect(parseManualListingQuery('future: MESZ26')).toEqual({
      symbol: 'MESZ26',
      assetClass: 'future',
    })
  })

  it('keeps a bare symbol and leaves the asset class unset rather than guessing', () => {
    expect(parseManualListingQuery('MESZ26')).toEqual({ symbol: 'MESZ26' })
    expect(parseManualListingQuery('spaceship: MESZ26')).toEqual({ symbol: 'spaceship: MESZ26' })
  })
})
