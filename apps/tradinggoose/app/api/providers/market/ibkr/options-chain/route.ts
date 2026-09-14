import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkSessionOrInternalAuth } from '@/lib/auth/hybrid'
import { parseListingIdentityValueStrict } from '@/lib/listing/identity'
import { createLogger } from '@/lib/logs/console/logger'
import { ibkrMarketProviderConfig } from '@/providers/market/ibkr/config'
import { fetchIbkrOptionChain, MAX_STRIKES_PER_SIDE } from '@/providers/market/ibkr/options'
import { resolveListingContext, resolveProviderSymbol } from '@/providers/market/utils'
import { isIbkrHostedApi } from '@/providers/trading/ibkr/auth'

export const dynamic = 'force-dynamic'

const logger = createLogger('IbkrOptionsChainRoute')

const optionalPositiveNumber = z.preprocess(
  (value) =>
    value === '' || value === null || value === undefined
      ? undefined
      : typeof value === 'string'
        ? Number(value)
        : value,
  z.number().positive().finite().optional()
)

const RequestSchema = z.object({
  workspaceId: z.string().optional(),
  listing: z.unknown(),
  expiry: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  strikesPerSide: z.preprocess(
    (value) =>
      value === '' || value === null || value === undefined
        ? undefined
        : typeof value === 'string'
          ? Number(value)
          : value,
    z.number().int().min(1).max(MAX_STRIKES_PER_SIDE).optional()
  ),
  underlyingPrice: optionalPositiveNumber,
})

export const IBKR_HOSTED_OPTIONS_UNSUPPORTED_MESSAGE =
  'IBKR option chains need the Client Portal Gateway.'

/**
 * An IBKR option chain for a listing: futures options for a futures listing,
 * equity/index options otherwise. Read-only.
 */
export async function POST(request: NextRequest) {
  const auth = await checkSessionOrInternalAuth(request, { requireWorkflowId: false })
  if (!auth.success || !auth.userId) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 })
  }

  const parsed = RequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid option chain request', details: parsed.error.issues },
      { status: 400 }
    )
  }

  if (isIbkrHostedApi()) {
    return NextResponse.json({ error: IBKR_HOSTED_OPTIONS_UNSUPPORTED_MESSAGE }, { status: 400 })
  }

  let listing: ReturnType<typeof parseListingIdentityValueStrict>
  try {
    listing = parseListingIdentityValueStrict(parsed.data.listing)
  } catch {
    return NextResponse.json(
      { error: 'Select the underlying listing (a futures contract, stock, ETF or index)' },
      { status: 400 }
    )
  }

  try {
    const context = await resolveListingContext(listing)
    if (!context.assetClass) {
      return NextResponse.json(
        { error: 'The underlying listing has no asset class; pick it from IBKR search' },
        { status: 400 }
      )
    }

    const chain = await fetchIbkrOptionChain({
      symbol: resolveProviderSymbol(ibkrMarketProviderConfig, context),
      assetClass: context.assetClass,
      marketCode: context.marketCode,
      currency: context.quote,
      expiry: parsed.data.expiry,
      strikesPerSide: parsed.data.strikesPerSide,
      underlyingPrice: parsed.data.underlyingPrice,
    })
    return NextResponse.json(chain)
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : 'IBKR option chain failed'
    logger.warn('IBKR option chain failed', { listing, error: message })
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
