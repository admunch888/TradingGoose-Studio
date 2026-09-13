import { type NextRequest, NextResponse } from 'next/server'
import { checkSessionOrInternalAuth } from '@/lib/auth/hybrid'
import { createLogger } from '@/lib/logs/console/logger'
import { generateRequestId } from '@/lib/utils'
import {
  type ProviderRouteBody as AIProviderRouteBody,
  handleAIProviderRequest,
} from '@/app/api/providers/ai/handler'
import {
  handleMarketProviderRequest,
  type MarketProviderRouteBody,
} from '@/app/api/providers/market/handler'
import { getMarketProviderDefinition } from '@/providers/market/providers'

const logger = createLogger('ProvidersAPI')

export const dynamic = 'force-dynamic'

type ProviderNamespace = 'ai' | 'market'
type ProviderRouteBody = AIProviderRouteBody | MarketProviderRouteBody

/**
 * Server-side proxy for provider requests
 */
export async function POST(request: NextRequest) {
  const requestId = generateRequestId()
  const startTime = Date.now()

  try {
    logger.info(`[${requestId}] Provider API request started`, {
      timestamp: new Date().toISOString(),
      userAgent: request.headers.get('User-Agent'),
      contentType: request.headers.get('Content-Type'),
    })

    const body = (await request.json()) as ProviderRouteBody
    const { provider, providerNamespace, providerType } = body

    const { namespace, providerId } = resolveProviderNamespace(
      provider,
      providerNamespace ?? providerType,
      body
    )

    if (!providerId) {
      logger.warn(`[${requestId}] Provider not specified in request body`)
      return NextResponse.json({ error: 'Provider identifier is required' }, { status: 400 })
    }

    logger.info(`[${requestId}] Provider request details`, {
      provider: providerId,
      providerNamespace: namespace,
    })

    if (namespace === 'ai') {
      const aiBody = body as AIProviderRouteBody
      const auth = aiBody.tools?.length
        ? await checkSessionOrInternalAuth(request, { requireWorkflowId: false })
        : null
      if (auth && (!auth.success || !auth.userId)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      return handleAIProviderRequest({
        body: aiBody,
        providerId,
        requestId,
        startTime,
        authUserId: auth?.userId,
      })
    }

    if (namespace === 'market') {
      return handleMarketProviderRequest({
        body: body as MarketProviderRouteBody,
        providerId,
        requestId,
        startTime,
      })
    }

    logger.warn(`[${requestId}] Unsupported provider namespace`, {
      namespace,
      providerId,
    })
    return NextResponse.json(
      { error: `Provider namespace '${namespace}' is not supported` },
      { status: 501 }
    )
  } catch (error) {
    const executionTime = Date.now() - startTime
    logger.error(`[${requestId}] Provider request failed:`, {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'Unknown',
      errorStack: error instanceof Error ? error.stack : undefined,
      executionTime,
      timestamp: new Date().toISOString(),
    })

    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

function resolveProviderNamespace(
  provider: string | undefined,
  explicit: ProviderNamespace | undefined,
  body: ProviderRouteBody
): { namespace: ProviderNamespace; providerId: string } {
  // A non-string provider used to reach `provider.includes(...)` and throw out of
  // the route, replacing the request's own error with a runtime message. It now
  // answers the 400 the empty-provider case already gets.
  if (typeof provider !== 'string' || !provider) {
    return { namespace: explicit ?? 'ai', providerId: '' }
  }

  if (explicit) {
    return { namespace: explicit, providerId: provider }
  }

  if (provider.includes(':')) {
    const [maybeNamespace, remainder] = provider.split(':', 2)
    if (
      (maybeNamespace === 'ai' || maybeNamespace === 'market') &&
      typeof remainder === 'string' &&
      remainder.length > 0
    ) {
      return { namespace: maybeNamespace as ProviderNamespace, providerId: remainder }
    }
  }

  // A request with no namespace field is resolved from its own body, never by
  // defaulting to 'ai'. The old silent default let a market request (a dropped
  // `providerNamespace`, or a caller that only ever sent a market provider id)
  // fall into the AI handler, which answered with AI errors - "Model is
  // required" reached a market chart's error state that way. Two market signals
  // are enough to be certain: the provider is registered as a market provider,
  // or the body carries a listing, which no AI request has.
  if (isMarketProviderId(provider) || hasMarketRequestShape(body)) {
    return { namespace: 'market', providerId: provider }
  }

  return { namespace: 'ai', providerId: provider }
}

/**
 * Market provider ids are a disjoint set from AI provider ids, so an exact
 * registry hit is decisive. The suffix after a '/' picks the sub-provider
 * (`ibkr/...`), mirroring providers/market/index.ts.
 */
function isMarketProviderId(provider: string): boolean {
  const id = provider.split('/')[0]
  return Boolean(id) && getMarketProviderDefinition(id) !== null
}

function hasMarketRequestShape(body: ProviderRouteBody): boolean {
  const candidate = body as { listing?: unknown; kind?: unknown; windows?: unknown }
  if (candidate.listing != null) return true
  if (candidate.kind === 'series' || candidate.kind === 'live') return true
  return Array.isArray(candidate.windows)
}
