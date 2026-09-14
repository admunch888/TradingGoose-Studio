import type { IbkrOptionChain } from '@/providers/market/ibkr/options'
import type { ToolConfig, ToolResponse } from '@/tools/types'

export interface OptionsChainParams {
  listing?: unknown
  expiry?: string
  strikesPerSide?: number
  underlyingPrice?: number
}

export interface OptionsChainResponse extends ToolResponse {
  output: IbkrOptionChain
}

export const optionsChainTool: ToolConfig<OptionsChainParams, OptionsChainResponse> = {
  id: 'options_chain_fetch',
  name: 'Options Chain',
  description:
    'Fetch an IBKR option chain for an underlying: strikes around the money with call and put quotes, implied volatility, Greeks and open interest, plus the ATM straddle and implied move.',
  version: '1.0.0',
  params: {
    listing: {
      type: 'json',
      required: true,
      visibility: 'user-or-llm',
      description:
        'Underlying listing identity: a futures contract (options on futures, e.g. MESZ26 on CME), stock, ETF or index.',
    },
    expiry: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Expiry as YYYYMMDD or an option month such as OCT26. Nearest expiry when empty.',
    },
    strikesPerSide: {
      type: 'number',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Strikes to include on each side of the at-the-money strike, 1 to 20 (default 5).',
    },
    underlyingPrice: {
      type: 'number',
      required: false,
      visibility: 'user-or-llm',
      description: 'Underlying price to centre the chain on. The live IBKR price when empty.',
    },
  },
  request: {
    url: '/api/providers/market/ibkr/options-chain',
    method: 'POST',
    headers: () => ({ 'Content-Type': 'application/json' }),
    body: (params) => ({
      listing: params.listing,
      expiry: params.expiry,
      strikesPerSide: params.strikesPerSide,
      underlyingPrice: params.underlyingPrice,
    }),
  },
  transformResponse: async (response) => ({
    success: true,
    output: (await response.json()) as IbkrOptionChain,
  }),
  outputs: {
    underlying: { type: 'json', description: 'Underlying symbol, exchange and price used.' },
    secType: { type: 'string', description: 'FOP for options on futures, OPT otherwise.' },
    month: { type: 'string', description: 'Option month loaded (e.g. OCT26).' },
    months: { type: 'json', description: 'Option months IBKR lists for the underlying.' },
    expiry: { type: 'string', description: 'Expiry of the returned contracts (YYYYMMDD).' },
    expirations: { type: 'json', description: 'Expiries in the loaded month (YYYYMMDD).' },
    rows: {
      type: 'json',
      description:
        'Strikes, each with call and put quotes: bid, ask, mid, mark, last, volume, openInterest, impliedVolatility (%), delta, gamma, theta, vega.',
    },
    summary: {
      type: 'json',
      description:
        'atmStrike, straddlePrice, impliedMove, impliedMovePct, atmImpliedVolatility, putCallOpenInterestRatio, daysToExpiry.',
    },
    marketDataAvailability: {
      type: 'string',
      description: 'IBKR market data code: R real time, D delayed, Z frozen, N not subscribed.',
    },
    asOf: { type: 'string', description: 'When the chain was fetched (ISO).' },
  },
}
