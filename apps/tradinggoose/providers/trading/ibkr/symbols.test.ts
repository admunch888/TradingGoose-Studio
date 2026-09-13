import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheIbkrConid, clearIbkrConidCache } from '@/providers/trading/ibkr/client'
import {
  buildIbkrConidCacheKey,
  ibkrSymbolCandidates,
  parseIbkrFuturesContractMonth,
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

/**
 * One futures root across several contract months, in the shape the live
 * secdef/search answered with. `MESZ25` is the Micro E-mini S&P the market
 * listing dropdown supplies for December 2025: the search endpoint only knows
 * the ROOT `MES`, and a section's `months` - `MMMYY`, SEMICOLON separated - is
 * what tells contract months apart. A month none of these rows offers must fail
 * rather than fall back to the first FUT section.
 */
const mesContractMonthRows = [
  {
    conid: '466221142',
    symbol: 'MES',
    description: 'CME',
    sections: [{ secType: 'FUT', exchange: 'CME', months: 'SEP26' }],
  },
  {
    conid: '515151515',
    symbol: 'MES',
    description: 'CME',
    sections: [{ secType: 'FUT', exchange: 'CME', months: 'DEC25;MAR26' }],
  },
  {
    conid: '606060606',
    symbol: 'MES',
    description: 'CME',
    sections: [{ secType: 'FUT', exchange: 'CME', months: 'DEC26' }],
  },
]

/**
 * ONE row listing SEVERAL contract months the way IBKR documents them, in the
 * only delimiter the live payload uses - a semicolon. PR #22 split a section's
 * `months` on a comma, so this whole string became a single token that could
 * never equal a requested month, every section was ruled out, and the lookup
 * failed live with "Unable to resolve IBKR contract identifier".
 */
const mesSemicolonMonthsRows = [
  {
    conid: '466221142',
    symbol: 'MES',
    description: 'CME',
    sections: [{ secType: 'FUT', exchange: 'CME', months: 'SEP26;DEC26;MAR27' }],
  },
]

/**
 * The REAL POST /iserver/secdef/search body for `symbol=MES`, captured from the
 * user's live Client Portal Gateway.
 *
 * Its FUT section lists `SEP26;DEC26;MAR27;JUN27;SEP27` - SEMICOLON separated,
 * on CME, and with NO December 2025. That absence is the user-visible failure:
 * the listing dropdown offered `MESZ25` ten months after that contract expired,
 * and every market request for it died on a message that named neither IBKR's
 * list nor the reason.
 *
 * The two rows below the first share the symbol `MES` (a Mitsubishi stock and a
 * bond) and carry no FUT section, which is what makes the first row's FUT
 * section the only one. Their identifiers were not captured because no
 * assertion here depends on them; they are reproduced only as far as the
 * ground truth states.
 */
const mesLiveSearchRows = [
  {
    conid: '362673777',
    companyHeader: 'Micro E-Mini S&P 500 Stock Price Index - CME',
    symbol: 'MES',
    description: 'CME',
    restricted: 'IND',
    sections: [
      { secType: 'IND', exchange: 'CME;' },
      {
        secType: 'FUT',
        months: 'SEP26;DEC26;MAR27;JUN27;SEP27',
        exchange: 'CME',
        showPrips: true,
      },
      { secType: 'FOP', months: 'SEP26;OCT26;NOV26;DEC26', exchange: 'CME', showPrips: true },
      { secType: 'BAG', exchange: 'CME', legSecType: 'FUT' },
      { secType: 'BAG', exchange: 'CME', legSecType: 'FOP' },
    ],
  },
  { symbol: 'MES', description: 'TSE', sections: [{ secType: 'STK' }] },
  { symbol: null, sections: [{ secType: 'BOND' }] },
]

/**
 * The REAL
 * GET /iserver/secdef/info?conid=362673777&sectype=FUT&month=DEC26&exchange=CME
 * body, captured from the same gateway: a BARE ARRAY of ONE contract, carrying
 * the contract's OWN conid (not the underlying's), its maturity and multiplier.
 */
const mesLiveDec26InfoRows = [
  {
    conid: 815824257,
    symbol: 'MES',
    secType: 'FUT',
    exchange: 'CME',
    listingExchange: 'CME',
    currency: 'USD',
    desc1: "Dec18'26(5)",
    desc2: null,
    maturityDate: '20261218',
    multiplier: '5',
    tradingClass: 'MES',
    validExchanges: 'CME',
    showPrips: true,
    right: '?',
    strike: 0.0,
    coupon: 'No Coupon',
    cusip: null,
  },
]

/**
 * GET /iserver/secdef/info for one contract month: a BARE ARRAY of contracts.
 * A neighbouring root can come back in the same answer, and one month can be
 * listed on several venues, so the pick has to be deterministic rather than
 * "the first row in the array".
 */
const mesDec25InfoRows = [
  { conid: '111111111', symbol: 'ES', secType: 'FUT', exchange: 'CME' },
  { conid: '495492861', symbol: 'MES', secType: 'FUT', exchange: 'SMART' },
  { conid: '495492863', symbol: 'MES', secType: 'FUT', exchange: 'CME' },
]

/**
 * Answer both secdef endpoints from one mock: the search rows for
 * /iserver/secdef/search, and `infoByMonth[<month>]` for the
 * /iserver/secdef/info hop. Keying the info answer on the `month` parameter is
 * also how a test proves a section's `months` list was parsed into the
 * individual month that was requested.
 */
const mockSecDefByMonth = (search: unknown, infoByMonth: Record<string, unknown>): void => {
  vi.mocked(fetchBrokerJson).mockImplementation(
    async ({ url }: { url: string }): Promise<never> => {
      if (url.includes('/iserver/secdef/info')) {
        const month = /month=([A-Z]{3}\d{2})/.exec(url)?.[1] ?? ''
        return (infoByMonth[month] ?? []) as never
      }
      return search as never
    }
  )
}

const secDefInfoUrls = (): string[] =>
  vi
    .mocked(fetchBrokerJson)
    .mock.calls.map((call) => call[0]?.url ?? '')
    .filter((url) => url.includes('/iserver/secdef/info'))

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

  it('keys a contract-month symbol as the root it resolves to plus that month', () => {
    // `MESZ25` and `MES` with the December contract are one listing, so they
    // have to build one key: the synchronous order path only ever sees the
    // symbol (see resolveIbkrConid), and it must find what the async lookup
    // wrote. The root on its own stays its own entry.
    expect(buildIbkrConidCacheKey('mesz25', 'future')).toBe('FUT:MES:-:-:DEC25')
    expect(buildIbkrConidCacheKey('MESZ25', 'future')).toBe(
      buildIbkrConidCacheKey('MES', 'future', { expiry: 'DEC25' })
    )
    expect(buildIbkrConidCacheKey('MESZ25', 'future')).not.toBe(
      buildIbkrConidCacheKey('MES', 'future')
    )
    // Two contract months of one root are still two entries.
    expect(buildIbkrConidCacheKey('MESZ25', 'future')).not.toBe(
      buildIbkrConidCacheKey('MESZ26', 'future')
    )
    // A month the caller states explicitly wins over the one the symbol
    // carries, on the write and on the read alike.
    expect(buildIbkrConidCacheKey('MESZ25', 'future', { expiry: 'SEP26' })).toBe(
      'FUT:MES:-:-:SEP26'
    )
    // A catalogue marker keeps the entry it has always had (see #15).
    expect(buildIbkrConidCacheKey('FMESZ25', 'future')).toBe('FUT:FMES:-:-:DEC25')
    // Nothing is derived for a non-futures listing, whatever the symbol ends in.
    expect(buildIbkrConidCacheKey('MESZ25', 'stock')).toBe('STK:MESZ25:-:-:-')
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

describe('parseIbkrFuturesContractMonth', () => {
  // Pinned: a one-digit year is expanded against the decade the catalogue is
  // in, so the clock is part of the answer.
  const now = new Date('2026-09-13T00:00:00Z')

  it('reads the trailing contract month of a catalogue futures symbol', () => {
    // What the live dropdown supplied for a December 2025 Micro E-mini S&P.
    expect(parseIbkrFuturesContractMonth('MESZ25', 'future', now)).toEqual({
      root: 'MES',
      expiry: 'DEC25',
    })
    expect(parseIbkrFuturesContractMonth('ESZ5', 'future', now)).toEqual({
      root: 'ES',
      expiry: 'DEC25',
    })
    // A four-digit year is the same month; three digits are not a year.
    expect(parseIbkrFuturesContractMonth('MESZ2025', 'future', now)).toEqual({
      root: 'MES',
      expiry: 'DEC25',
    })
    expect(parseIbkrFuturesContractMonth('MESZ025', 'future', now)).toBeNull()
  })

  it('maps every futures month code to the month IBKR lists', () => {
    const months: Record<string, string> = {
      F: 'JAN',
      G: 'FEB',
      H: 'MAR',
      J: 'APR',
      K: 'MAY',
      M: 'JUN',
      N: 'JUL',
      Q: 'AUG',
      U: 'SEP',
      V: 'OCT',
      X: 'NOV',
      Z: 'DEC',
    }
    for (const [code, month] of Object.entries(months)) {
      expect(parseIbkrFuturesContractMonth(`MES${code}26`, 'future', now)?.expiry).toBe(
        `${month}26`
      )
    }
  })

  it('expands a one-digit year against the decade the catalogue is in', () => {
    // Futures symbols truncate the year (`ESZ5`), so `5` is 2025 in the 2020s
    // and `8` is 2028. A digit below the current year's last digit therefore
    // reads as the current decade, which is the one ambiguity left.
    expect(parseIbkrFuturesContractMonth('MESZ5', 'future', now)?.expiry).toBe('DEC25')
    expect(parseIbkrFuturesContractMonth('MESZ8', 'future', now)?.expiry).toBe('DEC28')
  })

  it('leaves a root, a marked symbol and a non-month code alone', () => {
    expect(parseIbkrFuturesContractMonth('MES', 'future', now)).toBeNull()
    expect(parseIbkrFuturesContractMonth('FMES', 'future', now)).toBeNull()
    // `Y` is not a futures month code, so `MESY25` is not a contract month.
    expect(parseIbkrFuturesContractMonth('MESY25', 'future', now)).toBeNull()
    // A month code with no root in front of it is not a contract month either.
    expect(parseIbkrFuturesContractMonth('Z25', 'future', now)).toBeNull()
  })

  it('keeps the catalogue marker in front of the root', () => {
    // The month is a suffix and the marker a prefix, so one cannot hide the
    // other: strip the month, and the existing marker handling still applies.
    expect(parseIbkrFuturesContractMonth('FMESZ25', 'future', now)).toEqual({
      root: 'FMES',
      expiry: 'DEC25',
    })
    expect(parseIbkrFuturesContractMonth('F*MESZ25', 'future', now)).toEqual({
      root: 'F*MES',
      expiry: 'DEC25',
    })
  })

  it('never parses a contract month out of a non-futures symbol', () => {
    // Stripping is only safe where a FUT lookup was asked for; elsewhere the
    // trailing characters are part of the ticker.
    expect(parseIbkrFuturesContractMonth('MESZ25', 'stock', now)).toBeNull()
    expect(parseIbkrFuturesContractMonth('MESZ25', undefined, now)).toBeNull()
    expect(parseIbkrFuturesContractMonth('MESZ25', 'etf', now)).toBeNull()
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

  it('searches the root of a contract-month symbol, not the contract symbol', () => {
    // The live failure asked secdef/search for `MESZ25`, which matches no
    // section; the endpoint only knows the root, and the section's `months`
    // is what selects the contract. The contract symbol itself is deliberately
    // not tried: it resolves to nothing and would only cost a request.
    expect(ibkrSymbolCandidates('MESZ25', 'future')).toEqual(['MES'])
    expect(ibkrSymbolCandidates('ESZ5', 'future')).toEqual(['ES'])
  })

  it('handles a symbol that carries both a marker and a month', () => {
    // Suffix first: the month comes off, and the marked form that is left goes
    // through the existing marker handling unchanged.
    expect(ibkrSymbolCandidates('FMESZ25', 'future')).toEqual(['FMES', 'MES'])
    expect(ibkrSymbolCandidates('F*MESZ25', 'future')).toEqual(['F*MES', 'MES'])
  })

  it('leaves a non-futures symbol that ends in a month code alone', () => {
    expect(ibkrSymbolCandidates('MESZ25', 'stock')).toEqual(['MESZ25'])
    expect(ibkrSymbolCandidates('MESZ25', undefined)).toEqual(['MESZ25'])
    expect(ibkrSymbolCandidates('MESY25', 'future')).toEqual(['MESY25'])
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
    // Neither section names an exchange, so the hop has to use the documented
    // SMART default - and say so.
    mockSecDefByMonth(mesFutureRows, {
      SEP26: [{ conid: '495492861', symbol: 'MES', secType: 'FUT', exchange: 'SMART' }],
      DEC26: [{ conid: '495492862', symbol: 'MES', secType: 'FUT', exchange: 'SMART' }],
    })

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

    expect(september.conid).toBe(495492861)
    expect(december.conid).toBe(495492862)
    // Two hops: one per contract month, each for that month's own conid.
    expect(secDefInfoUrls()).toHaveLength(2)
    expect(secDefInfoUrls()[0]).toContain('exchange=SMART')
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

  it('searches the root symbol, then hops to the contract month the listing offers', async () => {
    // The live failure, in one test: the dropdown supplied `MESZ25`, the old
    // code sent `symbol=MESZ25` verbatim, secdef/search matched nothing and
    // every market request for a December 2025 contract failed. The request has
    // to go out for the ROOT, and the section's `months` picks the month - whose
    // conid is a SECOND question the search cannot answer.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    mockSecDefByMonth(mesContractMonthRows, { DEC25: mesDec25InfoRows })

    const resolution = await resolveIbkrConidFromApi({
      symbol: 'MESZ25',
      assetClass: 'future',
      context: { marketCode: 'XCME', currency: 'USD' },
    })

    const searchUrl = vi.mocked(fetchBrokerJson).mock.calls[0]?.[0]?.url ?? ''
    expect(searchUrl).toContain('symbol=MES')
    expect(searchUrl).toContain('secType=FUT')
    expect(searchUrl).not.toContain('MESZ25')
    // DEC25 is the SECOND month in its row's list, and the row that carries it
    // is not the first row the search returned.
    expect(resolution).toEqual({ conid: 495492863, conidSpec: 'FUT' })
    expect(secDefInfoUrls()).toHaveLength(1)
  })

  it('parses a SEMICOLON-separated months list into individual contract months', async () => {
    // IBKR documents a section's months as "MMMYY format separated by
    // semicolon", so `SEP26;DEC26;MAR27` is three months. Splitting on a comma
    // kept the whole list one token, so nothing matched and the lookup failed.
    // The months at the END of the list are the ones a comma split could never
    // reach, so they are what proves the list was parsed at all.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    mockSecDefByMonth(mesSemicolonMonthsRows, {
      DEC26: [{ conid: '606060600', symbol: 'MES', secType: 'FUT', exchange: 'CME' }],
      MAR27: [{ conid: '707070700', symbol: 'MES', secType: 'FUT', exchange: 'CME' }],
    })

    const december = await resolveIbkrConidFromApi({
      symbol: 'MESZ26',
      assetClass: 'future',
      context: { marketCode: 'XCME', currency: 'USD' },
    })
    const march = await resolveIbkrConidFromApi({
      symbol: 'MESH27',
      assetClass: 'future',
      context: { marketCode: 'XCME', currency: 'USD' },
    })

    expect(december).toEqual({ conid: 606060600, conidSpec: 'FUT' })
    expect(march).toEqual({ conid: 707070700, conidSpec: 'FUT' })
    expect(secDefInfoUrls().some((url) => url.includes('month=DEC26'))).toBe(true)
    expect(secDefInfoUrls().some((url) => url.includes('month=MAR27'))).toBe(true)
  })

  it('picks the requested contract month when the listing offers several', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    mockSecDefByMonth(mesContractMonthRows, {
      SEP26: [{ conid: '466221140', symbol: 'MES', secType: 'FUT', exchange: 'CME' }],
      DEC26: [{ conid: '606060600', symbol: 'MES', secType: 'FUT', exchange: 'CME' }],
    })

    const december26 = await resolveIbkrConidFromApi({
      symbol: 'MESZ26',
      assetClass: 'future',
      context: { marketCode: 'XCME', currency: 'USD' },
    })
    const september26 = await resolveIbkrConidFromApi({
      symbol: 'MESU26',
      assetClass: 'future',
      context: { marketCode: 'XCME', currency: 'USD' },
    })

    // DEC26 is the third row; SEP26 the first. Neither may fall back to
    // "whichever row came back first", and the month that reaches the hop has
    // to be the one the symbol named.
    expect(december26.conid).toBe(606060600)
    expect(september26.conid).toBe(466221140)
    expect(secDefInfoUrls().some((url) => url.includes('month=DEC26'))).toBe(true)
    expect(secDefInfoUrls().some((url) => url.includes('month=SEP26'))).toBe(true)
  })

  it('resolves a requested month through the hop and picks its contract deterministically', async () => {
    // The search row's conid is the UNDERLYING contract, and a section's months
    // only LISTS that an expiry exists - neither is the month's own contract
    // identifier. `/iserver/secdef/info` is the hop that returns it, and one
    // month can answer with several contracts, so the pick is by symbol/secType
    // and then by the venue the section listed the month on.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    mockSecDefByMonth(mesContractMonthRows, { DEC25: mesDec25InfoRows })

    const resolution = await resolveIbkrConidFromApi({
      symbol: 'MESZ25',
      assetClass: 'future',
      context: { marketCode: 'XCME', currency: 'USD' },
    })

    // Not the ES row (wrong root, first in the array) and not the SMART MES row
    // (first MES match): the section listed DEC25 on CME.
    expect(resolution).toEqual({ conid: 495492863, conidSpec: 'FUT' })

    const [infoUrl] = secDefInfoUrls()
    expect(infoUrl).toContain('conid=515151515')
    expect(infoUrl).toContain('sectype=FUT')
    expect(infoUrl).toContain('month=DEC25')
    expect(infoUrl).toContain('exchange=CME')
  })

  it('keeps the root symbol resolvable for callers that pass only the root', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    mockSecDefByMonth(mesContractMonthRows, { DEC25: mesDec25InfoRows })

    const resolution = await resolveIbkrConidFromApi({
      symbol: 'MES',
      assetClass: 'future',
      context: { marketCode: 'XCME', currency: 'USD' },
    })

    // No contract month requested, so no expiry filter and NO extra hop: the
    // first row offering a FUT section, exactly as before.
    expect(resolution).toEqual({ conid: 466221142, conidSpec: 'FUT' })
    expect(secDefInfoUrls()).toEqual([])
    expect(fetchBrokerJson).toHaveBeenCalledTimes(1)
  })

  it('fails on a contract month the listing does not offer instead of taking the first section', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    mockSecDefByMonth(mesContractMonthRows, { DEC25: mesDec25InfoRows })

    await expect(
      resolveIbkrConidFromApi({
        symbol: 'MESZ99',
        assetClass: 'future',
        context: { marketCode: 'XCME', currency: 'USD' },
        now: new Date('2026-09-15T00:00:00Z'),
      })
    ).rejects.toThrow(
      'MESZ99 is not a contract month IBKR offers for MES. ' +
        'Available: SEP26, DEC25, MAR26, DEC26.'
    )
    // No section offers DEC99, so there is no contract to look up: the hop is
    // never attempted and the first FUT section is not accepted instead.
    expect(secDefInfoUrls()).toEqual([])
  })

  it('names the contract months IBKR offers, in IBKR order, when the requested one is absent', async () => {
    // The user-visible failure, against the REAL gateway payload. The earlier
    // stages are right and stay: the ROOT `MES` is what secdef/search is asked
    // for (#27) and `Z25` is read off the symbol as `DEC25`. What failed is that
    // IBKR's FUT section offers no December 2025, and the message said only
    // "Unable to resolve IBKR contract identifier for symbol MESZ25" - no list,
    // no reason, nothing an operator could act on.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    mockSecDefByMonth(mesLiveSearchRows, { DEC26: mesLiveDec26InfoRows })

    const error = (await resolveIbkrConidFromApi({
      symbol: 'MESZ25',
      assetClass: 'future',
      context: { marketCode: 'XCME', currency: 'USD' },
      now: new Date('2026-09-15T00:00:00Z'),
    }).catch((thrown: Error) => thrown)) as Error

    expect(error.message).toBe(
      'MESZ25 is not a contract month IBKR offers for MES. ' +
        'Available: SEP26, DEC26, MAR27, JUN27, SEP27. ' +
        'December 2025 is in the past - the contract has expired.'
    )
    // One sentence, not a payload: nothing IBKR sent is quoted back beyond the
    // months themselves, so no search row, conid or JSON punctuation leaks.
    expect(error.message).not.toMatch(/[{}[\]"]/)
    expect(error.message).not.toContain('362673777')
    expect(error.message).not.toContain('conid')

    // The list is reported as IBKR sent it, and a month IBKR does not list is
    // never looked up: the hop does not run.
    expect(secDefInfoUrls()).toEqual([])
    expect(vi.mocked(fetchBrokerJson).mock.calls[0]?.[0]?.url ?? '').toContain('symbol=MES')
  })

  it('converts the month code to a calendar month, and says expired only for a month in the past', async () => {
    // `Z25` is a code an operator has to look up; `December 2025` is not. The
    // SAME code path has to tell the two kinds of absence apart, because the
    // operator's next move is different: an expired contract means the listing
    // is stale, while an unlisted future month means the request is wrong.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    mockSecDefByMonth(mesLiveSearchRows, { DEC26: mesLiveDec26InfoRows })
    const now = new Date('2026-09-15T00:00:00Z')
    const context = { marketCode: 'XCME', currency: 'USD' }

    // Z25 -> December 2025, ten months behind the clock.
    await expect(
      resolveIbkrConidFromApi({ symbol: 'MESZ25', assetClass: 'future', context, now })
    ).rejects.toThrow(
      'MESZ25 is not a contract month IBKR offers for MES. ' +
        'Available: SEP26, DEC26, MAR27, JUN27, SEP27. ' +
        'December 2025 is in the past - the contract has expired.'
    )

    // Q27 -> August 2027 is still AHEAD of the clock and equally absent from
    // the list, so it must not be called expired.
    await expect(
      resolveIbkrConidFromApi({ symbol: 'MESQ27', assetClass: 'future', context, now })
    ).rejects.toThrow(
      'MESQ27 is not a contract month IBKR offers for MES. ' +
        'Available: SEP26, DEC26, MAR27, JUN27, SEP27. ' +
        'August 2027 has not expired - IBKR does not offer that contract month.'
    )
  })

  it('still resolves a contract month IBKR does offer, through the hop to its own conid', async () => {
    // DEC26 IS in the live section, so nothing about this path changed: the
    // request goes out for the ROOT, the section's `months` picks the month, and
    // /iserver/secdef/info answers with the contract's OWN conid (815824257),
    // not the underlying's (362673777).
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    mockSecDefByMonth(mesLiveSearchRows, { DEC26: mesLiveDec26InfoRows })

    const resolution = await resolveIbkrConidFromApi({
      symbol: 'MESZ26',
      assetClass: 'future',
      context: { marketCode: 'XCME', currency: 'USD' },
      now: new Date('2026-09-15T00:00:00Z'),
    })

    expect(resolution).toEqual({ conid: 815824257, conidSpec: 'FUT' })
    expect(vi.mocked(fetchBrokerJson).mock.calls[0]?.[0]?.url ?? '').toContain('symbol=MES')
    const [infoUrl] = secDefInfoUrls()
    expect(infoUrl).toContain('conid=362673777')
    expect(infoUrl).toContain('sectype=FUT')
    expect(infoUrl).toContain('month=DEC26')
    expect(infoUrl).toContain('exchange=CME')
  })

  it('leaves a root-only lookup untouched: no month, no list, no hop', async () => {
    // The row's own conid IS the answer when no contract month was requested,
    // exactly as before - and there is nothing for the new message to describe,
    // because nothing was asked of it.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    mockSecDefByMonth(mesLiveSearchRows, { DEC26: mesLiveDec26InfoRows })

    const resolution = await resolveIbkrConidFromApi({
      symbol: 'MES',
      assetClass: 'future',
      context: { marketCode: 'XCME', currency: 'USD' },
      now: new Date('2026-09-15T00:00:00Z'),
    })

    expect(resolution).toEqual({ conid: 362673777, conidSpec: 'FUT' })
    expect(secDefInfoUrls()).toEqual([])
    expect(fetchBrokerJson).toHaveBeenCalledTimes(1)
  })

  it('still resolves the marked futures forms from #15, with no contract month and no hop', async () => {
    // `FMES` / `F*MES` carry no contract month, so the marker handling is the
    // whole story and the search row's own conid is the answer.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockImplementation(
      async ({ url }: { url: string }): Promise<never> => {
        const searchSymbol = decodeURIComponent(/symbol=([^&]+)/.exec(url)?.[1] ?? '')
        if (searchSymbol !== 'MES') {
          return [] as never
        }
        return [
          {
            conid: '466221142',
            symbol: 'MES',
            description: 'CME',
            sections: [{ secType: 'FUT', exchange: 'CME' }],
          },
        ] as never
      }
    )

    const bareMarker = await resolveIbkrConidFromApi({
      symbol: 'FMES',
      assetClass: 'future',
      context: { marketCode: 'XCME', currency: 'USD' },
    })
    const starMarker = await resolveIbkrConidFromApi({
      symbol: 'F*MES',
      assetClass: 'future',
      context: { marketCode: 'XCME', currency: 'USD' },
    })

    expect(bareMarker).toEqual({ conid: 466221142, conidSpec: 'FUT' })
    expect(starMarker).toEqual({ conid: 466221142, conidSpec: 'FUT' })
    expect(secDefInfoUrls()).toEqual([])
  })

  it('keeps the #15 marker in front of the contract-month hop', async () => {
    // The two earlier stages still apply: the trailing month comes off first
    // (#27), and what is left resolves through the marker candidates (#15) - the
    // root it finally searches is what the hop is asked about.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockImplementation(
      async ({ url }: { url: string }): Promise<never> => {
        if (url.includes('/iserver/secdef/info')) {
          return [{ conid: '495492863', symbol: 'MES', secType: 'FUT', exchange: 'CME' }] as never
        }
        const searchSymbol = decodeURIComponent(/symbol=([^&]+)/.exec(url)?.[1] ?? '')
        if (searchSymbol !== 'MES') {
          return [] as never
        }
        return [
          {
            conid: '466221142',
            symbol: 'MES',
            description: 'CME',
            sections: [{ secType: 'FUT', exchange: 'CME', months: 'DEC25' }],
          },
        ] as never
      }
    )

    const resolution = await resolveIbkrConidFromApi({
      symbol: 'F*MESZ25',
      assetClass: 'future',
      context: { marketCode: 'XCME', currency: 'USD' },
    })

    expect(resolution).toEqual({ conid: 495492863, conidSpec: 'FUT' })
    expect(secDefInfoUrls()[0]).toContain('month=DEC25')
  })

  it('does not read a contract month out of a code that is not one', async () => {
    // `Y` is not a month code, so `MESY25` is searched verbatim - and the
    // endpoint has nothing by that name. Silently resolving it to the root's
    // first contract would trade the wrong instrument.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    vi.mocked(fetchBrokerJson).mockImplementation(
      async ({ url }: { url: string }) =>
        (url.includes('symbol=MESY25') ? [] : mesContractMonthRows) as never
    )

    await expect(
      resolveIbkrConidFromApi({
        symbol: 'MESY25',
        assetClass: 'future',
        context: { marketCode: 'XCME', currency: 'USD' },
      })
    ).rejects.toThrow('Unable to resolve IBKR contract identifier for symbol MESY25')
    expect(vi.mocked(fetchBrokerJson).mock.calls[0]?.[0]?.url ?? '').toContain('symbol=MESY25')
  })

  it('lets the synchronous order-path read find what a contract-month lookup wrote', async () => {
    // The order pipeline reads the conid SYNCHRONOUSLY and can only pass the
    // symbol and the listing context it derives from the order params - never
    // an expiry (see resolveIbkrOrderListingContext). That is enough here: the
    // seed key is built from the catalogue symbol, whose trailing contract month
    // supplies the month dimension, so the write and the read land on ONE key -
    // `FUT:MES:XCME:USD:DEC25` - even though the month resolved through the hop.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    mockSecDefByMonth(mesContractMonthRows, { DEC25: mesDec25InfoRows })
    const context = { marketCode: 'XCME', currency: 'USD' }

    await resolveIbkrConidFromApi({ symbol: 'MESZ25', assetClass: 'future', context })
    const cached = resolveIbkrConid({ symbol: 'MESZ25', assetClass: 'future', context })

    expect(buildIbkrConidCacheKey('MESZ25', 'future', context)).toBe('FUT:MES:XCME:USD:DEC25')
    expect(cached).toEqual({ conid: 495492863, conidSpec: 'FUT' })
    expect(fetchBrokerJson).toHaveBeenCalledTimes(2)
  })

  it('does not let a root-only lookup answer for a contract-month key', async () => {
    // The one mismatch the order path cannot close by itself: it derives no
    // expiry, so a lookup that only ever saw the ROOT is keyed `FUT:MES:...:-`
    // and cannot serve the DEC25 entry. That entry is reachable from the
    // catalogue symbol alone - which is what the market listing supplies.
    vi.stubEnv('IBKR_API_BASE_URL', 'http://host.containers.internal:5002/v1/api')
    mockSecDefByMonth(mesContractMonthRows, { DEC25: mesDec25InfoRows })
    const context = { marketCode: 'XCME', currency: 'USD' }

    const rootOnly = await resolveIbkrConidFromApi({
      symbol: 'MES',
      assetClass: 'future',
      context,
    })

    expect(rootOnly).toEqual({ conid: 466221142, conidSpec: 'FUT' })
    expect(buildIbkrConidCacheKey('MES', 'future', context)).not.toBe(
      buildIbkrConidCacheKey('MESZ25', 'future', context)
    )
    expect(() => resolveIbkrConid({ symbol: 'MESZ25', assetClass: 'future', context })).toThrow(
      'contract identifier not resolved'
    )
  })

  it('requires an access token only against the hosted API', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'https://api.ibkr.com/v1/api')

    await expect(resolveIbkrConidFromApi({ symbol: 'AAPL', assetClass: 'stock' })).rejects.toThrow(
      'hosted API requires an access token'
    )

    expect(fetchBrokerJson).not.toHaveBeenCalled()
  })
})
