import { AreaChartIcon } from '@/components/icons/icons'
import { LISTING_IDENTITY_VALUE_TYPE } from '@/lib/listing/identity'
import type { BlockConfig } from '@/blocks/types'
import { AuthMode } from '@/blocks/types'
import type { OptionsChainResponse } from '@/tools/market_data/options'

/** A stored short-input value as a positive number, or undefined; never throws. */
const toPositiveNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export const OptionsChainBlock: BlockConfig<OptionsChainResponse> = {
  type: 'options_chain',
  name: 'Options Chain',
  description: 'Fetch an IBKR option chain with quotes, implied volatility and Greeks.',
  longDescription:
    'Load the option chain for a futures contract (options on futures, such as MES or ES at CME), stock, ETF or index from the IBKR gateway. Returns the strikes around the money with call and put bid/ask, implied volatility, delta, gamma, theta, vega and open interest, plus the at-the-money straddle price and the move it implies by expiry. Read-only: it never places orders.',
  category: 'tools',
  authMode: AuthMode.ApiKey,
  bgColor: '#0F766E',
  icon: AreaChartIcon,
  subBlocks: [
    {
      id: 'provider',
      title: 'Data Provider',
      type: 'dropdown',
      layout: 'full',
      options: [{ label: 'IBKR', id: 'ibkr' }],
      value: () => 'ibkr',
      required: true,
    },
    {
      id: 'listing',
      title: 'Underlying',
      type: 'market-selector',
      layout: 'full',
      required: true,
      dependsOn: ['provider'],
      description:
        'A futures contract (e.g. MESZ26 on CME), stock, ETF or index. You can also reference a Historical Data block’s listing.',
    },
    {
      id: 'expiry',
      title: 'Expiry',
      type: 'short-input',
      layout: 'half',
      required: false,
      placeholder: 'Nearest, or 20261016 / OCT26',
    },
    {
      id: 'strikesPerSide',
      title: 'Strikes per Side',
      type: 'short-input',
      layout: 'half',
      inputType: 'number',
      required: false,
      placeholder: '5',
      min: 1,
      max: 20,
      integer: true,
    },
    {
      id: 'underlyingPrice',
      title: 'Underlying Price',
      type: 'short-input',
      layout: 'full',
      inputType: 'number',
      required: false,
      placeholder: 'Optional; the live IBKR price when empty',
    },
  ],
  tools: {
    access: ['options_chain_fetch'],
    config: {
      tool: () => 'options_chain_fetch',
      params: (params) => {
        const expiry = typeof params.expiry === 'string' ? params.expiry.trim() : ''
        const strikesPerSide = toPositiveNumber(params.strikesPerSide)
        return {
          listing: params.listing,
          expiry: expiry || undefined,
          strikesPerSide: strikesPerSide === undefined ? undefined : Math.floor(strikesPerSide),
          underlyingPrice: toPositiveNumber(params.underlyingPrice),
        }
      },
    },
  },
  inputs: {
    listing: { type: LISTING_IDENTITY_VALUE_TYPE, description: 'Underlying listing identity.' },
    expiry: { type: 'string', description: 'Expiry as YYYYMMDD or an option month (OCT26).' },
    strikesPerSide: { type: 'number', description: 'Strikes on each side of the money (1-20).' },
    underlyingPrice: { type: 'number', description: 'Optional underlying price.' },
  },
  outputs: {
    underlying: { type: 'json', description: 'Underlying symbol, exchange and price used.' },
    expiry: { type: 'string', description: 'Expiry of the returned contracts (YYYYMMDD).' },
    expirations: { type: 'json', description: 'Expiries in the loaded option month.' },
    months: { type: 'json', description: 'Option months IBKR lists for the underlying.' },
    rows: { type: 'json', description: 'Strikes with call and put quotes, IV and Greeks.' },
    summary: {
      type: 'json',
      description:
        'ATM strike, straddle price, implied move (points and %), ATM IV, put/call open interest ratio, days to expiry.',
    },
    marketDataAvailability: {
      type: 'string',
      description: 'IBKR market data code: R real time, D delayed, Z frozen, N not subscribed.',
    },
  },
}
