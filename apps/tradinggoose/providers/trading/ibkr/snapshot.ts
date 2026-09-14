import {
  getIbkrTradingAccounts,
  normalizeIbkrTradingAccount,
} from '@/providers/trading/ibkr/accounts'
import { buildIbkrAuthHeaders } from '@/providers/trading/ibkr/auth'
import { buildIbkrAccountUrl } from '@/providers/trading/ibkr/client'
import {
  getIbkrTradingPositions,
  IBKR_DEFAULT_BASE_CURRENCY,
  sumIbkrPositionMarketValue,
  sumIbkrPositionUnrealizedPnl,
} from '@/providers/trading/ibkr/positions'
import { buildPortfolioDetail } from '@/providers/trading/portfolio-detail'
import type { PortfolioDetail } from '@/providers/trading/portfolio-identity'
import { fetchBrokerJson } from '@/providers/trading/portfolio-utils'
import type { TradingPortfolioAccountContext } from '@/providers/trading/types'

/**
 * /portfolio/{accountId}/summary is an object keyed by field name, each value
 * `{amount, currency, isNull, value, ...}`; numeric fields carry `amount`.
 */
export const normalizeIbkrSnapshotAccountSummary = (summary: unknown) => {
  const record =
    summary && typeof summary === 'object' && !Array.isArray(summary)
      ? (summary as Record<string, any>)
      : {}

  const amount = (key: string): number | undefined => {
    const entry = record[key]
    if (entry === null || entry === undefined || entry?.isNull === true) return undefined
    const raw = typeof entry === 'object' ? entry.amount : entry
    if (raw === null || raw === undefined || raw === '') return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  const totalCashValue = amount('totalcashvalue') ?? 0
  const netLiquidation = amount('netliquidation')
  const equity = amount('equitywithloanvalue') ?? netLiquidation ?? 0
  const totalPortfolioValue = netLiquidation ?? equity
  const buyingPower = amount('buyingpower') ?? amount('availablefunds') ?? 0

  return {
    totalCashValue,
    totalPortfolioValue,
    equity,
    buyingPower,
  }
}

export async function getIbkrTradingAccountSnapshot(
  context: TradingPortfolioAccountContext
): Promise<PortfolioDetail> {
  const headers = buildIbkrAuthHeaders({ accessToken: context.accessToken })

  // IBKR requires /portfolio/accounts before any /portfolio/{accountId}/* call,
  // so the account list is read first rather than alongside summary and positions.
  const identities = await getIbkrTradingAccounts(context)
  const accountIdentity =
    identities.find((identity) => identity.accountId === context.accountId) ?? identities[0]
  if (!accountIdentity) {
    throw new Error('IBKR account not found for connected session')
  }

  const [summary, positions] = await Promise.all([
    fetchBrokerJson<unknown>({
      providerId: context.providerId,
      url: buildIbkrAccountUrl(context.accountId, '/summary'),
      init: { method: 'GET', headers },
    }),
    getIbkrTradingPositions(context),
  ])

  const account = normalizeIbkrTradingAccount(accountIdentity, context)
  const summaryTotals = normalizeIbkrSnapshotAccountSummary(summary)
  const totalUnrealizedPnl = sumIbkrPositionUnrealizedPnl(positions)
  const totalHoldingsValue =
    sumIbkrPositionMarketValue(positions) ??
    summaryTotals.totalPortfolioValue - summaryTotals.totalCashValue

  return buildPortfolioDetail({
    identity: {
      ...account,
      baseCurrency: account.baseCurrency || IBKR_DEFAULT_BASE_CURRENCY,
    },
    environment: context.environment ?? 'live',
    asOf: new Date().toISOString(),
    cashBalances: [
      {
        currency: account.baseCurrency || IBKR_DEFAULT_BASE_CURRENCY,
        currencySymbol: account.baseCurrency === IBKR_DEFAULT_BASE_CURRENCY ? '$' : undefined,
        amount: summaryTotals.totalCashValue,
        conversionRate: account.baseCurrency === IBKR_DEFAULT_BASE_CURRENCY ? 1 : undefined,
        amountInAccountCurrency: summaryTotals.totalCashValue,
      },
    ],
    positions,
    summary: {
      totalPortfolioValue: summaryTotals.totalPortfolioValue,
      totalCashValue: summaryTotals.totalCashValue,
      totalHoldingsValue,
      totalUnrealizedPnl,
      buyingPower: summaryTotals.buyingPower,
      equity: summaryTotals.equity,
    },
  })
}
