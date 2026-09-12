import { describe, expect, it } from 'vitest'
import { getMarketProviderOptions, MARKET_PROVIDER_DEFINITIONS } from '@/providers/market/providers'

describe('market provider definitions', () => {
  it('exposes an icon for every provider so the selector never renders a bare row', () => {
    const withoutIcon = Object.values(MARKET_PROVIDER_DEFINITIONS)
      .filter((provider) => !provider.icon)
      .map((provider) => provider.id)

    expect(withoutIcon).toEqual([])
  })

  it('carries the IBKR icon through to the selector options', () => {
    const ibkr = getMarketProviderOptions().find((option) => option.id === 'ibkr')

    expect(ibkr?.name).toBe('IBKR')
    expect(ibkr?.icon).toBeTypeOf('function')
  })
})
