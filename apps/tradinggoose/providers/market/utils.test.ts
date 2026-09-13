/**
 * @vitest-environment node
 *
 * resolveListingContext is the ONE place a market request is required to
 * originate from the hosted catalogue: it resolved nothing for a symbol with no
 * catalogue row and answered the chart with `Listing could not be resolved`.
 *
 * A listing supplied by identity carries its own asset class, so the catalogue
 * is not consulted at all; a listing with no manual descriptor still fails
 * loudly, and nothing is ever substituted.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveListingIdentity: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@/lib/listing/resolve', () => ({
  resolveListingIdentity: (...args: unknown[]) => mocks.resolveListingIdentity(...args),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: () => mocks.logger,
}))

const catalogueIdentity = {
  listing_id: 'AAPL',
  base_id: '',
  quote_id: '',
  listing_type: 'default' as const,
}

const manualIdentity = {
  listing_id: 'MESZ26',
  base_id: '',
  quote_id: '',
  listing_type: 'default' as const,
  manual: { assetClass: 'future' as const, marketCode: 'CME' },
}

describe('resolveListingContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('supplies a hand-authored identity from the identity itself, without a catalogue read', async () => {
    const { resolveListingContext } = await import('./utils')

    const context = await resolveListingContext(manualIdentity)

    expect(mocks.resolveListingIdentity).not.toHaveBeenCalled()
    expect(context).toEqual({
      listing: manualIdentity,
      base: 'MESZ26',
      quote: undefined,
      assetClass: 'future',
      marketCode: 'CME',
      countryCode: undefined,
      cityName: undefined,
      timeZoneName: undefined,
    })
  })

  it('asks the provider for the symbol that was named, and nothing else', async () => {
    const { resolveListingContext, resolveProviderSymbol } = await import('./utils')
    const { ibkrMarketProviderConfig } = await import('@/providers/market/ibkr/config')

    const context = await resolveListingContext(manualIdentity)

    expect(resolveProviderSymbol(ibkrMarketProviderConfig, context)).toBe('MESZ26')
  })

  it('still resolves a catalogue listing through the catalogue', async () => {
    mocks.resolveListingIdentity.mockResolvedValue({
      listingIdentity: catalogueIdentity,
      base: 'AAPL',
      assetClass: 'stock',
      marketCode: 'XNAS',
    })
    const { resolveListingContext } = await import('./utils')

    const context = await resolveListingContext(catalogueIdentity)

    expect(mocks.resolveListingIdentity).toHaveBeenCalledWith(catalogueIdentity)
    expect(context.base).toBe('AAPL')
    expect(context.assetClass).toBe('stock')
  })

  it('fails loudly rather than substituting when a catalogue listing resolves to nothing', async () => {
    mocks.resolveListingIdentity.mockResolvedValue(null)
    const { resolveListingContext } = await import('./utils')
    const { MarketProviderError } = await import('@/providers/market/errors')

    const failure = await resolveListingContext(catalogueIdentity).catch((error) => error)

    expect(failure).toBeInstanceOf(MarketProviderError)
    expect(failure).toMatchObject({
      code: 'LISTING RESOLVE FAILED',
      message: 'Listing could not be resolved',
      status: 422,
    })
  })

  it('keeps the catalogue transport failure for a catalogue listing', async () => {
    mocks.resolveListingIdentity.mockRejectedValue(new Error('Market search failed: listing'))
    const { resolveListingContext } = await import('./utils')

    await expect(resolveListingContext(catalogueIdentity)).rejects.toThrow(
      'Market search failed: listing'
    )
  })
})
