import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getIbkrTradingAccountPerformance,
  normalizeIbkrPerformanceResponse,
} from '@/providers/trading/ibkr/performance'
import { fetchBrokerJson } from '@/providers/trading/portfolio-utils'

vi.mock('@/providers/trading/portfolio-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/providers/trading/portfolio-utils')>()
  return { ...actual, fetchBrokerJson: vi.fn() }
})

// The /pa/performance shape: `nav.dates[i]` is the date of `nav.data[].navs[i]`.
const performanceResponse = (
  dates: string[],
  entries: Array<{ id: string; navs: Array<number | null>; baseCurrency?: string }>,
  freq = 'D'
) => ({
  currencyType: 'base',
  nav: {
    freq,
    dates,
    data: entries.map((entry) => ({ idType: 'acctid', baseCurrency: 'USD', ...entry })),
  },
})

describe('normalizeIbkrPerformanceResponse', () => {
  it('normalizes daily performance data', () => {
    const response = performanceResponse(
      ['20260801', '20260802', '20260803'],
      [{ id: 'DU123456', navs: [1000, 1010, 1020] }]
    )

    const result = normalizeIbkrPerformanceResponse({
      response,
      currency: 'USD',
      window: '1W',
    })

    expect(result.window).toBe('1W')
    expect(result.series).toHaveLength(3)
    expect(result.series[0]).toMatchObject({ timestamp: '2026-08-01T00:00:00.000Z', equity: 1000 })
    expect(result.series[2]).toMatchObject({ equity: 1020 })
    expect(result.summary).toMatchObject({
      currency: 'USD',
      startEquity: 1000,
      endEquity: 1020,
      absoluteReturn: 20,
    })
  })

  it("reads the requested account's navs when several accounts are returned", () => {
    const response = performanceResponse(
      ['20260801', '20260802'],
      [
        { id: 'DU000001', navs: [1, 2] },
        { id: 'DU123456', navs: [500, 550] },
      ]
    )

    const result = normalizeIbkrPerformanceResponse({
      response,
      currency: 'USD',
      window: '1M',
      accountId: 'DU123456',
    })

    expect(result.series.map((point) => point.equity)).toEqual([500, 550])
  })

  it('skips dates without a nav value instead of reading them as zero', () => {
    const response = performanceResponse(
      ['20260801', '20260802', '20260803'],
      [{ id: 'DU123456', navs: [1000, null, 1020] }]
    )

    const result = normalizeIbkrPerformanceResponse({
      response,
      currency: 'USD',
      window: '1M',
    })

    expect(result.series.map((point) => point.equity)).toEqual([1000, 1020])
  })

  it('handles empty data as unavailable', () => {
    const result = normalizeIbkrPerformanceResponse({
      response: performanceResponse([], [{ id: 'DU123456', navs: [] }], 'M'),
      currency: 'USD',
      window: '1Y',
    })

    expect(result.summary).toBeNull()
    expect(result.unavailableReason).toBeTruthy()
  })

  it('handles missing nav as unavailable', () => {
    const result = normalizeIbkrPerformanceResponse({
      response: {},
      currency: 'USD',
      window: '1M',
    })

    expect(result.summary).toBeNull()
    expect(result.series).toEqual([])
  })
})

describe('getIbkrTradingAccountPerformance', () => {
  const context = {
    providerId: 'ibkr',
    credentialId: 'cred-1',
    serviceId: 'ibkr-paper',
    accessToken: 'test-token',
    accountId: 'DU123456',
  } as any

  beforeEach(() => {
    vi.mocked(fetchBrokerJson).mockReset()
  })

  it.each([
    ['1W', '7D'],
    ['1M', '1M'],
    ['3M', '3M'],
    ['YTD', 'YTD'],
    ['1Y', '12M'],
  ])('requests the %s window as the /pa/performance %s period', async (window, period) => {
    vi.mocked(fetchBrokerJson).mockResolvedValueOnce(
      performanceResponse(
        ['20260801', '20260802'],
        [{ id: 'DU123456', navs: [100, 110], baseCurrency: 'EUR' }]
      ) as never
    )

    const result = await getIbkrTradingAccountPerformance({ ...context, window })

    const [{ url, init }] = vi.mocked(fetchBrokerJson).mock.calls[0]
    expect(url).toBe('http://127.0.0.1:5000/v1/api/pa/performance')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ acctIds: ['DU123456'], period })
    expect(result.summary).toMatchObject({ currency: 'EUR', endEquity: 110 })
  })

  it('reports MAX as unsupported without calling IBKR', async () => {
    const result = await getIbkrTradingAccountPerformance({ ...context, window: 'MAX' })

    expect(fetchBrokerJson).not.toHaveBeenCalled()
    expect(result.unavailableReason).toContain('MAX')
  })
})
