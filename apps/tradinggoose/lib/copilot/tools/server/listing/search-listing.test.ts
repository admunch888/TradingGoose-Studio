import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolArgSchemas, ToolResultSchemas } from '@/lib/copilot/registry'
import { searchListingServerTool } from '@/lib/copilot/tools/server/listing/search-listing'
import { fetchListings } from '@/lib/listing/search'

const { mockSearchIbkrListings, mockIsIbkrHostedApi } = vi.hoisted(() => ({
  mockSearchIbkrListings: vi.fn(),
  mockIsIbkrHostedApi: vi.fn(() => false),
}))

vi.mock('@/lib/listing/search', () => ({
  fetchListings: vi.fn(),
}))

vi.mock('@/providers/market/ibkr/listing-search', () => ({
  searchIbkrListings: (...args: unknown[]) => mockSearchIbkrListings(...args),
}))

vi.mock('@/providers/trading/ibkr/auth', () => ({
  isIbkrHostedApi: () => mockIsIbkrHostedApi(),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}))

const mockFetchListings = vi.mocked(fetchListings)

const mesListing = {
  listingIdentity: {
    listing_id: 'MESZ26',
    base_id: '',
    quote_id: '',
    listing_type: 'default' as const,
    manual: { assetClass: 'future' as const, marketCode: 'CME' },
  },
  base: 'MESZ26',
  name: 'Micro E-Mini S&P 500 December 2026',
  assetClass: 'future',
  marketCode: 'CME',
}

describe('searchListingServerTool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsIbkrHostedApi.mockReturnValue(false)
  })

  it('returns resolved listings containing canonical listing identities', async () => {
    const signal = new AbortController().signal
    const listing = {
      listingIdentity: {
        listing_id: 'AAPL',
        base_id: '',
        quote_id: '',
        listing_type: 'default' as const,
      },
      base: 'AAPL',
      quote: null,
      name: 'Apple Inc.',
      iconUrl: 'https://example.com/apple.png',
      assetClass: 'stock',
    }
    mockFetchListings.mockResolvedValue([listing, listing])

    const result = await searchListingServerTool.execute(
      { query: '  Apple  ' },
      { userId: 'user-1', signal }
    )

    expect(result).toEqual({ results: [listing] })
    expect(ToolResultSchemas.search_listing.parse(result)).toEqual(result)
    expect(() =>
      ToolResultSchemas.search_listing.parse({
        results: [{ ...listing, listing_id: 'AAPL' }],
      })
    ).toThrow()
    expect(mockFetchListings).toHaveBeenCalledWith({ search_query: 'Apple' }, signal)
    expect(mockSearchIbkrListings).not.toHaveBeenCalled()
  })

  it('rejects blank queries before calling the listing search helper', async () => {
    await expect(searchListingServerTool.execute({ query: '   ' })).rejects.toThrow(
      'query is required'
    )
    expect(mockFetchListings).not.toHaveBeenCalled()
  })

  it('searches the IBKR gateway directly when asked, without the catalogue', async () => {
    mockSearchIbkrListings.mockResolvedValue([mesListing])

    const result = await searchListingServerTool.execute({
      query: 'MES',
      provider: 'ibkr',
      assetClass: 'future',
    })

    expect(result).toEqual({ results: [mesListing] })
    expect(ToolResultSchemas.search_listing.parse(result)).toEqual(result)
    expect(mockSearchIbkrListings).toHaveBeenCalledWith({ query: 'MES', assetClass: 'future' })
    expect(mockFetchListings).not.toHaveBeenCalled()
  })

  it('accepts the IBKR arguments in its schema', () => {
    expect(
      ToolArgSchemas.search_listing.parse({ query: 'MES', provider: 'ibkr', assetClass: 'future' })
    ).toEqual({ query: 'MES', provider: 'ibkr', assetClass: 'future' })
    expect(() => ToolArgSchemas.search_listing.parse({ query: 'MES', provider: 'yahoo' })).toThrow()
  })

  it('falls back to IBKR when the catalogue is rate limited', async () => {
    mockFetchListings.mockRejectedValue(
      new Error('Free tier daily limit exceeded. Max 3000 requests per day.')
    )
    mockSearchIbkrListings.mockResolvedValue([mesListing])

    const result = await searchListingServerTool.execute({ query: 'MES' })

    expect(result).toEqual({ results: [mesListing] })
  })

  it('falls back to IBKR when the catalogue has no match (futures months)', async () => {
    mockFetchListings.mockResolvedValue([])
    mockSearchIbkrListings.mockResolvedValue([mesListing])

    expect(await searchListingServerTool.execute({ query: 'MESZ26' })).toEqual({
      results: [mesListing],
    })
  })

  it('returns no results when both searches find nothing and neither failed', async () => {
    mockFetchListings.mockResolvedValue([])
    mockSearchIbkrListings.mockResolvedValue([])

    expect(await searchListingServerTool.execute({ query: 'ZZZZ' })).toEqual({ results: [] })
  })

  it('tells the model to build a manual identity, not to retry, when every search fails', async () => {
    mockFetchListings.mockRejectedValue(new Error('Free tier daily limit exceeded'))
    mockSearchIbkrListings.mockRejectedValue(new Error('gateway session is not authenticated'))

    await expect(searchListingServerTool.execute({ query: 'MES' })).rejects.toMatchObject({
      status: 502,
      code: 'search_listing_backend_failed',
      retryable: false,
      hint: expect.stringContaining('"manual":{"assetClass":"future","marketCode":"CME"}'),
    })
  })

  it('skips IBKR on the hosted API and reports the catalogue failure', async () => {
    mockIsIbkrHostedApi.mockReturnValue(true)
    mockFetchListings.mockRejectedValue(new Error('backend unavailable'))

    await expect(searchListingServerTool.execute({ query: 'AAPL' })).rejects.toMatchObject({
      code: 'search_listing_backend_failed',
      retryable: false,
      hint: expect.stringContaining('listingIdentity under the listing key'),
    })
    expect(mockSearchIbkrListings).not.toHaveBeenCalled()
  })

  it('reports an explicit IBKR search failure with the manual identity hint', async () => {
    mockSearchIbkrListings.mockRejectedValue(new Error('gateway session is not authenticated'))

    await expect(
      searchListingServerTool.execute({ query: 'MES', provider: 'ibkr' })
    ).rejects.toMatchObject({
      code: 'search_listing_ibkr_failed',
      retryable: false,
      hint: expect.stringContaining('Do not retry'),
    })
  })
})
