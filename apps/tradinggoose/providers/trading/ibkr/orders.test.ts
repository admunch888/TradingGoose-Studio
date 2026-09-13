import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cacheIbkrConid,
  clearIbkrConidCache,
  getCachedIbkrConid,
} from '@/providers/trading/ibkr/client'
import { buildIbkrOrderRequest, prepareIbkrOrderRequest } from '@/providers/trading/ibkr/orders'
import { buildIbkrConidCacheKey } from '@/providers/trading/ibkr/symbols'
import { fetchBrokerJson } from '@/providers/trading/portfolio-utils'

vi.mock('@/providers/trading/portfolio-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/providers/trading/portfolio-utils')>()
  return { ...actual, fetchBrokerJson: vi.fn() }
})

const baseParams = {
  listing: {
    listing_id: 'AAPL',
    base_id: '',
    quote_id: '',
    listing_type: 'default' as const,
  },
  side: 'buy' as const,
  orderType: 'market' as const,
  timeInForce: 'day' as const,
  accessToken: 'test-token',
  accountId: 'DU123456',
  quantity: 10,
  orderSizingMode: 'quantity' as const,
}

describe('buildIbkrOrderRequest', () => {
  beforeEach(() => {
    clearIbkrConidCache()
    cacheIbkrConid(buildIbkrConidCacheKey('AAPL', 'stock'), 265598)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('builds a market order request', () => {
    const request = buildIbkrOrderRequest(baseParams)

    expect(request.url).toBe('http://127.0.0.1:5000/v1/api/portfolio/DU123456/orders')
    expect(request.method).toBe('POST')
    expect(request.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    })
    // Gateway mode authenticates with the browser session, so no bearer token.
    expect(request.headers).not.toHaveProperty('Authorization')
    expect(request.body).toMatchObject({
      conid: 265598,
      conidSpec: 'STK',
      side: 'BUY',
      quantity: '10',
      orderType: 'MKT',
      tif: 'DAY',
    })
  })

  it('maps clientOrderId to orderRef', () => {
    const request = buildIbkrOrderRequest({
      ...baseParams,
      clientOrderId: 'tg-abc123',
    })

    expect(request.body).toMatchObject({ orderRef: 'tg-abc123' })
  })

  it('builds a limit order with price', () => {
    const request = buildIbkrOrderRequest({
      ...baseParams,
      orderType: 'limit',
      limitPrice: 250.5,
    })

    expect(request.body).toMatchObject({
      orderType: 'LMT',
      price: 250.5,
    })
  })

  it('builds a stop order with auxPrice', () => {
    const request = buildIbkrOrderRequest({
      ...baseParams,
      orderType: 'stop',
      stopPrice: 240,
    })

    expect(request.body).toMatchObject({
      orderType: 'STP',
      auxPrice: 240,
    })
  })

  it('builds a stop limit order', () => {
    const request = buildIbkrOrderRequest({
      ...baseParams,
      orderType: 'stop_limit',
      stopPrice: 240,
      limitPrice: 238,
    })

    expect(request.body).toMatchObject({
      orderType: 'STP LMT',
      auxPrice: 240,
      price: 238,
    })
  })

  it('builds a trailing stop with trailPrice', () => {
    const request = buildIbkrOrderRequest({
      ...baseParams,
      orderType: 'trailing_stop',
      trailPrice: 1.5,
    })

    expect(request.body).toMatchObject({
      orderType: 'TRAIL',
      auxPrice: 1.5,
    })
  })

  it('builds a trailing stop with trailPercent', () => {
    const request = buildIbkrOrderRequest({
      ...baseParams,
      orderType: 'trailing_stop',
      trailPercent: 2,
    })

    expect(request.body).toMatchObject({
      orderType: 'TRAIL',
      trailingPercent: 2,
    })
  })

  it('rejects trailing stop without trail fields', () => {
    expect(() =>
      buildIbkrOrderRequest({
        ...baseParams,
        orderType: 'trailing_stop',
      })
    ).toThrow('either trailPrice or trailPercent')
  })

  it('rejects notional sizing', () => {
    expect(() =>
      buildIbkrOrderRequest({
        ...baseParams,
        orderSizingMode: 'notional',
        notional: 1000,
      })
    ).toThrow('notional')
  })

  it('rejects missing quantity', () => {
    expect(() =>
      buildIbkrOrderRequest({
        ...baseParams,
        quantity: undefined as unknown as number,
      })
    ).toThrow('quantity')
  })

  it('rejects unsupported order type', () => {
    expect(() =>
      buildIbkrOrderRequest({
        ...baseParams,
        orderType: 'pegged' as never,
      })
    ).toThrow('Unsupported order type')
  })

  it('throws when conid is not cached', () => {
    clearIbkrConidCache()
    expect(() => buildIbkrOrderRequest(baseParams)).toThrow('contract identifier not resolved')
  })

  it('sells short as negative quantity', () => {
    const request = buildIbkrOrderRequest({
      ...baseParams,
      side: 'sell',
      quantity: 5,
    })

    expect(request.body).toMatchObject({
      side: 'SELL',
      quantity: '5',
    })
  })

  it('sends a bearer token and the originating ip against the hosted API', () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'https://api.ibkr.com/v1/api')

    const request = buildIbkrOrderRequest(baseParams)

    expect(request.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer test-token',
      ip: '127.0.0.1',
      'Content-Type': 'application/json',
    })
  })
})

/**
 * The order pipeline reads the contract identifier synchronously, and the cache
 * it reads is process-local. Nothing seeds it unless an IBKR market-data fetch
 * happened to run first in the same process, so an order from a tool, a block,
 * or the quick order widget with its quote query off used to fail with
 * 'contract identifier not resolved' before it reached the gateway.
 */
describe('prepareIbkrOrderRequest', () => {
  const aaplSecDefRows = [
    { conid: '265598', symbol: 'AAPL', description: 'NASDAQ', sections: [{ secType: 'STK' }] },
    { conid: '532640894', symbol: 'AAPL', description: 'TSE', sections: [{ secType: 'STK' }] },
  ]

  beforeEach(() => {
    clearIbkrConidCache()
    vi.mocked(fetchBrokerJson).mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('seeds the conid cache so a cold-cache order can be built', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockResolvedValue(aaplSecDefRows as never)

    // Without the seed, buildIbkrOrderRequest throws 'contract identifier not
    // resolved' and the order never reaches the gateway.
    await prepareIbkrOrderRequest(baseParams)
    const request = buildIbkrOrderRequest(baseParams)

    expect(request.body).toMatchObject({ conid: 265598, side: 'BUY', quantity: '10' })
  })

  it('seeds the exact key the synchronous order path reads', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockResolvedValue(aaplSecDefRows as never)

    await prepareIbkrOrderRequest(baseParams)

    expect(getCachedIbkrConid(buildIbkrConidCacheKey('AAPL', 'stock'))).toBe(265598)
  })

  it('scopes the seeded entry to the listing the order is for', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockResolvedValue(aaplSecDefRows as never)
    const listing = {
      listingIdentity: {
        listing_id: 'AAPL',
        base_id: '',
        quote_id: '',
        listing_type: 'default' as const,
      },
      base: 'AAPL',
      quote: 'USD',
      marketCode: 'XNAS',
    }

    await prepareIbkrOrderRequest({ ...baseParams, listing })

    expect(
      getCachedIbkrConid(
        buildIbkrConidCacheKey('AAPL', 'stock', { marketCode: 'XNAS', currency: 'USD' })
      )
    ).toBe(265598)
    // The order built from the same params reads that entry without a second
    // lookup: prepare and build agree on the key.
    expect(buildIbkrOrderRequest({ ...baseParams, listing }).body).toMatchObject({
      conid: 265598,
    })
    expect(fetchBrokerJson).toHaveBeenCalledTimes(1)
  })

  it('leaves a warm cache alone', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    cacheIbkrConid(buildIbkrConidCacheKey('AAPL', 'stock'), 265598)

    await prepareIbkrOrderRequest(baseParams)

    expect(fetchBrokerJson).not.toHaveBeenCalled()
    expect(buildIbkrOrderRequest(baseParams).body).toMatchObject({ conid: 265598 })
  })
})
