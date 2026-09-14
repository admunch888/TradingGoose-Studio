/**
 * @vitest-environment node
 */
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkAuth: vi.fn(),
  isHosted: vi.fn(),
  fetchChain: vi.fn(),
  resolveContext: vi.fn(),
}))

vi.mock('@/lib/auth/hybrid', () => ({
  checkSessionOrInternalAuth: (...args: unknown[]) => mocks.checkAuth(...args),
}))

vi.mock('@/providers/trading/ibkr/auth', () => ({
  isIbkrHostedApi: () => mocks.isHosted(),
}))

vi.mock('@/providers/market/ibkr/options', () => ({
  MAX_STRIKES_PER_SIDE: 20,
  fetchIbkrOptionChain: (...args: unknown[]) => mocks.fetchChain(...args),
}))

vi.mock('@/providers/market/utils', () => ({
  resolveListingContext: (...args: unknown[]) => mocks.resolveContext(...args),
  resolveProviderSymbol: (_config: unknown, context: { base: string }) => context.base,
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}))

import {
  IBKR_HOSTED_OPTIONS_UNSUPPORTED_MESSAGE,
  POST,
} from '@/app/api/providers/market/ibkr/options-chain/route'

const mesListing = {
  listing_id: 'MESZ26',
  base_id: '',
  quote_id: '',
  listing_type: 'default',
  manual: { assetClass: 'future', marketCode: 'CME' },
}

const request = (body: unknown) =>
  new NextRequest('http://localhost/api/providers/market/ibkr/options-chain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /api/providers/market/ibkr/options-chain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.checkAuth.mockResolvedValue({ success: true, userId: 'user-1' })
    mocks.isHosted.mockReturnValue(false)
    mocks.resolveContext.mockResolvedValue({
      listing: mesListing,
      base: 'MESZ26',
      assetClass: 'future',
      marketCode: 'CME',
    })
    mocks.fetchChain.mockResolvedValue({ expiry: '20260918', rows: [] })
  })

  it('rejects an unauthenticated request', async () => {
    mocks.checkAuth.mockResolvedValue({ success: false, error: 'Unauthorized' })

    expect((await POST(request({ listing: mesListing }))).status).toBe(401)
    expect(mocks.fetchChain).not.toHaveBeenCalled()
  })

  it('fetches the chain for the listing, coercing stored string inputs', async () => {
    const response = await POST(
      request({
        listing: JSON.stringify(mesListing),
        expiry: ' 20260918 ',
        strikesPerSide: '8',
        underlyingPrice: '',
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ expiry: '20260918', rows: [] })
    expect(mocks.fetchChain).toHaveBeenCalledWith({
      symbol: 'MESZ26',
      assetClass: 'future',
      marketCode: 'CME',
      currency: undefined,
      expiry: '20260918',
      strikesPerSide: 8,
      underlyingPrice: undefined,
    })
  })

  it('rejects out-of-range strikes and a missing listing', async () => {
    expect((await POST(request({ listing: mesListing, strikesPerSide: 50 }))).status).toBe(400)
    expect((await POST(request({ listing: '' }))).status).toBe(400)
    expect(mocks.fetchChain).not.toHaveBeenCalled()
  })

  it('needs the gateway, not the hosted API', async () => {
    mocks.isHosted.mockReturnValue(true)

    const response = await POST(request({ listing: mesListing }))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: IBKR_HOSTED_OPTIONS_UNSUPPORTED_MESSAGE })
  })

  it("reports IBKR's reason when the chain cannot be loaded", async () => {
    mocks.fetchChain.mockRejectedValue(new Error('NOV26 is not an option month IBKR offers'))

    const response = await POST(request({ listing: mesListing, expiry: 'NOV26' }))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'NOV26 is not an option month IBKR offers' })
  })
})
