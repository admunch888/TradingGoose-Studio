import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cacheIbkrConid,
  clearIbkrConidCache,
  getCachedIbkrConid,
} from '@/providers/trading/ibkr/client'
import {
  buildIbkrOrderRequest,
  normalizeIbkrOrder,
  prepareIbkrOrderRequest,
  submitIbkrOrder,
} from '@/providers/trading/ibkr/orders'
import { ensureIbkrSession } from '@/providers/trading/ibkr/session'
import { buildIbkrConidCacheKey } from '@/providers/trading/ibkr/symbols'
import { fetchBrokerJson, TradingBrokerRequestError } from '@/providers/trading/portfolio-utils'
import type { TradingRequestConfig } from '@/providers/trading/types'

vi.mock('@/providers/trading/portfolio-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/providers/trading/portfolio-utils')>()
  return { ...actual, fetchBrokerJson: vi.fn() }
})

vi.mock('@/providers/trading/ibkr/session', () => ({
  ensureIbkrSession: vi.fn(async () => undefined),
}))

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

const ticketOf = (request: TradingRequestConfig) =>
  (request.body as { orders: Record<string, unknown>[] }).orders[0]

describe('buildIbkrOrderRequest', () => {
  beforeEach(() => {
    clearIbkrConidCache()
    cacheIbkrConid(buildIbkrConidCacheKey('AAPL', 'stock'), 265598)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('posts a single order ticket to the iserver account orders endpoint', () => {
    const request = buildIbkrOrderRequest(baseParams)

    expect(request.url).toBe('http://127.0.0.1:5000/v1/api/iserver/account/DU123456/orders')
    expect(request.method).toBe('POST')
    expect(request.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    })
    // Gateway mode authenticates with the browser session, so no bearer token.
    expect(request.headers).not.toHaveProperty('Authorization')
    expect((request.body as { orders: unknown[] }).orders).toHaveLength(1)
    expect(ticketOf(request)).toEqual({
      conid: 265598,
      secType: 'STK',
      side: 'BUY',
      quantity: 10,
      orderType: 'MKT',
      tif: 'DAY',
      outsideRTH: false,
    })
  })

  it('maps clientOrderId to cOID', () => {
    const request = buildIbkrOrderRequest({
      ...baseParams,
      clientOrderId: 'tg-abc123',
    })

    expect(ticketOf(request)).toMatchObject({ cOID: 'tg-abc123' })
    expect(ticketOf(request)).not.toHaveProperty('orderRef')
  })

  it('builds a limit order with price', () => {
    const request = buildIbkrOrderRequest({
      ...baseParams,
      orderType: 'limit',
      limitPrice: 250.5,
    })

    expect(ticketOf(request)).toMatchObject({
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

    expect(ticketOf(request)).toMatchObject({
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

    expect(ticketOf(request)).toMatchObject({
      orderType: 'STP LMT',
      auxPrice: 240,
      price: 238,
    })
  })

  it('builds a trailing stop by amount with trailingAmt and trailingType amt', () => {
    const request = buildIbkrOrderRequest({
      ...baseParams,
      orderType: 'trailing_stop',
      trailPrice: 1.5,
    })

    expect(ticketOf(request)).toMatchObject({
      orderType: 'TRAIL',
      trailingAmt: 1.5,
      trailingType: 'amt',
    })
    expect(ticketOf(request)).not.toHaveProperty('auxPrice')
  })

  it('builds a trailing stop by percent with trailingType %', () => {
    const request = buildIbkrOrderRequest({
      ...baseParams,
      orderType: 'trailing_stop',
      trailPercent: 2,
    })

    expect(ticketOf(request)).toMatchObject({
      orderType: 'TRAIL',
      trailingAmt: 2,
      trailingType: '%',
    })
    expect(ticketOf(request)).not.toHaveProperty('trailingPercent')
  })

  it('rejects trailing stop without trail fields', () => {
    expect(() =>
      buildIbkrOrderRequest({
        ...baseParams,
        orderType: 'trailing_stop',
      })
    ).toThrow('either trailPrice or trailPercent')
  })

  it.each(['fok', 'gtd'])('rejects the %s time in force IBKR does not offer', (timeInForce) => {
    expect(() => buildIbkrOrderRequest({ ...baseParams, timeInForce })).toThrow(
      'Unsupported time in force'
    )
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

  it('sends a sell with a positive quantity', () => {
    const request = buildIbkrOrderRequest({
      ...baseParams,
      side: 'sell',
      quantity: 5,
    })

    expect(ticketOf(request)).toMatchObject({
      side: 'SELL',
      quantity: 5,
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
    vi.mocked(ensureIbkrSession).mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('opens the gateway session before the order endpoints are used', async () => {
    cacheIbkrConid(buildIbkrConidCacheKey('AAPL', 'stock'), 265598)

    await prepareIbkrOrderRequest(baseParams)

    expect(ensureIbkrSession).toHaveBeenCalledWith({ accessToken: 'test-token' })
  })

  it('seeds the conid cache so a cold-cache order can be built', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockResolvedValue(aaplSecDefRows as never)

    // Without the seed, buildIbkrOrderRequest throws 'contract identifier not
    // resolved' and the order never reaches the gateway.
    await prepareIbkrOrderRequest(baseParams)
    const request = buildIbkrOrderRequest(baseParams)

    expect(ticketOf(request)).toMatchObject({ conid: 265598, side: 'BUY', quantity: 10 })
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
    expect(ticketOf(buildIbkrOrderRequest({ ...baseParams, listing }))).toMatchObject({
      conid: 265598,
    })
    expect(fetchBrokerJson).toHaveBeenCalledTimes(1)
  })

  it('leaves a warm cache alone', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    cacheIbkrConid(buildIbkrConidCacheKey('AAPL', 'stock'), 265598)

    await prepareIbkrOrderRequest(baseParams)

    expect(fetchBrokerJson).not.toHaveBeenCalled()
    expect(ticketOf(buildIbkrOrderRequest(baseParams))).toMatchObject({ conid: 265598 })
  })

  it('places a contract-month future on the month the symbol names', async () => {
    // The live failure: the market listing dropdown supplied `MESZ25` for a
    // December 2025 Micro E-mini S&P, and nothing in the order params - or in
    // the listing context derived from them - carries an expiry. The seed has
    // to resolve the root, hop to that month's own conid, and the synchronous
    // read has to land on the same entry holding nothing but the symbol.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockImplementation(
      async ({ url }: { url: string }): Promise<never> => {
        if (url.includes('/iserver/secdef/info')) {
          return [{ conid: '495492863', symbol: 'MES', secType: 'FUT', exchange: 'CME' }] as never
        }
        return [
          {
            conid: '466221142',
            symbol: 'MES',
            description: 'CME',
            sections: [{ secType: 'FUT', exchange: 'CME', months: 'SEP26;DEC26' }],
          },
          {
            conid: '515151515',
            symbol: 'MES',
            description: 'CME',
            sections: [{ secType: 'FUT', exchange: 'CME', months: 'DEC25;MAR26' }],
          },
        ] as never
      }
    )
    const params = {
      ...baseParams,
      assetClass: 'future' as const,
      marketCode: 'XCME',
      listing: {
        listingIdentity: {
          listing_id: 'MESZ25',
          base_id: '',
          quote_id: '',
          listing_type: 'default' as const,
        },
        base: 'MESZ25',
        quote: 'USD',
        marketCode: 'XCME',
      },
    }

    await prepareIbkrOrderRequest(params)
    const request = buildIbkrOrderRequest(params)

    // DEC25 is the second month its row lists, and the row is the second one
    // the search returned; the first row is September. Its contract id is the
    // one secdef/info answered for that month, not the row's own.
    expect(ticketOf(request)).toMatchObject({ conid: 495492863, secType: 'FUT' })
    expect(fetchBrokerJson).toHaveBeenCalledTimes(2)
  })
})

describe('submitIbkrOrder', () => {
  const orderUrl = 'http://127.0.0.1:5000/v1/api/iserver/account/DU123456/orders'
  const request: TradingRequestConfig = {
    url: orderUrl,
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: { orders: [{ conid: 265598, secType: 'STK', side: 'BUY', quantity: 10 }] },
  }
  const accepted = [{ order_id: '1234567', order_status: 'Submitted', encrypt_message: '1' }]
  const question = (id: string, messageIds: string[], message = 'Are you sure?') => [
    { id, message: [message], isSuppressed: false, messageIds },
  ]
  const calls = () =>
    vi.mocked(fetchBrokerJson).mock.calls.map(([args]) => ({
      url: args.url,
      body: args.init?.body,
    }))

  beforeEach(() => {
    vi.mocked(fetchBrokerJson).mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the accepted tickets when IBKR places the order straight away', async () => {
    vi.mocked(fetchBrokerJson).mockResolvedValueOnce(accepted as never)

    await expect(submitIbkrOrder(request)).resolves.toEqual(accepted)
    expect(calls()).toEqual([{ url: orderUrl, body: JSON.stringify(request.body) }])
  })

  it('confirms a default risk disclosure and returns the placed order', async () => {
    vi.mocked(fetchBrokerJson)
      .mockResolvedValueOnce(question('reply-1', ['o10151']) as never)
      .mockResolvedValueOnce(accepted as never)

    await expect(submitIbkrOrder(request)).resolves.toEqual(accepted)
    expect(calls()[1]).toEqual({
      url: 'http://127.0.0.1:5000/v1/api/iserver/reply/reply-1',
      body: JSON.stringify({ confirmed: true }),
    })
  })

  it('declines any other warning, discards the ticket and reports the message', async () => {
    vi.mocked(fetchBrokerJson)
      .mockResolvedValueOnce(
        question('reply-2', ['o451'], 'Order value exceeds the Total Value Limit') as never
      )
      .mockResolvedValueOnce({} as never)

    const failure = submitIbkrOrder(request)

    await expect(failure).rejects.toBeInstanceOf(TradingBrokerRequestError)
    await expect(failure).rejects.toThrow(/Total Value Limit.*o451.*IBKR_ORDER_CONFIRM_MESSAGE_IDS/)
    expect(calls()).toHaveLength(2)
    expect(calls()[1]).toEqual({
      url: 'http://127.0.0.1:5000/v1/api/iserver/reply/reply-2',
      body: JSON.stringify({ confirmed: false }),
    })
  })

  it('declines a warning that carries no message ids', async () => {
    vi.mocked(fetchBrokerJson)
      .mockResolvedValueOnce(question('reply-3', []) as never)
      .mockResolvedValueOnce({} as never)

    await expect(submitIbkrOrder(request)).rejects.toThrow('message ids: none given')
  })

  it('confirms the ids IBKR_ORDER_CONFIRM_MESSAGE_IDS lists instead of the defaults', async () => {
    vi.stubEnv('IBKR_ORDER_CONFIRM_MESSAGE_IDS', 'o163, o451')
    vi.mocked(fetchBrokerJson)
      .mockResolvedValueOnce(question('reply-4', ['o451']) as never)
      .mockResolvedValueOnce(accepted as never)

    await expect(submitIbkrOrder(request)).resolves.toEqual(accepted)
  })

  it('confirms nothing, not even the defaults, when the setting is empty', async () => {
    vi.stubEnv('IBKR_ORDER_CONFIRM_MESSAGE_IDS', '')
    vi.mocked(fetchBrokerJson)
      .mockResolvedValueOnce(question('reply-5', ['o10151']) as never)
      .mockResolvedValueOnce({} as never)

    await expect(submitIbkrOrder(request)).rejects.toThrow('was not sent')
  })

  it('confirms every warning when the setting is *', async () => {
    vi.stubEnv('IBKR_ORDER_CONFIRM_MESSAGE_IDS', '*')
    vi.mocked(fetchBrokerJson)
      .mockResolvedValueOnce(question('reply-6', ['o999']) as never)
      .mockResolvedValueOnce(accepted as never)

    await expect(submitIbkrOrder(request)).resolves.toEqual(accepted)
  })

  it('reports an error response as a rejected order', async () => {
    vi.mocked(fetchBrokerJson).mockResolvedValueOnce({
      error: 'Order rejected: insufficient buying power',
    } as never)

    await expect(submitIbkrOrder(request)).rejects.toThrow(
      'IBKR rejected the order: Order rejected: insufficient buying power'
    )
  })

  it('reports a rejection prompt by its text', async () => {
    vi.mocked(fetchBrokerJson).mockResolvedValueOnce({
      orderId: 99,
      text: 'Order price is outside the price cap',
      prompt: false,
    } as never)

    await expect(submitIbkrOrder(request)).rejects.toThrow('outside the price cap')
  })

  it('stops after ten rounds of questions', async () => {
    vi.mocked(fetchBrokerJson).mockResolvedValue(question('reply-loop', ['o10151']) as never)

    await expect(submitIbkrOrder(request)).rejects.toThrow('kept asking for order confirmations')
    expect(fetchBrokerJson).toHaveBeenCalledTimes(11)
  })
})

describe('normalizeIbkrOrder', () => {
  it('reads the placed order from the accepted ticket array', () => {
    expect(
      normalizeIbkrOrder([{ order_id: '1234567', order_status: 'PreSubmitted' }])
    ).toMatchObject({
      id: '1234567',
      status: 'PreSubmitted',
    })
  })

  it('stringifies a numeric order id', () => {
    expect(normalizeIbkrOrder({ order_id: 42, status: 'Filled' })).toMatchObject({
      id: '42',
      status: 'Filled',
    })
  })
})
