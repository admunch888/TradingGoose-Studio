import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkSessionOrInternalAuth } from '@/lib/auth/hybrid'
import {
  deriveKronosSignal,
  type KronosSignalForecast,
  type KronosSignalResult,
} from '@/lib/kronos/signal'
import { createLogger } from '@/lib/logs/console/logger'
import { fetchVolatilityContext, type VolatilityContext } from '@/lib/market/volatility'

const logger = createLogger('KronosSignalRoute')

const nonEmptyStringSchema = z.string().trim().min(1)

// The block/tool payload. `workspaceId` is supplied by the framework as a query
// param and `idempotencyKey` is not part of the current contract, so both are
// accepted but optional. `forecast` and `marketSeries` are the opaque outputs of the
// Kronos Forecast and Historical Data blocks: they are passed to the pure decision
// layer as they are, so a shape it cannot read becomes a flat signal with a reason
// rather than a rejected request.
const signalRequestSchema = z
  .object({
    workspaceId: nonEmptyStringSchema.optional(),
    idempotencyKey: nonEmptyStringSchema.optional(),
    forecast: z.unknown(),
    marketSeries: z.unknown(),
    // The VIX complex, when the caller already holds one. Left as `unknown` like the two
    // payloads above: a context the decision layer cannot read becomes a stand-aside
    // with a reason, which is more useful to a workflow than a 400.
    volatility: z.unknown().optional(),
    config: z
      .object({
        minTerminalReturnTicks: z.number().positive().finite().optional(),
        maxPredictedDrawdownTicks: z.number().positive().finite().optional(),
        maxRealizedVolatility: z.number().positive().finite().optional(),
        allowFlip: z.boolean().optional(),
        minAgreement: z.number().min(0).max(1).optional(),
        barsPerYear: z.number().positive().finite().optional(),
        // The account's side, for a workflow that knows it. Absent, the policy sees a
        // flat account and the already-held/flip gates cannot fire.
        currentPositionSide: z.enum(['long', 'short', 'flat']).optional(),
        currentPositionQuantity: z.number().finite().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

type SignalRequestBody = z.infer<typeof signalRequestSchema>

const parseRequestBody = async (request: NextRequest): Promise<SignalRequestBody | Response> => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request data' }, { status: 400 })
  }

  const parsed = signalRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request data', details: parsed.error.issues },
      { status: 400 }
    )
  }
  return parsed.data
}

/**
 * The realized closes the forecast was anchored to.
 *
 * Strict where the pure layer is forgiving: a series that is absent, out of shape or
 * carrying a close that is not a positive finite number is a wiring error, and the
 * same payload is rejected the same way by the forecast route. A series that is merely
 * too short is passed through - `deriveKronosSignal` stands aside on it with a reason
 * instead.
 */
const readCloses = (marketSeries: unknown): number[] => {
  const bars = (marketSeries as { bars?: unknown } | null | undefined)?.bars
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new Error('marketSeries.bars must contain at least one historical bar')
  }

  return bars.map((bar, index) => {
    const close = (bar as { close?: unknown } | null | undefined)?.close
    if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) {
      throw new Error(`marketSeries.bars[${index}].close must be a positive finite number`)
    }
    return close
  })
}

/**
 * The VIX complex for this decision: the body's own when it carried one, otherwise a
 * fresh fetch.
 *
 * THIS IS WHERE THE FETCH LIVES FOR NOW, AND ONLY FOR NOW. There is no VIX-context block
 * yet, so a workflow cannot wire a quote in and the route has to go and get it; the
 * dedicated context step the plan calls for will own the fetch, its caching and its
 * credentials, and it is this call that step replaces. Until then the route passes no
 * `accessToken`, because nothing in the request path holds one: the gateway the app
 * talks to keeps its own session, and a hosted-API token would have to come from a
 * credential lookup that belongs to that future step.
 *
 * A body-supplied context wins outright. That is how a caller that already holds a quote
 * avoids a second round trip, and how the route's tests pin a regime without a network.
 *
 * A fetch that fails is an EMPTY context rather than an error. `fetchVolatilityContext`
 * is written never to throw, but the decision layer must not care either way: with no
 * VIX it stands aside naming the missing quote, which is a flat signal an operator can
 * read - and a quote source being down is not a reason to fail the whole request.
 */
const resolveVolatilityContext = async (supplied: unknown): Promise<VolatilityContext> => {
  // An empty object counts as supplied: a caller that says "there is no VIX" has
  // answered the question the fetch would have asked.
  if (typeof supplied === 'object' && supplied !== null) return supplied as VolatilityContext

  try {
    return await fetchVolatilityContext()
  } catch (error) {
    logger.warn('VIX context could not be fetched; the signal will stand aside', { error })
    return { vix: null, vix3m: null }
  }
}

export async function POST(request: NextRequest) {
  const requestData = await parseRequestBody(request)
  if (requestData instanceof Response) return requestData

  const auth = await checkSessionOrInternalAuth(request, {
    requireWorkflowId: false,
  })
  if (!auth.success || !auth.userId) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 })
  }

  let closes: number[]
  try {
    closes = readCloses(requestData.marketSeries)
  } catch (error) {
    logger.warn('Kronos signal request rejected', { error })
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid Kronos signal request' },
      { status: 400 }
    )
  }

  try {
    const volatility = await resolveVolatilityContext(requestData.volatility)
    const signal: KronosSignalResult = deriveKronosSignal({
      forecast: requestData.forecast as KronosSignalForecast,
      closes,
      volatility,
      config: requestData.config,
    })
    return NextResponse.json(signal)
  } catch (error) {
    // The decision layer stands aside instead of throwing, so this is a bug rather
    // than bad input: say so plainly and do not pretend to have a signal.
    logger.error('Kronos signal failed', { error })
    return NextResponse.json({ error: 'Kronos signal failed' }, { status: 500 })
  }
}
