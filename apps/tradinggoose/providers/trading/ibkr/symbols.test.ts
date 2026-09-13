import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheIbkrConid, clearIbkrConidCache } from '@/providers/trading/ibkr/client'
import {
  buildIbkrConidCacheKey,
  ibkrSymbolCandidates,
  resolveIbkrConid,
  resolveIbkrConidFromApi,
  resolveIbkrConidSpec,
} from '@/providers/trading/ibkr/symbols'
import { fetchBrokerJson } from '@/providers/trading/portfolio-utils'

vi.mock('@/providers/trading/portfolio-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/providers/trading/portfolio-utils')>()
  return { ...actual, fetchBrokerJson: vi.fn() }
})

/**
 * Trimmed from a real POST /iserver/secdef/search response: a BARE ARRAY, the
 * conid as a string, and the available security types nested under `sections`.
 */
const aaplSecDefRows = [
  {
    conid: '265598',
    symbol: 'AAPL',
    description: 'NASDAQ',
    sections: [{ secType: 'STK' }, { secType: 'OPT', months: 'SEP26' }, { secType: 'CFD' }],
  },
  {
    conid: '532640894',
    symbol: 'AAPL',
    description: 'TSE',
    sections: [{ secType: 'STK' }],
  },
  {
    conid: '2147483647',
    symbol: null,
    description: null,
    sections: [{ secType: 'BOND' }],
  },
]

/**
 * Two expiries of one futures root. The section's `months` is what tells them
 * apart - without it (and without the expiry key dimension) one `FUT:MES`
 * entry served whichever contract month the search happened to return.
 */
const mesFutureRows = [
  {
    conid: '466221142',
    symbol: 'MES',
    description: 'CME',
    sections: [{ secType: 'FUT', months: 'SEP26' }],
  },
  {
    conid: '515151515',
    symbol: 'MES',
    description: 'CME',
    sections: [{ secType: 'FUT', months: 'DEC26' }],
  },
]

describe('resolveIbkrConidSpec', () => {
  it('maps asset classes to IBKR security types', () => {
    expect(resolveIbkrConidSpec('stock')).toBe('STK')
    expect(resolveIbkrConidSpec('etf')).toBe('STK')
    expect(resolveIbkrConidSpec('future')).toBe('FUT')
    expect(resolveIbkrConidSpec('currency')).toBe('CASH')
    expect(resolveIbkrConidSpec('indice')).toBe('IND')
    expect(resolveIbkrConidSpec('mutualfund')).toBe('FUND')
    expect(resolveIbkrConidSpec(undefined)).toBe('STK')
  })
})

describe('buildIbkrConidCacheKey', () => {
  it('writes every listing dimension so one caller always builds one key', () => {
    expect(buildIbkrConidCacheKey('aapl', 'stock')).toBe('STK:AAPL:-:-:-')
    expect(buildIbkrConidCacheKey('ES', 'future')).toBe('FUT:ES:-:-:-')
    expect(buildIbkrConidCacheKey('aapl', 'stock', { exchange: 'NASDAQ', currency: 'USD' })).toBe(
      'STK:AAPL:NASDAQ:USD:-'
    )
    // The app's market code stands in when there is no IBKR venue name; it is
    // normalized, so casing cannot split one listing across two entries.
    expect(buildIbkrConidCacheKey('aapl', 'stock', { marketCode: 'xnas', currency: 'usd' })).toBe(
      'STK:AAPL:XNAS:USD:-'
    )
    expect(buildIbkrConidCacheKey('ES', 'future', { exchange: 'CME', expiry: 'Sep26' })).toBe(
      'FUT:ES:CME:-:SEP26'
    )
  })

  it('never lets two listings of one symbol share an entry', () => {
    const nasdaq = buildIbkrConidCacheKey('AAPL', 'stock', { exchange: 'NASDAQ', currency: 'USD' })
    const tse = buildIbkrConidCacheKey('AAPL', 'stock', { exchange: 'TSE', currency: 'CAD' })

    expect(nasdaq).not.toBe(tse)
  })

  it('never lets two expiries of one futures root share an entry', () => {
    const september = buildIbkrConidCacheKey('MES', 'future', { exchange: 'CME', expiry: 'SEP26' })
    const december = buildIbkrConidCacheKey('MES', 'future', { exchange: 'CME', expiry: 'DEC26' })

    expect(september).not.toBe(december)
  })
})

describe('resolveIbkrConid', () => {
  beforeEach(() => {
    clearIbkrConidCache()
  })

  it('returns cached conid', () => {
    cacheIbkrConid(buildIbkrConidCacheKey('AAPL', 'stock'), 265598)
    const resolution = resolveIbkrConid({ symbol: 'AAPL', assetClass: 'stock' })
    expect(resolution).toEqual({ conid: 265598, conidSpec: 'STK' })
  })

  it('reads the entry for the listing the caller asked for', () => {
    // Two listings of one symbol; the synchronous read has to pick the right
    // entry from the context rather than the first one that was cached.
    cacheIbkrConid(buildIbkrConidCacheKey('AAPL', 'stock', { exchange: 'NASDAQ' }), 265598)
    cacheIbkrConid(buildIbkrConidCacheKey('AAPL', 'stock', { exchange: 'TSE' }), 532640894)

    expect(
      resolveIbkrConid({ symbol: 'AAPL', assetClass: 'stock', context: { exchange: 'TSE' } }).conid
    ).toBe(532640894)
    expect(
      resolveIbkrConid({ symbol: 'AAPL', assetClass: 'stock', context: { exchange: 'NASDAQ' } })
        .conid
    ).toBe(265598)
  })

  it('does not serve another exchange from the cached entry', () => {
    cacheIbkrConid(buildIbkrConidCacheKey('AAPL', 'stock', { exchange: 'NASDAQ' }), 265598)

    expect(() =>
      resolveIbkrConid({ symbol: 'AAPL', assetClass: 'stock', context: { exchange: 'TSE' } })
    ).toThrow('contract identifier not resolved')
  })

  it('throws when conid is not cached', () => {
    expect(() => resolveIbkrConid({ symbol: 'AAPL', assetClass: 'stock' })).toThrow(
      'contract identifier not resolved'
    )
  })
})

describe('ibkrSymbolCandidates', () => {
  it('offers the marked futures form first, then the bare symbol', () => {
    // What the catalogue actually produced: `FMES` with quote USD for a
    // contract searched for as `MES`.
    expect(ibkrSymbolCandidates('FMES', 'future')).toEqual(['FMES', 'MES'])
    expect(ibkrSymbolCandidates('F*MES', 'future')).toEqual(['F*MES', 'MES'])
  })

  it('leaves a futures symbol that legitimately starts with F alone', () => {
    // FDAX is a real future; stripping it would break a contract that works.
    expect(ibkrSymbolCandidates('FDAX', 'future')).toEqual(['FDAX', 'DAX'])
    expect(ibkrSymbolCandidates('F', 'future')).toEqual(['F'])
  })

  it('never strips for a non-futures asset class, because F is a real ticker', () => {
    expect(ibkrSymbolCandidates('F', 'stock')).toEqual(['F'])
    expect(ibkrSymbolCandidates('FMES', 'stock')).toEqual(['FMES'])
    expect(ibkrSymbolCandidates('F', undefined)).toEqual(['F'])
  })
})

describe('resolveIbkrConidFromApi', () => {
  it('falls back to the bare symbol when the marked futures form does not match', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        { conid: '466221142', symbol: 'MES', sections: [{ secType: 'FUT' }] },
      ] as never)

    const resolution = await resolveIbkrConidFromApi({ symbol: 'FMES', assetClass: 'future' })

    expect(resolution).toEqual({ conid: 466221142, conidSpec: 'FUT' })
    expect(fetchBrokerJson).toHaveBeenCalledTimes(2)
  })

  beforeEach(() => {
    clearIbkrConidCache()
    vi.mocked(fetchBrokerJson).mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses the cache when seeded', async () => {
    cacheIbkrConid(buildIbkrConidCacheKey('MSFT', 'stock'), 272093)
    const resolution = await resolveIbkrConidFromApi({
      symbol: 'MSFT',
      assetClass: 'stock',
      accessToken: 'token',
    })
    expect(resolution.conid).toBe(272093)
  })

  it('resolves the primary listing from the bare-array response', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockResolvedValue(aaplSecDefRows as never)

    const resolution = await resolveIbkrConidFromApi({ symbol: 'AAPL', assetClass: 'stock' })

    expect(resolution).toEqual({ conid: 265598, conidSpec: 'STK' })
    expect(fetchBrokerJson).toHaveBeenCalledTimes(1)
  })

  it('still accepts a wrapped { contracts } envelope', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockResolvedValue({
      contracts: [{ conid: '272093', symbol: 'MSFT', sections: [{ secType: 'STK' }] }],
    } as never)

    const resolution = await resolveIbkrConidFromApi({ symbol: 'MSFT', assetClass: 'stock' })

    expect(resolution.conid).toBe(272093)
  })

  it('ignores rows that do not offer the requested asset class', async () => {
    // The bond row carries no STK section, so a stock lookup must not accept it.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockResolvedValue([
      { conid: '2147483647', symbol: null, sections: [{ secType: 'BOND' }] },
    ] as never)

    await expect(resolveIbkrConidFromApi({ symbol: 'AAPL', assetClass: 'stock' })).rejects.toThrow(
      'Unable to resolve IBKR contract identifier'
    )
  })

  it('resolves the exchange-qualified listing instead of the first row', async () => {
    // The fixture holds AAPL twice: NASDAQ (conid 265598) is the first row and
    // TSE (conid 532640894) the second. Taking the first row gave both callers
    // 265598, i.e. a Toronto order sent for the NASDAQ share.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockResolvedValue(aaplSecDefRows as never)

    const nasdaq = await resolveIbkrConidFromApi({
      symbol: 'AAPL',
      assetClass: 'stock',
      context: { exchange: 'NASDAQ', currency: 'USD' },
    })
    const tse = await resolveIbkrConidFromApi({
      symbol: 'AAPL',
      assetClass: 'stock',
      context: { exchange: 'TSE', currency: 'CAD' },
    })

    expect(nasdaq.conid).toBe(265598)
    expect(tse.conid).toBe(532640894)
    // Two listings, two entries: the second lookup is not served from the first.
    expect(fetchBrokerJson).toHaveBeenCalledTimes(2)
  })

  it('matches the venue on a section exchange when the row carries one', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockResolvedValue([
      { conid: '265598', symbol: 'AAPL', sections: [{ secType: 'STK', exchange: 'NASDAQ' }] },
      { conid: '532640894', symbol: 'AAPL', sections: [{ secType: 'STK', exchange: 'TSE' }] },
    ] as never)

    const resolution = await resolveIbkrConidFromApi({
      symbol: 'AAPL',
      assetClass: 'stock',
      context: { exchange: 'TSE' },
    })

    expect(resolution.conid).toBe(532640894)
  })

  it('keeps the first matching row for a caller with no exchange context', async () => {
    // The old behaviour, kept deliberately for callers that know nothing about
    // the venue: they get the entry IBKR lists first, under their own key.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockResolvedValue(aaplSecDefRows as never)

    const resolution = await resolveIbkrConidFromApi({ symbol: 'AAPL', assetClass: 'stock' })

    expect(resolution.conid).toBe(265598)
  })

  it('falls back to the first matching row when the market code is not an IBKR venue name', async () => {
    // `XNAS` is the app's MIC-style market code, not the venue string IBKR
    // returns. Neither IBKR config maps one to the other, so this stays a
    // first-match - scoped to the XNAS entry, logged, and structurally unable
    // to serve another market.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockResolvedValue(aaplSecDefRows as never)

    const resolution = await resolveIbkrConidFromApi({
      symbol: 'AAPL',
      assetClass: 'stock',
      context: { marketCode: 'XNAS', currency: 'USD' },
    })

    expect(resolution.conid).toBe(265598)
  })

  it('does not share a cache entry between two expiries of one futures root', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockResolvedValue(mesFutureRows as never)

    const september = await resolveIbkrConidFromApi({
      symbol: 'MES',
      assetClass: 'future',
      context: { exchange: 'CME', currency: 'USD', expiry: 'SEP26' },
    })
    const december = await resolveIbkrConidFromApi({
      symbol: 'MES',
      assetClass: 'future',
      context: { exchange: 'CME', currency: 'USD', expiry: 'DEC26' },
    })

    expect(september.conid).toBe(466221142)
    expect(december.conid).toBe(515151515)
    expect(fetchBrokerJson).toHaveBeenCalledTimes(2)
  })

  it('does not let the marked futures root serve the bare root', async () => {
    // `FMES` resolves through its own fallback candidate - and must not then
    // answer for `MES`, which is a different cache entry of its own.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        { conid: '466221142', symbol: 'MES', sections: [{ secType: 'FUT' }] },
      ] as never)
      .mockResolvedValueOnce([
        { conid: '515151515', symbol: 'MES', sections: [{ secType: 'FUT' }] },
      ] as never)

    const marked = await resolveIbkrConidFromApi({
      symbol: 'FMES',
      assetClass: 'future',
      context: { exchange: 'CME', currency: 'USD' },
    })
    const bare = await resolveIbkrConidFromApi({
      symbol: 'MES',
      assetClass: 'future',
      context: { exchange: 'CME', currency: 'USD' },
    })

    expect(marked.conid).toBe(466221142)
    expect(bare.conid).toBe(515151515)
    expect(fetchBrokerJson).toHaveBeenCalledTimes(3)
  })

  it('requires an access token only against the hosted API', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'https://api.ibkr.com/v1/api')

    await expect(resolveIbkrConidFromApi({ symbol: 'AAPL', assetClass: 'stock' })).rejects.toThrow(
      'hosted API requires an access token'
    )

    expect(fetchBrokerJson).not.toHaveBeenCalled()
  })
})
