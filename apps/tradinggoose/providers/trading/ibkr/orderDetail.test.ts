import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findIbkrOrderById,
  ibkrOrderDetailRequest,
  normalizeIbkrOrderDetail,
  resolveIbkrOrderDetailProviderOrderId,
} from '@/providers/trading/ibkr/orderDetail'
import { ensureIbkrSession } from '@/providers/trading/ibkr/session'
import { fetchBrokerJson, TradingBrokerRequestError } from '@/providers/trading/portfolio-utils'

vi.mock('@/providers/trading/portfolio-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/providers/trading/portfolio-utils')>()
  return { ...actual, fetchBrokerJson: vi.fn() }
})

vi.mock('@/providers/trading/ibkr/session', () => ({
  ensureIbkrSession: vi.fn(async () => undefined),
}))

const historyRecord: any = {
  id: 'app-order-1',
  workspaceId: 'ws-1',
  provider: 'ibkr',
  environment: 'paper',
  submissionSource: 'manual',
  request: { accountId: 'DU123456' },
  response: {
    orderId: '12345',
    clientOrderId: 'tg-client-1',
  },
  normalizedOrder: {
    id: '12345',
  },
}

describe('resolveIbkrOrderDetailProviderOrderId', () => {
  it('resolves from response orderId', () => {
    expect(resolveIbkrOrderDetailProviderOrderId(historyRecord)).toBe('12345')
  })

  it('resolves from the accepted ticket array stored as the raw order', () => {
    expect(
      resolveIbkrOrderDetailProviderOrderId({
        ...historyRecord,
        response: {},
        normalizedOrder: { raw: [{ order_id: '777' }] },
      })
    ).toBe('777')
  })
})

describe('findIbkrOrderById', () => {
  it('finds an order by provider order id', () => {
    const orders = {
      orders: [
        { order_id: 999, order_ref: 'other' },
        { order_id: 12345, order_ref: 'tg-client-1' },
      ],
    }

    const found = findIbkrOrderById(orders, '12345')
    expect(found?.order_id).toBe(12345)
  })

  it('finds a live order row, which carries orderId rather than order_id', () => {
    const orders = {
      orders: [
        { orderId: 999, order_ref: 'other' },
        { orderId: 12345, order_ref: 'tg-client-1' },
      ],
      snapshot: true,
    }

    expect(findIbkrOrderById(orders, '12345')?.orderId).toBe(12345)
  })

  it('finds an order by client order ref when ids do not match', () => {
    const orders = {
      orders: [{ order_id: 88888, order_ref: 'tg-client-1' }],
    }

    const found = findIbkrOrderById(orders, '12345', 'tg-client-1')
    expect(found?.order_id).toBe(88888)
  })

  it('returns null when no order matches', () => {
    const orders = { orders: [{ order_id: 1, order_ref: 'x' }] }
    expect(findIbkrOrderById(orders, '99999')).toBeNull()
  })

  it('handles nested order arrays', () => {
    const orders = [{ orders: [{ order_id: 12345 }] }]
    expect(findIbkrOrderById(orders, '12345')?.order_id).toBe(12345)
  })
})

describe('normalizeIbkrOrderDetail', () => {
  it('normalizes a filled order', () => {
    const detail = normalizeIbkrOrderDetail('app-order-1', '12345', historyRecord, {
      order_id: 12345,
      order_ref: 'tg-client-1',
      ticker: 'AAPL',
      side: 'BUY',
      status: 'FILLED',
      order_type: 'LMT',
      tif: 'DAY',
      quantity: 10,
      filled: 10,
      lmt_price: 250,
      avg_price: 249.5,
      submit_time: 1785600000,
      last_update_time: 1785603600,
    })

    expect(detail).toMatchObject({
      appOrderId: 'app-order-1',
      provider: 'ibkr',
      providerOrderId: '12345',
      environment: 'paper',
      clientOrderId: 'tg-client-1',
      symbol: 'AAPL',
      side: 'BUY',
      status: 'FILLED',
      orderType: 'LMT',
      quantity: 10,
      filledQuantity: 10,
      remainingQuantity: 0,
      limitPrice: 250,
      averageFillPrice: 249.5,
    })
    expect(detail.createdAt).toBeTruthy()
    expect(detail.updatedAt).toBeTruthy()
  })

  it('computes remaining quantity for partial fills', () => {
    const detail = normalizeIbkrOrderDetail('app-order-1', '12345', historyRecord, {
      order_id: 12345,
      quantity: 10,
      filled: 4,
      status: 'PARTIALLY_FILLED',
    })

    expect(detail.remainingQuantity).toBe(6)
  })

  it('normalizes the single-order status response', () => {
    const detail = normalizeIbkrOrderDetail('app-order-1', '12345', historyRecord, {
      order_id: 12345,
      symbol: 'AAPL',
      side: 'BUY',
      order_type: 'LIMIT',
      tif: 'DAY',
      total_size: '10.0',
      cum_fill: '4.0',
      size: '6.0',
      average_price: '249.50',
      order_status: 'Submitted',
      order_time: '260301143000',
    })

    expect(detail).toMatchObject({
      symbol: 'AAPL',
      status: 'Submitted',
      orderType: 'LIMIT',
      quantity: 10,
      filledQuantity: 4,
      remainingQuantity: 6,
      averageFillPrice: 249.5,
      submittedAt: '2026-03-01T14:30:00.000Z',
    })
  })

  it('normalizes a live order row', () => {
    const detail = normalizeIbkrOrderDetail('app-order-1', '12345', historyRecord, {
      orderId: 12345,
      order_ref: 'tg-client-1',
      ticker: 'AAPL',
      side: 'SELL',
      status: 'PreSubmitted',
      orderType: 'Limit',
      timeInForce: 'GTC',
      totalSize: '10.0',
      filledQuantity: '0.0',
      remainingQuantity: '10.0',
      price: '251',
      avgPrice: '',
      lastExecutionTime_r: 1772375400000,
    })

    expect(detail).toMatchObject({
      clientOrderId: 'tg-client-1',
      status: 'PreSubmitted',
      timeInForce: 'GTC',
      quantity: 10,
      filledQuantity: 0,
      remainingQuantity: 10,
      limitPrice: 251,
      averageFillPrice: null,
      updatedAt: new Date(1772375400000).toISOString(),
    })
  })
})

describe('ibkrOrderDetailRequest', () => {
  const params = { orderId: 'app-order-1', accessToken: 'test-token' }
  const urls = () => vi.mocked(fetchBrokerJson).mock.calls.map(([args]) => args.url)

  beforeEach(() => {
    vi.mocked(fetchBrokerJson).mockReset()
    vi.mocked(ensureIbkrSession).mockClear()
  })

  it('reads the single-order status without needing an account id', async () => {
    vi.mocked(fetchBrokerJson).mockResolvedValueOnce({
      order_id: 12345,
      order_status: 'Filled',
      total_size: '10.0',
      cum_fill: '10.0',
    } as never)

    const result = await ibkrOrderDetailRequest(historyRecord, params)

    expect(ensureIbkrSession).toHaveBeenCalledWith({ accessToken: 'test-token' })
    expect(urls()).toEqual(['http://127.0.0.1:5000/v1/api/iserver/account/order/status/12345'])
    expect(result.orderDetail).toMatchObject({ status: 'Filled', filledQuantity: 10 })
  })

  it('falls back to the live order list when the status endpoint cannot report the order', async () => {
    vi.mocked(fetchBrokerJson)
      .mockRejectedValueOnce(
        new TradingBrokerRequestError({
          message: 'Broker request failed with status 503',
          providerId: 'ibkr',
          status: 503,
          url: 'status',
        })
      )
      .mockResolvedValueOnce({
        orders: [{ orderId: 555, order_ref: 'tg-client-1', status: 'Submitted' }],
      } as never)

    const result = await ibkrOrderDetailRequest(historyRecord, params)

    expect(urls()[1]).toBe('http://127.0.0.1:5000/v1/api/iserver/account/orders')
    expect(result.orderDetail).toMatchObject({ status: 'Submitted' })
  })

  it('explains that IBKR only reports the current session when the order is gone', async () => {
    vi.mocked(fetchBrokerJson)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({ orders: [] } as never)

    await expect(ibkrOrderDetailRequest(historyRecord, params)).rejects.toThrow(
      'current brokerage session'
    )
  })
})
