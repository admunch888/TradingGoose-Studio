/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveTradingListingIdentity } from '@/providers/trading/listing-resolution'

describe('resolveTradingListingIdentity when the listing search is unreachable', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('answers "no match" instead of throwing on a refused connection', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(new Error('Unable to connect. Is the computer able to access the url?'))
    )

    await expect(
      resolveTradingListingIdentity({ base: 'MES', assetClass: 'future' })
    ).resolves.toBeNull()
  })

  it('keeps a listing supplied by identity without searching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const listing = {
      listing_id: 'MESZ26',
      base_id: '',
      quote_id: '',
      listing_type: 'default' as const,
      manual: { assetClass: 'future' as const, marketCode: 'CME' },
    }

    await expect(resolveTradingListingIdentity({ listing })).resolves.toEqual(listing)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still propagates an abort', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    )

    await expect(
      resolveTradingListingIdentity({ base: 'MES', assetClass: 'future' }, controller.signal)
    ).rejects.toThrow('aborted')
  })
})
