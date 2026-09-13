import { ibkrOrderDetailRequest } from '@/providers/trading/ibkr/orderDetail'
import {
  buildIbkrOrderRequest,
  normalizeIbkrOrder,
  prepareIbkrOrderRequest,
  submitIbkrOrder,
} from '@/providers/trading/ibkr/orders'
import type { TradingProviderAdapter } from '@/providers/trading/providers'

export const ibkrProvider: TradingProviderAdapter = {
  prepareOrderRequest: prepareIbkrOrderRequest,
  buildOrderRequest: buildIbkrOrderRequest,
  submitOrder: submitIbkrOrder,
  orderDetailRequest: ibkrOrderDetailRequest,
  normalizeOrder: normalizeIbkrOrder,
}
