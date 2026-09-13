import { ibkrOrderDetailRequest } from '@/providers/trading/ibkr/orderDetail'
import {
  buildIbkrOrderRequest,
  normalizeIbkrOrder,
  prepareIbkrOrderRequest,
} from '@/providers/trading/ibkr/orders'
import type { TradingProviderAdapter } from '@/providers/trading/providers'

export const ibkrProvider: TradingProviderAdapter = {
  prepareOrderRequest: prepareIbkrOrderRequest,
  buildOrderRequest: buildIbkrOrderRequest,
  orderDetailRequest: ibkrOrderDetailRequest,
  normalizeOrder: normalizeIbkrOrder,
}
