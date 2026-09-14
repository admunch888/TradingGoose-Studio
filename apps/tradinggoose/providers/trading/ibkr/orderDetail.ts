import { buildIbkrAuthHeaders } from '@/providers/trading/ibkr/auth'
import { buildIbkrApiUrl } from '@/providers/trading/ibkr/client'
import { ensureIbkrSession } from '@/providers/trading/ibkr/session'
import { fetchBrokerJson, TradingBrokerRequestError } from '@/providers/trading/portfolio-utils'
import type {
  TradingOrderDetailInput,
  TradingOrderDetailOutput,
  TradingOrderDetailResult,
  TradingOrderHistoryRecord,
} from '@/providers/trading/types'

/**
 * Statuses with which /iserver/account/order/status answers an order it cannot
 * report (IBKR documents 503 for orders from a previous session); the lookup
 * then falls back to the live order list instead of failing.
 */
const ORDER_STATUS_UNAVAILABLE = new Set([400, 404, 500, 503])

const firstDefinedString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
  }
  return null
}

/** IBKR sends most order quantities and prices as numeric strings. */
const firstNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export const resolveIbkrOrderDetailProviderOrderId = (
  historyRecord: TradingOrderHistoryRecord
): string | null =>
  firstDefinedString(
    historyRecord?.response?.orderId,
    historyRecord?.normalizedOrder?.id,
    historyRecord?.normalizedOrder?.raw?.[0]?.order_id,
    historyRecord?.normalizedOrder?.raw?.order?.order_id,
    historyRecord?.response?.raw?.order?.order_id,
    historyRecord?.response?.raw?.order_id
  )

/**
 * Unix seconds or milliseconds (as a number or numeric string), IBKR's compact
 * `YYMMDDhhmmss` order time, or any parseable date. The compact form carries no
 * zone and is read as UTC.
 */
const normalizeIbkrOrderTimestamp = (value: unknown): string | null => {
  const toIso = (epoch: number) => new Date(epoch > 1e12 ? epoch : epoch * 1000).toISOString()

  if (typeof value === 'number' && Number.isFinite(value)) {
    return toIso(value)
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const compact = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(trimmed)
  if (compact) {
    const [, year, month, day, hour, minute, second] = compact
    return `20${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`
  }

  const numeric = Number(trimmed)
  if (Number.isFinite(numeric)) {
    return toIso(numeric)
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/**
 * Normalizes either IBKR order shape: the single-order status
 * (`order_status`, `total_size`, `cum_fill`, `size`, `average_price`) or a live
 * order list row (`status`, `totalSize`, `filledQuantity`, `remainingQuantity`,
 * `avgPrice`).
 */
export const normalizeIbkrOrderDetail = (
  appOrderId: string,
  providerOrderId: string,
  historyRecord: TradingOrderHistoryRecord,
  rawOrder: Record<string, any>
): TradingOrderDetailOutput => {
  const quantity = firstNumber(
    rawOrder.total_size,
    rawOrder.totalSize,
    rawOrder.quantity,
    rawOrder.totalQuantity
  )
  const filledQuantity = firstNumber(rawOrder.cum_fill, rawOrder.filledQuantity, rawOrder.filled)
  const submittedAt =
    normalizeIbkrOrderTimestamp(rawOrder.order_time) ??
    normalizeIbkrOrderTimestamp(rawOrder.submit_time)

  return {
    appOrderId,
    provider: 'ibkr',
    providerOrderId,
    environment: historyRecord.environment ?? null,
    clientOrderId: firstDefinedString(rawOrder.order_ref, rawOrder.orderRef),
    createdAt: submittedAt ?? undefined,
    updatedAt:
      normalizeIbkrOrderTimestamp(rawOrder.lastExecutionTime_r) ??
      normalizeIbkrOrderTimestamp(rawOrder.last_update_time) ??
      undefined,
    submittedAt: submittedAt ?? undefined,
    filledAt: undefined,
    canceledAt: undefined,
    expiredAt: undefined,
    symbol: firstDefinedString(rawOrder.symbol, rawOrder.ticker),
    side: firstDefinedString(rawOrder.side),
    status: firstDefinedString(rawOrder.order_status, rawOrder.status),
    orderType: firstDefinedString(rawOrder.order_type, rawOrder.orderType, rawOrder.origOrderType),
    timeInForce: firstDefinedString(rawOrder.tif, rawOrder.timeInForce),
    quantity,
    filledQuantity,
    remainingQuantity:
      firstNumber(rawOrder.size, rawOrder.remainingQuantity) ??
      (quantity !== null && filledQuantity !== null ? quantity - filledQuantity : null),
    notional: null,
    limitPrice: firstNumber(rawOrder.lmt_price, rawOrder.limitPrice, rawOrder.price),
    stopPrice: firstNumber(rawOrder.aux_price, rawOrder.auxPrice, rawOrder.stopPrice),
    averageFillPrice: firstNumber(
      rawOrder.average_price,
      rawOrder.avgPrice,
      rawOrder.avg_price,
      rawOrder.averageFillPrice
    ),
    raw: rawOrder,
  }
}

const toRecord = (value: unknown): Record<string, any> => {
  if (value && typeof value === 'object') {
    return value as Record<string, any>
  }
  return { value }
}

const flattenOrders = (value: unknown): any[] => {
  if (Array.isArray(value)) {
    return value.flatMap(flattenOrders)
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, any>
    const orders = record.orders
    if (Array.isArray(orders)) {
      return orders.flatMap(flattenOrders)
    }
    const recordOrders = record.order
    if (Array.isArray(recordOrders)) {
      return recordOrders.flatMap(flattenOrders)
    }
    // Live order rows carry `orderId`; older shapes carry `order_id`.
    if ('order_id' in record || 'orderId' in record) {
      return [record]
    }
  }
  return []
}

export const findIbkrOrderById = (
  rawOrders: unknown,
  providerOrderId: string,
  clientOrderId?: string | null
): Record<string, any> | null => {
  const normalizedProviderOrderId = providerOrderId.trim()
  const normalizedClientOrderId = clientOrderId?.trim()

  const candidates = flattenOrders(rawOrders)
  for (const candidate of candidates) {
    const record = toRecord(candidate)
    const candidateOrderId = firstDefinedString(record.order_id, record.orderId, record.ibkrOrderId)
    const candidateOrderRef = firstDefinedString(record.order_ref, record.orderRef)

    if (candidateOrderId === normalizedProviderOrderId) {
      return record
    }
    if (normalizedClientOrderId && candidateOrderRef === normalizedClientOrderId) {
      return record
    }
  }

  return null
}

/**
 * Looks an order up by its IBKR order id. Neither IBKR order endpoint is
 * account-scoped, and neither reports orders from an earlier brokerage session.
 */
export const ibkrOrderDetailRequest = async (
  historyRecord: TradingOrderHistoryRecord,
  params: TradingOrderDetailInput
): Promise<TradingOrderDetailResult> => {
  const providerOrderId = resolveIbkrOrderDetailProviderOrderId(historyRecord)
  if (!providerOrderId) {
    throw new Error('Unable to resolve IBKR provider order ID from order history record.')
  }

  // The order endpoints require a live session with /iserver/accounts read in it.
  await ensureIbkrSession({ accessToken: params.accessToken })
  const headers = buildIbkrAuthHeaders({ accessToken: params.accessToken })

  const status = await fetchBrokerJson<Record<string, unknown> | null>({
    providerId: 'ibkr',
    url: buildIbkrApiUrl(`/iserver/account/order/status/${encodeURIComponent(providerOrderId)}`),
    init: { method: 'GET', headers },
  }).catch((error) => {
    if (error instanceof TradingBrokerRequestError && ORDER_STATUS_UNAVAILABLE.has(error.status)) {
      return null
    }
    throw error
  })

  let rawOrder =
    status && typeof status === 'object' && firstDefinedString(status.order_id) === providerOrderId
      ? (status as Record<string, any>)
      : null

  if (!rawOrder) {
    const liveOrders = await fetchBrokerJson<unknown>({
      providerId: 'ibkr',
      url: buildIbkrApiUrl('/iserver/account/orders'),
      init: { method: 'GET', headers },
    })
    rawOrder = findIbkrOrderById(
      liveOrders,
      providerOrderId,
      historyRecord?.response?.clientOrderId
    )
  }

  if (!rawOrder) {
    throw new Error(
      'IBKR order not found. IBKR only reports orders from the current brokerage session.'
    )
  }

  return {
    providerOrderId,
    orderDetail: normalizeIbkrOrderDetail(
      historyRecord.id,
      providerOrderId,
      historyRecord,
      rawOrder
    ),
  }
}
