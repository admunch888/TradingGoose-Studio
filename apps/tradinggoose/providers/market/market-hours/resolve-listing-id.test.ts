/**
 * @vitest-environment node
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('./market-hours-api', () => ({
  resolveMarketHours: vi.fn(),
  resolveMarketHoursRange: vi.fn(),
}))

import { resolveMarketHoursRange } from './market-hours-api'
import { clampToMarketSession, resolveListingId } from './sessions'

const catalogueListing = {
  listing_id: 'TG_LSTG_AAPL',
  base_id: '',
  quote_id: '',
  listing_type: 'default' as const,
}

const manualListing = {
  listing_id: 'MESZ26',
  base_id: '',
  quote_id: '',
  listing_type: 'default' as const,
  manual: { assetClass: 'future' as const, marketCode: 'CME' },
}

describe('market hours for listings supplied by identity', () => {
  it('looks market hours up for catalogue listings only', () => {
    expect(resolveListingId(catalogueListing)).toBe('TG_LSTG_AAPL')
    expect(resolveListingId(manualListing)).toBeNull()
  })

  it('does not ask the catalogue to clamp a manual listing to its session', async () => {
    const request = {
      listing: manualListing,
      start: '2026-09-01T00:00:00Z',
      end: '2026-09-10T00:00:00Z',
      providerParams: { marketSession: 'regular' },
    }

    expect(await clampToMarketSession(request as never)).toBe(request)
    expect(resolveMarketHoursRange).not.toHaveBeenCalled()
  })
})
