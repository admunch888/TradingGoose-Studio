/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnsureIbkrSession, mockFetchIbkrMarketJson, mockReadCache, mockResolveConid } =
  vi.hoisted(() => ({
    mockEnsureIbkrSession: vi.fn(),
    mockFetchIbkrMarketJson: vi.fn(),
    mockReadCache: vi.fn(),
    mockResolveConid: vi.fn(),
  }))

vi.mock('@/lib/cache/server-json-cache', () => ({
  readServerJsonCache: (...args: unknown[]) => mockReadCache(...args),
  writeServerJsonCache: vi.fn(),
}))

vi.mock('@/providers/market/ibkr/pacing', () => ({
  fetchIbkrMarketJson: (...args: unknown[]) => mockFetchIbkrMarketJson(...args),
}))

vi.mock('@/providers/trading/ibkr/session', () => ({
  ensureIbkrSession: (...args: unknown[]) => mockEnsureIbkrSession(...args),
}))

vi.mock('@/providers/trading/ibkr/auth', () => ({
  buildIbkrAuthHeaders: () => ({ Accept: 'application/json' }),
  isIbkrHostedApi: () => false,
}))

vi.mock('@/providers/trading/ibkr/client', () => ({
  buildIbkrApiUrl: (path: string) => `https://gateway.local/v1/api${path}`,
  cacheIbkrConid: vi.fn(),
  getCachedIbkrConid: vi.fn(),
}))

vi.mock('@/providers/trading/ibkr/symbols', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/providers/trading/ibkr/symbols')>()
  return {
    ...actual,
    resolveIbkrConidFromApi: (...args: unknown[]) => mockResolveConid(...args),
  }
})

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}))

import {
  buildIbkrOptionQuote,
  fetchIbkrOptionChain,
  parseIbkrSnapshotNumber,
  resolveIbkrOptionSecType,
  selectIbkrOptionExpiry,
  selectIbkrOptionMonth,
  selectIbkrStrikeWindow,
  summarizeIbkrOptionChain,
  toIbkrOptionMonth,
} from '@/providers/market/ibkr/options'

const now = new Date('2026-09-14T15:00:00Z')

describe('option chain helpers', () => {
  it('maps asset classes to IBKR option security types', () => {
    expect(resolveIbkrOptionSecType('future')).toBe('FOP')
    expect(resolveIbkrOptionSecType('stock')).toBe('OPT')
    expect(resolveIbkrOptionSecType('indice')).toBe('OPT')
    expect(() => resolveIbkrOptionSecType('crypto')).toThrow('not crypto')
  })

  it('reads expiries as IBKR option months', () => {
    expect(toIbkrOptionMonth('20261016')).toBe('OCT26')
    expect(toIbkrOptionMonth('oct26')).toBe('OCT26')
    expect(toIbkrOptionMonth('2026-10-16')).toBeNull()
    expect(toIbkrOptionMonth(undefined)).toBeNull()
  })

  it('picks the requested month or the nearest current one', () => {
    const months = ['AUG26', 'SEP26', 'OCT26', 'DEC26']
    expect(selectIbkrOptionMonth(months, undefined, now)).toEqual({
      month: 'SEP26',
      months: ['SEP26', 'OCT26', 'DEC26'],
    })
    expect(selectIbkrOptionMonth(months, '20261016', now).month).toBe('OCT26')
    expect(() => selectIbkrOptionMonth(months, 'NOV26', now)).toThrow(
      'Available: SEP26, OCT26, DEC26'
    )
    expect(() => selectIbkrOptionMonth(months, 'next week', now)).toThrow('YYYYMMDD')
  })

  it('centres the strike window on the underlying price', () => {
    const strikes = [6400, 6425, 6450, 6475, 6500, 6525, 6550, 6450]
    expect(selectIbkrStrikeWindow(strikes, 6480, 1)).toEqual([6450, 6475, 6500])
    expect(selectIbkrStrikeWindow(strikes, 6390, 2)).toEqual([6400, 6425, 6450])
    expect(selectIbkrStrikeWindow(strikes, null, 1)).toEqual([6450, 6475, 6500])
    expect(selectIbkrStrikeWindow([], 6480, 3)).toEqual([])
  })

  it('picks the nearest unexpired expiry in the month, or the requested one', () => {
    const maturities = ['20260911', '20260918', '20260925', '20260918']
    expect(selectIbkrOptionExpiry(maturities, undefined, now)).toEqual({
      expiry: '20260918',
      expirations: ['20260911', '20260918', '20260925'],
    })
    expect(selectIbkrOptionExpiry(maturities, '20260925', now).expiry).toBe('20260925')
    expect(() => selectIbkrOptionExpiry(maturities, '20260930', now)).toThrow('not an expiry')
  })

  it('parses snapshot values with IBKR markers', () => {
    expect(parseIbkrSnapshotNumber('C12.50')).toBe(12.5)
    expect(parseIbkrSnapshotNumber('18.4%')).toBe(18.4)
    expect(parseIbkrSnapshotNumber('-0.482')).toBe(-0.482)
    expect(parseIbkrSnapshotNumber('')).toBeUndefined()
    expect(buildIbkrOptionQuote(1, { '84': '10', '86': '11', '7308': '0.51' })).toEqual({
      conid: 1,
      bid: 10,
      ask: 11,
      mid: 10.5,
      delta: 0.51,
    })
  })

  it('summarises the ATM straddle, implied move, IV and put/call interest', () => {
    const rows = [
      {
        strike: 6450,
        call: { conid: 1, mid: 60, impliedVolatility: 17, openInterest: 100 },
        put: { conid: 2, mid: 25, impliedVolatility: 19, openInterest: 300 },
      },
      {
        strike: 6475,
        call: { conid: 3, mid: 42, impliedVolatility: 16, openInterest: 200 },
        put: { conid: 4, mark: 38, impliedVolatility: 18, openInterest: 400 },
      },
    ]
    expect(summarizeIbkrOptionChain(rows, 6480, '20260918', now)).toEqual({
      atmStrike: 6475,
      straddlePrice: 80,
      impliedMove: 80,
      impliedMovePct: 1.235,
      atmImpliedVolatility: 17,
      putCallOpenInterestRatio: 2.333,
      daysToExpiry: 4,
    })
  })
})

describe('fetchIbkrOptionChain', () => {
  const searchRows = [
    {
      conid: '362702',
      symbol: 'MES',
      description: 'CME',
      sections: [
        { secType: 'FUT', months: 'SEP26;DEC26', exchange: 'CME' },
        { secType: 'FOP', months: 'AUG26;SEP26;OCT26', exchange: 'CME;QBALGO' },
      ],
    },
  ]
  const strikeRange = [6450, 6475, 6500, 6525]
  const conidFor = (strike: number, right: string) => strike * 10 + (right === 'C' ? 1 : 2)

  beforeEach(() => {
    vi.clearAllMocks()
    mockReadCache.mockResolvedValue(null)
    mockResolveConid.mockResolvedValue({ conid: 711280073, conidSpec: 'FUT' })
    let snapshotCalls = 0
    mockFetchIbkrMarketJson.mockImplementation(async ({ url }: { url: string }) => {
      const parsed = new URL(url)
      const params = parsed.searchParams
      switch (parsed.pathname) {
        case '/v1/api/iserver/secdef/search':
          return searchRows
        case '/v1/api/iserver/secdef/strikes':
          return { call: strikeRange, put: strikeRange }
        case '/v1/api/iserver/secdef/info': {
          const strike = Number(params.get('strike'))
          const right = params.get('right')!
          return [
            { conid: String(conidFor(strike, right) + 5000), maturityDate: '20260911', right },
            { conid: String(conidFor(strike, right)), maturityDate: '20260918', right },
          ]
        }
        case '/v1/api/iserver/marketdata/snapshot': {
          const conids = params.get('conids')!.split(',')
          if (conids.length === 1) return [{ conid: 711280073, '31': '6482.25' }]
          snapshotCalls++
          // The first read subscribes and answers without quote fields.
          if (snapshotCalls === 1) return conids.map((conid) => ({ conid: Number(conid) }))
          return conids.map((conid) => ({
            conid: Number(conid),
            '84': '20',
            '86': '21',
            '7633': '17.5%',
            '7308': Number(conid) % 10 === 1 ? '0.5' : '-0.5',
            '7638': '100',
            '6509': 'R',
          }))
        }
        default:
          throw new Error(`unexpected ${parsed.pathname}`)
      }
    })
  })

  it('loads the nearest futures-option expiry around the live underlying price', async () => {
    const chain = await fetchIbkrOptionChain({
      symbol: 'MESZ26',
      assetClass: 'future',
      marketCode: 'CME',
      strikesPerSide: 1,
      now,
    })

    const strikesCall = mockFetchIbkrMarketJson.mock.calls
      .map(([arg]) => new URL((arg as { url: string }).url))
      .find((url) => url.pathname.endsWith('/secdef/strikes'))!
    expect(Object.fromEntries(strikesCall.searchParams)).toEqual({
      conid: '362702',
      sectype: 'FOP',
      month: 'SEP26',
      exchange: 'CME',
    })

    expect(chain).toMatchObject({
      underlying: {
        symbol: 'MESZ26',
        root: 'MES',
        exchange: 'CME',
        price: 6482.25,
        priceSource: 'snapshot',
      },
      secType: 'FOP',
      month: 'SEP26',
      months: ['SEP26', 'OCT26'],
      expiry: '20260918',
      expirations: ['20260911', '20260918'],
      marketDataAvailability: 'R',
    })
    expect(chain.rows.map((row) => row.strike)).toEqual([6450, 6475, 6500])
    expect(chain.rows[1]).toEqual({
      strike: 6475,
      call: {
        conid: 64751,
        bid: 20,
        ask: 21,
        mid: 20.5,
        impliedVolatility: 17.5,
        delta: 0.5,
        openInterest: 100,
      },
      put: {
        conid: 64752,
        bid: 20,
        ask: 21,
        mid: 20.5,
        impliedVolatility: 17.5,
        delta: -0.5,
        openInterest: 100,
      },
    })
    expect(chain.summary).toMatchObject({ atmStrike: 6475, straddlePrice: 41, daysToExpiry: 4 })
    expect(mockEnsureIbkrSession).toHaveBeenCalledTimes(1)
  })

  it('uses a supplied underlying price without quoting the underlying', async () => {
    const chain = await fetchIbkrOptionChain({
      symbol: 'MESZ26',
      assetClass: 'future',
      strikesPerSide: 1,
      underlyingPrice: 6520,
      expiry: '20260911',
      now,
    })

    expect(mockResolveConid).not.toHaveBeenCalled()
    expect(chain.underlying).toMatchObject({ price: 6520, priceSource: 'input' })
    expect(chain.expiry).toBe('20260911')
    expect(chain.rows.map((row) => row.strike)).toEqual([6500, 6525])
    expect(chain.rows[0]?.call?.conid).toBe(65001 + 5000)
  })

  it('explains an underlying with no options of the needed type', async () => {
    mockFetchIbkrMarketJson.mockResolvedValueOnce([
      { conid: '1', symbol: 'XYZ', sections: [{ secType: 'STK' }] },
    ])

    await expect(fetchIbkrOptionChain({ symbol: 'XYZ', assetClass: 'stock', now })).rejects.toThrow(
      'IBKR lists no OPT options for XYZ'
    )
  })
})
