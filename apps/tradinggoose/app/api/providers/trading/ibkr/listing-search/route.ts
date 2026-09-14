import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { createLogger } from '@/lib/logs/console/logger'
import { searchIbkrListings } from '@/providers/market/ibkr/listing-search'
import { MARKET_ASSET_CLASSES } from '@/providers/market/types'
import { isIbkrHostedApi } from '@/providers/trading/ibkr/auth'

export const dynamic = 'force-dynamic'

const logger = createLogger('IbkrListingSearchRoute')

const QuerySchema = z.object({
  q: z.string().trim().min(1).max(32),
  asset_class: z.enum(MARKET_ASSET_CLASSES).optional(),
})

export const IBKR_HOSTED_SEARCH_UNSUPPORTED_MESSAGE =
  'IBKR symbol search needs the Client Portal Gateway. Enter the symbol manually below.'

/**
 * Listing search answered by the IBKR gateway, so IBKR charts and orders do not
 * spend the hosted listing catalogue's request quota. Read-only.
 */
export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'User not authenticated' }, { status: 401 })
  }

  const parsed = QuerySchema.safeParse({
    q: request.nextUrl.searchParams.get('q') ?? '',
    asset_class: request.nextUrl.searchParams.get('asset_class') || undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter a symbol to search IBKR' }, { status: 400 })
  }

  // The hosted API needs the caller's OAuth token, which the picker does not
  // hold. The gateway session is what this deployment runs.
  if (isIbkrHostedApi()) {
    return NextResponse.json({ error: IBKR_HOSTED_SEARCH_UNSUPPORTED_MESSAGE }, { status: 400 })
  }

  try {
    const data = await searchIbkrListings({
      query: parsed.data.q,
      assetClass: parsed.data.asset_class,
    })
    return NextResponse.json({ data })
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'IBKR search failed'
    logger.warn('IBKR listing search failed', { query: parsed.data.q, error: message })
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
