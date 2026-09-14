import { resolveTradingListingIdentity } from '@/providers/trading/listing-resolution'
import type {
  PortfolioDetail,
  PortfolioEnvironment,
  PortfolioIdentity,
} from '@/providers/trading/portfolio-identity'
import type {
  UnifiedTradingAccountSummary,
  UnifiedTradingCashBalance,
  UnifiedTradingOrder,
  UnifiedTradingPosition,
} from '@/providers/trading/types'

/**
 * Mapping a broker position onto a catalogue listing is enrichment, not the
 * portfolio: a lookup that cannot complete (the catalogue is rate limited, or
 * the process cannot reach the app URL - the realtime container's
 * NEXT_PUBLIC_APP_URL is the browser's localhost) keeps the broker's own
 * identity instead of failing every account snapshot with "Unable to connect".
 */
const resolvePortfolioPositions = async (positions: UnifiedTradingPosition[]) =>
  Promise.all(
    positions.map(async (position) => {
      const listingIdentity = position.listingIdentity
      let resolvedListingIdentity: Awaited<ReturnType<typeof resolveTradingListingIdentity>> = null
      if (listingIdentity) {
        try {
          resolvedListingIdentity = await resolveTradingListingIdentity({
            listing: listingIdentity,
          })
        } catch {
          resolvedListingIdentity = null
        }
      }

      return {
        ...position,
        listingIdentity: resolvedListingIdentity ?? listingIdentity,
      }
    })
  )

export async function buildPortfolioDetail({
  identity,
  environment,
  asOf,
  cashBalances,
  positions,
  orders,
  summary,
}: {
  identity: PortfolioIdentity
  environment: PortfolioEnvironment
  asOf: string
  cashBalances: UnifiedTradingCashBalance[]
  positions: UnifiedTradingPosition[]
  orders?: UnifiedTradingOrder[]
  summary: UnifiedTradingAccountSummary
}): Promise<PortfolioDetail> {
  return {
    ...identity,
    environment,
    asOf,
    cashBalances,
    positions: await resolvePortfolioPositions(positions),
    orders: orders ?? [],
    summary,
  }
}
