/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockResolveTradingListingIdentity = vi.hoisted(() => vi.fn())

vi.mock('@/providers/trading/listing-resolution', () => ({
  resolveTradingListingIdentity: (...args: unknown[]) => mockResolveTradingListingIdentity(...args),
}))

import { buildPortfolioDetail } from '@/providers/trading/portfolio-detail'

const brokerIdentity = {
  listing_id: 'MESZ26',
  base_id: '',
  quote_id: '',
  listing_type: 'default' as const,
}

const build = () =>
  buildPortfolioDetail({
    identity: { providerId: 'ibkr', providerName: 'IBKR', serviceId: 'ibkr-paper' } as never,
    environment: 'paper' as never,
    asOf: '2026-09-14T18:34:07.469Z',
    cashBalances: [],
    positions: [{ symbol: 'MESZ26', quantity: 1, listingIdentity: brokerIdentity } as never],
    summary: {} as never,
  })

describe('buildPortfolioDetail', () => {
  beforeEach(() => {
    mockResolveTradingListingIdentity.mockReset()
  })

  it('uses the catalogue listing when the lookup finds one', async () => {
    const catalogue = { ...brokerIdentity, listing_id: 'TG_LSTG_1C3763' }
    mockResolveTradingListingIdentity.mockResolvedValue(catalogue)

    expect((await build()).positions[0]?.listingIdentity).toEqual(catalogue)
  })

  it("keeps the broker's identity instead of failing the snapshot when the lookup cannot connect", async () => {
    mockResolveTradingListingIdentity.mockRejectedValue(
      new Error('Unable to connect. Is the computer able to access the url?')
    )

    const detail = await build()

    expect(detail.positions).toHaveLength(1)
    expect(detail.positions[0]?.listingIdentity).toEqual(brokerIdentity)
  })
})
