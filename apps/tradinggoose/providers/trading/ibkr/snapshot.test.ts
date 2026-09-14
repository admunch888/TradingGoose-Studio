import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getIbkrTradingAccounts } from '@/providers/trading/ibkr/accounts'
import { ensureIbkrSession } from '@/providers/trading/ibkr/session'
import {
  getIbkrTradingAccountSnapshot,
  normalizeIbkrSnapshotAccountSummary,
} from '@/providers/trading/ibkr/snapshot'
import { fetchBrokerJson } from '@/providers/trading/portfolio-utils'

vi.mock('@/providers/trading/portfolio-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/providers/trading/portfolio-utils')>()
  return { ...actual, fetchBrokerJson: vi.fn() }
})

vi.mock('@/providers/trading/ibkr/session', () => ({
  ensureIbkrSession: vi.fn(async () => undefined),
}))

const context = {
  providerId: 'ibkr',
  credentialId: 'cred-1',
  serviceId: 'ibkr-paper',
  accessToken: 'test-token',
  accountId: 'DU123456',
  environment: 'paper',
} as any

// A /portfolio/accounts row.
const portfolioAccount = {
  id: 'DU123456',
  accountId: 'DU123456',
  accountTitle: 'Paper Trading Account',
  accountAlias: null,
  currency: 'USD',
  type: 'DEMO',
  acctCustType: 'INDIVIDUAL',
  clearingStatus: 'O',
}

// /portfolio/{accountId}/summary fields: `{amount, currency, isNull, ...}`.
const summaryField = (amount: number) => ({
  amount,
  currency: 'USD',
  isNull: false,
  severity: 0,
  timestamp: 1712156105000,
  value: null,
})

describe('normalizeIbkrSnapshotAccountSummary', () => {
  it('reads amounts from the keyed summary object', () => {
    expect(
      normalizeIbkrSnapshotAccountSummary({
        totalcashvalue: summaryField(2500),
        netliquidation: summaryField(12500),
        equitywithloanvalue: summaryField(12000),
        buyingpower: summaryField(50000),
        accountcode: { amount: 0, isNull: false, value: 'DU123456' },
      })
    ).toEqual({
      totalCashValue: 2500,
      totalPortfolioValue: 12500,
      equity: 12000,
      buyingPower: 50000,
    })
  })

  it('falls back when fields are absent or null', () => {
    expect(
      normalizeIbkrSnapshotAccountSummary({
        netliquidation: summaryField(8000),
        equitywithloanvalue: { amount: 0, isNull: true },
        availablefunds: summaryField(3000),
      })
    ).toEqual({
      totalCashValue: 0,
      totalPortfolioValue: 8000,
      equity: 8000,
      buyingPower: 3000,
    })
  })

  it('treats anything but an object as an empty summary', () => {
    expect(normalizeIbkrSnapshotAccountSummary([])).toEqual({
      totalCashValue: 0,
      totalPortfolioValue: 0,
      equity: 0,
      buyingPower: 0,
    })
  })
})

describe('getIbkrTradingAccounts', () => {
  beforeEach(() => {
    vi.mocked(fetchBrokerJson).mockReset()
    vi.mocked(ensureIbkrSession).mockClear()
  })

  it('lists accounts from /portfolio/accounts', async () => {
    vi.mocked(fetchBrokerJson).mockResolvedValueOnce([portfolioAccount] as never)

    const identities = await getIbkrTradingAccounts(context)

    expect(ensureIbkrSession).toHaveBeenCalledWith({ accessToken: 'test-token' })
    expect(vi.mocked(fetchBrokerJson).mock.calls[0][0].url).toBe(
      'http://127.0.0.1:5000/v1/api/portfolio/accounts'
    )
    expect(identities).toEqual([
      expect.objectContaining({
        accountId: 'DU123456',
        accountName: 'Paper Trading Account',
        accountType: 'margin',
        accountStatus: 'active',
        baseCurrency: 'USD',
      }),
    ])
  })
})

describe('getIbkrTradingAccountSnapshot', () => {
  beforeEach(() => {
    vi.mocked(fetchBrokerJson).mockReset()
  })

  it('reads the account list before the account summary and positions', async () => {
    const order: string[] = []
    vi.mocked(fetchBrokerJson).mockImplementation(async ({ url }: { url: string }) => {
      order.push(url)
      if (url.endsWith('/portfolio/accounts')) return [portfolioAccount] as never
      if (url.endsWith('/summary')) {
        return {
          totalcashvalue: summaryField(2500),
          netliquidation: summaryField(12500),
          equitywithloanvalue: summaryField(12500),
          buyingpower: summaryField(50000),
        } as never
      }
      return [] as never
    })

    const detail = await getIbkrTradingAccountSnapshot(context)

    const accountsIndex = order.findIndex((url) => url.endsWith('/portfolio/accounts'))
    expect(accountsIndex).toBe(0)
    expect(order.some((url) => url.endsWith('/portfolio/DU123456/summary'))).toBe(true)
    expect(order.some((url) => url.endsWith('/portfolio/DU123456/positions/0'))).toBe(true)
    expect(detail).toMatchObject({
      summary: expect.objectContaining({
        totalCashValue: 2500,
        totalPortfolioValue: 12500,
        buyingPower: 50000,
      }),
    })
  })

  it('values futures holdings at their market value, not net liquidation minus cash', async () => {
    vi.mocked(fetchBrokerJson).mockImplementation(async ({ url }: { url: string }) => {
      if (url.endsWith('/portfolio/accounts')) return [portfolioAccount] as never
      if (url.endsWith('/summary')) {
        return {
          totalcashvalue: summaryField(112346),
          netliquidation: summaryField(112353.73),
          buyingpower: summaryField(400000),
        } as never
      }
      if (url.endsWith('/positions/0')) {
        return [
          {
            ticker: 'MES',
            assetClass: 'FUT',
            listingExchange: 'CME',
            expiry: '20261218',
            position: 2,
            mktValue: 77003,
            unrealizedPnl: -51,
            multiplier: 5,
          },
        ] as never
      }
      return [] as never
    })

    const detail = await getIbkrTradingAccountSnapshot(context)

    expect(detail.summary.totalHoldingsValue).toBe(77003)
    expect(detail.summary.totalUnrealizedPnl).toBe(-51)
  })

  it('falls back to net liquidation minus cash when no position reports a value', async () => {
    vi.mocked(fetchBrokerJson).mockImplementation(async ({ url }: { url: string }) => {
      if (url.endsWith('/portfolio/accounts')) return [portfolioAccount] as never
      if (url.endsWith('/summary')) {
        return {
          totalcashvalue: summaryField(2500),
          netliquidation: summaryField(12500),
        } as never
      }
      return [] as never
    })

    const detail = await getIbkrTradingAccountSnapshot(context)

    expect(detail.summary.totalHoldingsValue).toBe(10000)
  })
})
