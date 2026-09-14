/**
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnsureIbkrSession, mockFetchIbkrMarketJson, mockReadCache, mockWriteCache } =
  vi.hoisted(() => ({
    mockEnsureIbkrSession: vi.fn(),
    mockFetchIbkrMarketJson: vi.fn(),
    mockReadCache: vi.fn(),
    mockWriteCache: vi.fn(),
  }))

vi.mock('@/lib/cache/server-json-cache', () => ({
  readServerJsonCache: (...args: unknown[]) => mockReadCache(...args),
  writeServerJsonCache: (...args: unknown[]) => mockWriteCache(...args),
}))

vi.mock('@/providers/market/ibkr/pacing', () => ({
  fetchIbkrMarketJson: (...args: unknown[]) => mockFetchIbkrMarketJson(...args),
}))

vi.mock('@/providers/trading/ibkr/session', () => ({
  ensureIbkrSession: (...args: unknown[]) => mockEnsureIbkrSession(...args),
}))

vi.mock('@/providers/trading/ibkr/auth', () => ({
  buildIbkrAuthHeaders: () => ({ Accept: 'application/json' }),
  isIbkrHostedApi: () => false,
}))

vi.mock('@/providers/trading/ibkr/client', () => ({
  buildIbkrApiUrl: (path: string) => `https://gateway.local/v1/api${path}`,
  cacheIbkrConid: vi.fn(),
  getCachedIbkrConid: vi.fn(),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}))

import {
  buildIbkrFuturesContractSymbol,
  buildIbkrListingsFromSearchRows,
  searchIbkrListings,
} from '@/providers/market/ibkr/listing-search'
import { parseIbkrFuturesContractMonth } from '@/providers/trading/ibkr/symbols'

const now = new Date('2026-09-13T12:00:00Z')

const mesRow = {
  conid: '362702',
  symbol: 'MES',
  companyName: 'Micro E-Mini S&P 500 Stock Price Index',
  description: 'CME',
  sections: [
    { secType: 'IND', exchange: 'CME;' },
    { secType: 'FUT', months: 'JUN26;SEP26;DEC26;MAR27', exchange: 'CME;QBALGO' },
    { secType: 'FOP', months: 'SEP26;OCT26', exchange: 'CME' },
  ],
}

const aaplRow = {
  conid: '265598',
  symbol: 'AAPL',
  companyName: 'APPLE INC',
  description: 'NASDAQ',
  sections: [{ secType: 'STK' }, { secType: 'OPT', months: 'SEP26;OCT26', exchange: 'SMART' }],
}

describe('building listings from an IBKR search response', () => {
  it('lists upcoming futures contract months as listings supplied by identity', () => {
    const listings = buildIbkrListingsFromSearchRows([mesRow], { assetClass: 'future', now })

    expect(listings.map((listing) => listing.base)).toEqual(['MESU26', 'MESZ26', 'MESH27'])
    expect(listings[1]).toEqual({
      listingIdentity: {
        listing_id: 'MESZ26',
        base_id: '',
        quote_id: '',
        listing_type: 'default',
        manual: { assetClass: 'future', marketCode: 'CME' },
      },
      base: 'MESZ26',
      name: 'Micro E-Mini S&P 500 Stock Price Index December 2026',
      assetClass: 'future',
      marketCode: 'CME',
    })
  })

  it('spells contract months the conid resolver reads back', () => {
    expect(buildIbkrFuturesContractSymbol('MES', 'DEC26')).toBe('MESZ26')
    expect(buildIbkrFuturesContractSymbol('mes', 'mar27')).toBe('MESH27')
    expect(buildIbkrFuturesContractSymbol('MES', '202612')).toBeNull()
    expect(parseIbkrFuturesContractMonth('MESZ26', 'future', now)).toEqual({
      root: 'MES',
      expiry: 'DEC26',
    })
  })

  it('lists a stock on its primary exchange', () => {
    expect(buildIbkrListingsFromSearchRows([aaplRow], { now })).toEqual([
      expect.objectContaining({
        base: 'AAPL',
        name: 'APPLE INC',
        assetClass: 'stock',
        listingIdentity: expect.objectContaining({
          listing_id: 'AAPL',
          manual: { assetClass: 'stock', marketCode: 'NASDAQ' },
        }),
      }),
    ])
  })

  it('keeps to the requested asset class', () => {
    expect(buildIbkrListingsFromSearchRows([aaplRow], { assetClass: 'future', now })).toEqual([])
    expect(
      buildIbkrListingsFromSearchRows([mesRow], { assetClass: 'indice', now }).map((listing) => [
        listing.base,
        listing.marketCode,
      ])
    ).toEqual([['MES', 'CME']])
    expect(
      buildIbkrListingsFromSearchRows([aaplRow], { assetClass: 'etf', now })[0]?.assetClass
    ).toBe('etf')
  })

  it('drops duplicates and rows without a symbol', () => {
    const listings = buildIbkrListingsFromSearchRows([mesRow, mesRow, { conid: '1' }], {
      assetClass: 'future',
      now,
    })
    expect(listings).toHaveLength(3)
  })
})

describe('searchIbkrListings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadCache.mockResolvedValue(null)
    mockEnsureIbkrSession.mockResolvedValue(undefined)
  })

  it('asks the gateway for the futures root and caches the response', async () => {
    mockFetchIbkrMarketJson.mockResolvedValue([mesRow])

    const listings = await searchIbkrListings({ query: ' mes ', assetClass: 'future', now })

    expect(mockEnsureIbkrSession).toHaveBeenCalledTimes(1)
    const call = mockFetchIbkrMarketJson.mock.calls[0]?.[0] as { url: string; label: string }
    const url = new URL(call.url)
    expect(url.pathname).toBe('/v1/api/iserver/secdef/search')
    expect(url.searchParams.get('symbol')).toBe('MES')
    expect(url.searchParams.get('secType')).toBe('FUT')
    expect(mockWriteCache).toHaveBeenCalledWith('ibkr:listing-search:v1:FUT:MES', [mesRow], 600)
    expect(listings.map((listing) => listing.base)).toEqual(['MESU26', 'MESZ26', 'MESH27'])
  })

  it('answers from the cache without touching the gateway', async () => {
    mockReadCache.mockResolvedValue([aaplRow])

    const listings = await searchIbkrListings({ query: 'AAPL', now })

    expect(mockReadCache).toHaveBeenCalledWith('ibkr:listing-search:v1:ANY:AAPL')
    expect(mockEnsureIbkrSession).not.toHaveBeenCalled()
    expect(mockFetchIbkrMarketJson).not.toHaveBeenCalled()
    expect(listings.map((listing) => listing.base)).toEqual(['AAPL'])
  })

  it('does not search for something that is not a symbol, or an asset class IBKR search skips', async () => {
    expect(await searchIbkrListings({ query: '   ' })).toEqual([])
    expect(await searchIbkrListings({ query: '<block.value>' })).toEqual([])
    expect(await searchIbkrListings({ query: 'BTC', assetClass: 'crypto' })).toEqual([])
    expect(mockFetchIbkrMarketJson).not.toHaveBeenCalled()
  })

  it('surfaces a logged-out gateway', async () => {
    mockEnsureIbkrSession.mockRejectedValue(new Error('IBKR Client Portal Gateway session expired'))

    await expect(searchIbkrListings({ query: 'MES' })).rejects.toThrow('session expired')
    expect(mockWriteCache).not.toHaveBeenCalled()
  })
})
