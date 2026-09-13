import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { AuthType, checkSessionOrInternalAuth } from '@/lib/auth/hybrid'
import { ListingIdentitySchema, ListingResolvedSchema } from '@/lib/listing/identity'
import { createTradingRequestId } from '@/lib/trading/context'
import { isTradingServiceError, resolveTradingErrorStatus } from '@/lib/trading/errors'
import type { TradingOrderSubmitRequest } from '@/lib/trading/order-types'
import { submitTradingOrder } from '@/lib/trading/orders'
import { TradingBrokerRequestError } from '@/providers/trading/portfolio-utils'

const positiveNumberSchema = z.number().positive().finite()
const nonEmptyStringSchema = z.string().trim().min(1)

const orderListingSchema = z.union([ListingIdentitySchema, ListingResolvedSchema])

const portfolioIdentitySchema = z
  .object({
    providerId: nonEmptyStringSchema,
    credentialId: nonEmptyStringSchema,
    serviceId: nonEmptyStringSchema,
    accountId: nonEmptyStringSchema,
  })
  .passthrough()

const orderSchema = z
  .object({
    workspaceId: nonEmptyStringSchema,
    idempotencyKey: nonEmptyStringSchema,
    portfolioIdentity: portfolioIdentitySchema,
    listing: orderListingSchema,
    side: z.enum(['buy', 'sell']),
    quantity: positiveNumberSchema.optional(),
    notional: positiveNumberSchema.optional(),
    orderSizingMode: z.enum(['quantity', 'notional']).optional(),
    orderType: nonEmptyStringSchema.optional(),
    timeInForce: nonEmptyStringSchema.optional(),
    limitPrice: positiveNumberSchema.optional(),
    stopPrice: positiveNumberSchema.optional(),
    trailPrice: positiveNumberSchema.optional(),
    trailPercent: positiveNumberSchema.optional(),
    preview: z.boolean().optional(),
    submissionSource: z.enum(['manual', 'copilot', 'workflow']).optional(),
    logId: nonEmptyStringSchema.optional(),
  })
  .strict()

const errorResponse = (error: string, status = 400) => NextResponse.json({ error }, { status })

const parseOrderRequest = async (
  request: NextRequest
): Promise<TradingOrderSubmitRequest | Response> => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid request data')
  }

  const parsed = orderSchema.safeParse(body)
  return parsed.success
    ? (parsed.data as TradingOrderSubmitRequest)
    : errorResponse('Invalid request data')
}

export async function POST(request: NextRequest) {
  const requestId = createTradingRequestId('order')
  const requestData = await parseOrderRequest(request)
  if (requestData instanceof Response) return requestData
  const workflowId = new URL(request.url).searchParams.get('workflowId')?.trim() || undefined

  const auth = await checkSessionOrInternalAuth(request as NextRequest, {
    requireWorkflowId: false,
  })
  if (!auth.success || !auth.userId) {
    return errorResponse(auth.error || 'Unauthorized', 401)
  }

  try {
    const submitRequestData: TradingOrderSubmitRequest =
      auth.authType === AuthType.SESSION
        ? {
            ...requestData,
            ...(workflowId ? { workflowId } : {}),
            submissionSource: 'manual',
            logId: undefined,
          }
        : { ...requestData, ...(workflowId ? { workflowId } : {}) }

    const response = await submitTradingOrder({
      requestData: submitRequestData,
      requestId,
      userId: auth.userId,
    })

    return NextResponse.json(response)
  } catch (error) {
    if (isTradingServiceError(error)) {
      // error.status is whatever the trading layer reported, which is a broker
      // status for broker failures and 0 for a transport failure - a value that
      // cannot be sent as an HTTP status. resolveTradingErrorStatus keeps every
      // real 400-599 status and answers 502 for the rest.
      return errorResponse(error.message, resolveTradingErrorStatus(error.status))
    }
    if (error instanceof TradingBrokerRequestError) {
      // Broker failures raised before submission (account discovery, listing
      // resolution) reach the route unwrapped. Naming the provider and repeating
      // the broker's own message is the difference between "the order was
      // rejected" and "we never reached the broker" for whoever reads this.
      return errorResponse(
        `Broker request failed for ${error.providerId}: ${error.message}`,
        resolveTradingErrorStatus(error.status)
      )
    }
    return errorResponse(error instanceof Error ? error.message : 'Order submission failed')
  }
}
