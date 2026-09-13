import { buildIbkrAuthHeaders } from '@/providers/trading/ibkr/auth'
import { buildIbkrApiUrl } from '@/providers/trading/ibkr/client'
import { ibkrTradingProviderConfig } from '@/providers/trading/ibkr/config'
import {
  buildTradingPortfolioPerformance,
  createUnavailableTradingPortfolioPerformance,
  fetchBrokerJson,
} from '@/providers/trading/portfolio-utils'
import type {
  TradingPortfolioAccountContext,
  TradingPortfolioPerformanceWindow,
  UnifiedTradingPortfolioPerformance,
  UnifiedTradingPortfolioPerformancePoint,
} from '@/providers/trading/types'

/**
 * POST /pa/performance periods: 1D, 7D, MTD, 1M, 3M, 6M, 12M and YTD. Nothing
 * longer than 12M exists, so there is no MAX window.
 */
const IBKR_PERIOD_BY_WINDOW: Partial<Record<TradingPortfolioPerformanceWindow, string>> = {
  '1W': '7D',
  '1M': '1M',
  '3M': '3M',
  YTD: 'YTD',
  '1Y': '12M',
}

const getIbkrSupportedPerformanceWindows = () =>
  ibkrTradingProviderConfig.capabilities?.portfolioDetail?.performanceWindows ?? []

/** /pa/performance dates are `YYYYMMDD` strings. */
const parseIbkrPerformanceDate = (value: unknown): string | null => {
  const text =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!text) return null
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

const toEquity = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The NAV entry for the account, or the first (consolidated) one. */
const selectIbkrNavEntry = (response: any, accountId?: string): Record<string, any> | undefined => {
  const entries = Array.isArray(response?.nav?.data) ? response.nav.data : []
  return entries.find((entry: any) => accountId && entry?.id === accountId) ?? entries[0]
}

/**
 * Maps /pa/performance onto an equity series: `nav.dates[i]` is the date of
 * `nav.data[].navs[i]`.
 */
export const normalizeIbkrPerformanceResponse = ({
  response,
  currency,
  window,
  accountId,
}: {
  response: any
  currency: string
  window: TradingPortfolioPerformanceWindow
  accountId?: string
}): UnifiedTradingPortfolioPerformance => {
  const dates: unknown[] = Array.isArray(response?.nav?.dates) ? response.nav.dates : []
  const navs: unknown[] = Array.isArray(selectIbkrNavEntry(response, accountId)?.navs)
    ? (selectIbkrNavEntry(response, accountId)?.navs as unknown[])
    : []

  const series: UnifiedTradingPortfolioPerformancePoint[] = []
  dates.forEach((date, index) => {
    const timestamp = parseIbkrPerformanceDate(date)
    const equity = toEquity(navs[index])
    if (timestamp && typeof equity === 'number') {
      series.push({ timestamp, equity })
    }
  })

  if (series.length === 0) {
    return createUnavailableTradingPortfolioPerformance({
      window,
      supportedWindows: getIbkrSupportedPerformanceWindows(),
      unavailableReason: 'No usable performance data returned by broker',
    })
  }

  const sorted = series.sort((left, right) => left.timestamp.localeCompare(right.timestamp))
  const aggregated: UnifiedTradingPortfolioPerformancePoint[] = []
  const seen = new Map<string, UnifiedTradingPortfolioPerformancePoint>()
  for (const point of sorted) {
    const key = point.timestamp.slice(0, 10)
    const existing = seen.get(key)
    if (existing) {
      existing.equity = point.equity
    } else {
      seen.set(key, point)
      aggregated.push(point)
    }
  }

  const maxPoints = response?.nav?.freq === 'D' ? 2000 : 500
  const limited = aggregated.slice(-maxPoints)

  return buildTradingPortfolioPerformance({
    window,
    supportedWindows: getIbkrSupportedPerformanceWindows(),
    series: limited,
    currency,
    unavailableReason: 'No usable performance data returned by broker',
  })
}

export async function getIbkrTradingAccountPerformance(
  context: TradingPortfolioAccountContext & { window: TradingPortfolioPerformanceWindow }
): Promise<UnifiedTradingPortfolioPerformance> {
  const period = IBKR_PERIOD_BY_WINDOW[context.window]
  if (!period) {
    return createUnavailableTradingPortfolioPerformance({
      window: context.window,
      supportedWindows: getIbkrSupportedPerformanceWindows(),
      unavailableReason: `IBKR performance window ${context.window} is not supported`,
    })
  }

  const response = await fetchBrokerJson<any>({
    providerId: context.providerId,
    url: buildIbkrApiUrl('/pa/performance'),
    init: {
      method: 'POST',
      headers: {
        ...buildIbkrAuthHeaders({ accessToken: context.accessToken }),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ acctIds: [context.accountId], period }),
    },
  })

  const baseCurrency = selectIbkrNavEntry(response, context.accountId)?.baseCurrency
  const currency =
    typeof baseCurrency === 'string' && baseCurrency.trim()
      ? baseCurrency.trim().toUpperCase()
      : 'USD'

  return normalizeIbkrPerformanceResponse({
    response,
    currency,
    window: context.window,
    accountId: context.accountId,
  })
}
