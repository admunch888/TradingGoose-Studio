import { ListingResolvedSchema } from '@/lib/listing/identity'
import { createLogger } from '@/lib/logs/console/logger'
import { buildIbkrAuthHeaders } from '@/providers/trading/ibkr/auth'
import { buildIbkrApiUrl } from '@/providers/trading/ibkr/client'
import { ibkrTradingProviderConfig } from '@/providers/trading/ibkr/config'
import { ensureIbkrSession } from '@/providers/trading/ibkr/session'
import {
  type IbkrConidListingContext,
  resolveIbkrConid,
  resolveIbkrConidFromApi,
} from '@/providers/trading/ibkr/symbols'
import { fetchBrokerJson, TradingBrokerRequestError } from '@/providers/trading/portfolio-utils'
import type {
  TradingOrder,
  TradingOrderInput,
  TradingRequestConfig,
} from '@/providers/trading/types'
import {
  listingIdentityToTradingSymbol,
  resolveTradingListingAssetClass,
} from '@/providers/trading/utils'

const logger = createLogger('IBKR:Orders')

const IBKR_ORDER_TYPE: Record<string, string> = {
  market: 'MKT',
  limit: 'LMT',
  stop: 'STP',
  stop_limit: 'STP LMT',
  trailing_stop: 'TRAIL',
}

/**
 * The order ticket's `tif` accepts DAY, IOC, GTC, OPG and PAX. FOK and GTD are
 * not among them, so they are not offered for IBKR.
 */
const IBKR_TIF: Record<string, string> = {
  day: 'DAY',
  gtc: 'GTC',
  ioc: 'IOC',
}

const IBKR_SIDE: Record<string, string> = {
  buy: 'BUY',
  sell: 'SELL',
}

/**
 * Order reply messages confirmed without asking: the risk disclosures IBKR shows
 * for an order type (market order, stop order, crypto market order), which say
 * nothing about this particular order. Any other message - a price far from the
 * market, a size or value limit, missing market data - stops the order.
 * IBKR_ORDER_CONFIRM_MESSAGE_IDS replaces this list; "*" confirms every message.
 */
export const IBKR_DEFAULT_CONFIRM_MESSAGE_IDS = ['o10151', 'o10152', 'o10288', 'o10331']

/** The reply loop gives up after this many rounds of questions for one order. */
const MAX_ORDER_REPLY_ROUNDS = 10

/**
 * The asset class an IBKR order's contract is looked up with. The order pipeline
 * hands adapters the resolved listing but does not copy its asset class onto the
 * request, so reading `params.assetClass` alone looked every contract up as a
 * stock (secType STK): stocks still worked, and an MESZ26 futures order failed
 * with "Unable to resolve IBKR contract identifier" while its chart resolved the
 * same contract. The explicit value wins; otherwise the listing's own.
 */
export const resolveIbkrOrderAssetClass = (params: TradingOrderInput) =>
  resolveTradingListingAssetClass(params.listing, params.assetClass)

/**
 * The symbol an IBKR order is submitted for, derived exactly as
 * buildIbkrOrderRequest derives it. prepareIbkrOrderRequest has to derive it
 * the same way: the cache entry it seeds is only useful if the synchronous read
 * in buildIbkrOrderRequest lands on the same key.
 */
export const resolveIbkrOrderSymbol = (params: TradingOrderInput): string =>
  listingIdentityToTradingSymbol(ibkrTradingProviderConfig, {
    listing: params.listing,
    base: params.base,
    quote: params.quote,
    assetClass: resolveIbkrOrderAssetClass(params),
    marketCode: params.marketCode,
    countryCode: params.countryCode,
    cityName: params.cityName,
  })

/**
 * Listing context for the conid cache key. The resolved listing is read first
 * (the same precedence buildTradingListingContext uses), so an order and a
 * market-data fetch for one listing key the same conid entry.
 *
 * No expiry/contract month is derivable here: nothing on TradingOrderInput or
 * ListingResolved carries one, so the `expiry` dimension stays unset for
 * futures until a caller has that data.
 */
export const resolveIbkrOrderListingContext = (
  params: TradingOrderInput
): IbkrConidListingContext => {
  const parsed = ListingResolvedSchema.safeParse(params.listing)
  const resolved = parsed.success ? parsed.data : null
  return {
    marketCode: resolved?.marketCode?.trim() || params.marketCode,
    currency: resolved?.quote?.trim() || params.quote,
  }
}

/**
 * Get the gateway ready and seed the conid cache before the shared order
 * pipeline builds its request.
 *
 * The /iserver/* order endpoints answer 401 until the gateway session is live
 * and /iserver/accounts has been read in it; market data did that, orders did
 * not, so an order sent before any chart loaded failed at the gateway.
 *
 * buildIbkrOrderRequest reads the contract identifier SYNCHRONOUSLY from a
 * process-local cache that only market data used to write, so an order that was
 * not preceded by an IBKR quote fetch in the same process - tool and block
 * orders, or the quick order widget with its quote query disabled - used to
 * fail before it reached the gateway. This is the write the synchronous read
 * needs; the shared pipeline awaits it.
 */
export const prepareIbkrOrderRequest = async (params: TradingOrderInput): Promise<void> => {
  await ensureIbkrSession({ accessToken: params.accessToken })
  await resolveIbkrConidFromApi({
    symbol: resolveIbkrOrderSymbol(params),
    assetClass: resolveIbkrOrderAssetClass(params),
    context: resolveIbkrOrderListingContext(params),
    accessToken: params.accessToken,
  })
}

export const buildIbkrOrderRequest = (params: TradingOrderInput): TradingRequestConfig => {
  const authHeaders = buildIbkrAuthHeaders({ accessToken: params.accessToken })

  const symbol = resolveIbkrOrderSymbol(params)

  const orderSizingMode = params.orderSizingMode ?? 'quantity'
  if (orderSizingMode === 'notional') {
    throw new Error('IBKR orders do not support notional sizing.')
  }
  if (typeof params.quantity !== 'number' || !Number.isFinite(params.quantity)) {
    throw new Error('IBKR orders require quantity.')
  }

  const orderType = IBKR_ORDER_TYPE[params.orderType ?? 'market']
  if (!orderType) {
    throw new Error(`Unsupported order type: ${params.orderType}`)
  }
  const tif = IBKR_TIF[params.timeInForce ?? 'day']
  if (!tif) {
    throw new Error(`Unsupported time in force: ${params.timeInForce}`)
  }
  const side = IBKR_SIDE[params.side]
  if (!side) {
    throw new Error(`Unsupported side: ${params.side}`)
  }

  const { conid, conidSpec } = resolveIbkrConid({
    symbol,
    assetClass: resolveIbkrOrderAssetClass(params),
    context: resolveIbkrOrderListingContext(params),
  })

  const ticket: Record<string, unknown> = {
    conid,
    secType: conidSpec,
    side,
    quantity: Math.abs(params.quantity),
    orderType,
    tif,
    outsideRTH: false,
    ...(params.clientOrderId ? { cOID: params.clientOrderId } : {}),
  }

  if (orderType === 'LMT' || orderType === 'STP LMT') {
    if (typeof params.limitPrice !== 'number' || !Number.isFinite(params.limitPrice)) {
      throw new Error('IBKR limit orders require limitPrice.')
    }
    ticket.price = params.limitPrice
  }
  if (orderType === 'STP' || orderType === 'STP LMT') {
    if (typeof params.stopPrice !== 'number' || !Number.isFinite(params.stopPrice)) {
      throw new Error('IBKR stop orders require stopPrice.')
    }
    ticket.auxPrice = params.stopPrice
  }
  if (orderType === 'TRAIL') {
    const hasTrailPrice =
      typeof params.trailPrice === 'number' && Number.isFinite(params.trailPrice)
    const hasTrailPercent =
      typeof params.trailPercent === 'number' && Number.isFinite(params.trailPercent)
    if (hasTrailPrice === hasTrailPercent) {
      throw new Error('IBKR trailing stop orders require either trailPrice or trailPercent.')
    }
    ticket.trailingType = hasTrailPrice ? 'amt' : '%'
    ticket.trailingAmt = hasTrailPrice ? params.trailPrice : params.trailPercent
  }

  const accountId = params.accountId
  if (!accountId) {
    throw new Error('IBKR orders require accountId.')
  }

  return {
    url: buildIbkrApiUrl(`/iserver/account/${encodeURIComponent(accountId)}/orders`),
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
    body: { orders: [ticket] },
  }
}

type IbkrOrderSubmissionOutcome =
  | { kind: 'accepted'; orders: Record<string, unknown>[] }
  | { kind: 'reply'; replyId: string; messages: string[]; messageIds: string[] }
  | { kind: 'rejected'; message: string }

const readTexts = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value])
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => entry.trim())

/**
 * Classify an order submission or reply response. Both endpoints answer with
 * one of: accepted tickets (`[{order_id, order_status}]`), a question to confirm
 * (`[{id, message[], messageIds[]}]`), `{error}`, or a rejection (`{text, ...}`).
 */
export const classifyIbkrOrderResponse = (response: unknown): IbkrOrderSubmissionOutcome => {
  const entries = (Array.isArray(response) ? response : [response]).filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object'
  )

  if (
    entries.length > 0 &&
    entries.every((entry) => entry.order_id !== undefined && entry.order_id !== null)
  ) {
    return { kind: 'accepted', orders: entries }
  }

  const question = entries.find(
    (entry) => typeof entry.id === 'string' && entry.message !== undefined
  )
  if (question) {
    return {
      kind: 'reply',
      replyId: question.id as string,
      messages: readTexts(question.message),
      messageIds: readTexts(question.messageIds),
    }
  }

  const first = entries[0]
  return {
    kind: 'rejected',
    message:
      readTexts(first?.error)[0] ??
      readTexts(first?.text)[0] ??
      'IBKR returned an order response it did not recognise',
  }
}

const resolveConfirmableMessageIds = (): Set<string> | 'all' => {
  const configured = process.env.IBKR_ORDER_CONFIRM_MESSAGE_IDS
  if (configured === undefined) {
    return new Set(IBKR_DEFAULT_CONFIRM_MESSAGE_IDS)
  }
  const ids = configured
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  return ids.includes('*') ? 'all' : new Set(ids)
}

const rejectIbkrOrder = (message: string, url: string, payload: unknown) =>
  new TradingBrokerRequestError({ message, providerId: 'ibkr', status: 422, url, payload })

/**
 * Submit an order ticket and work through IBKR's order reply messages.
 *
 * IBKR does not place an order that triggers a warning until the warning is
 * answered through /iserver/reply/{replyId}; a single POST left those orders
 * unplaced while the app recorded them as submitted. Confirmable messages (see
 * IBKR_DEFAULT_CONFIRM_MESSAGE_IDS) are confirmed; any other message is declined
 * so the gateway discards the ticket, and the order fails with IBKR's text.
 */
export const submitIbkrOrder = async (request: TradingRequestConfig): Promise<unknown> => {
  const post = (url: string, body: unknown) =>
    fetchBrokerJson<unknown>({
      providerId: 'ibkr',
      url,
      init: {
        method: 'POST',
        headers: request.headers,
        body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
      },
    })

  const confirmable = resolveConfirmableMessageIds()
  let url = request.url
  let response = await post(url, request.body)

  for (let round = 0; round < MAX_ORDER_REPLY_ROUNDS; round++) {
    const outcome = classifyIbkrOrderResponse(response)
    if (outcome.kind === 'accepted') {
      return outcome.orders
    }
    if (outcome.kind === 'rejected') {
      throw rejectIbkrOrder(`IBKR rejected the order: ${outcome.message}`, url, response)
    }

    const replyUrl = buildIbkrApiUrl(`/iserver/reply/${encodeURIComponent(outcome.replyId)}`)
    const approved =
      confirmable === 'all' ||
      (outcome.messageIds.length > 0 && outcome.messageIds.every((id) => confirmable.has(id)))

    if (!approved) {
      await post(replyUrl, { confirmed: false }).catch((error) =>
        logger.warn('IBKR order decline reply failed', { error })
      )
      const ids = outcome.messageIds.length > 0 ? outcome.messageIds.join(', ') : 'none given'
      throw rejectIbkrOrder(
        `IBKR asked for confirmation and the order was not sent: ${outcome.messages.join(' ')} ` +
          `(message ids: ${ids}). To allow it, add the ids to IBKR_ORDER_CONFIRM_MESSAGE_IDS ` +
          'or suppress the message in IBKR.',
        replyUrl,
        response
      )
    }

    logger.info('Confirming IBKR order reply message', { messageIds: outcome.messageIds })
    url = replyUrl
    response = await post(replyUrl, { confirmed: true })
  }

  throw rejectIbkrOrder(
    'IBKR kept asking for order confirmations; the order was not confirmed',
    url,
    response
  )
}

export const normalizeIbkrOrder = (data: any): TradingOrder => {
  const first = Array.isArray(data)
    ? data.find((entry) => entry && typeof entry === 'object')
    : data
  const rawOrder = first?.order ?? first
  const orderId = rawOrder?.order_id ?? rawOrder?.orderId
  return {
    id: orderId === undefined || orderId === null ? undefined : String(orderId),
    clientOrderId: rawOrder?.order_ref ?? rawOrder?.orderRef ?? rawOrder?.cOID,
    status: rawOrder?.order_status ?? rawOrder?.status,
    submittedAt: rawOrder?.last_update_time
      ? new Date(rawOrder.last_update_time * 1000).toISOString()
      : undefined,
    filledQty: typeof rawOrder?.filled === 'number' ? rawOrder.filled : undefined,
    symbol: rawOrder?.ticker,
    side: rawOrder?.side,
    raw: data,
  }
}
