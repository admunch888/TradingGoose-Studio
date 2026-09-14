/**
 * @vitest-environment node
 */

import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetSession, mockIsIbkrHostedApi, mockSearchIbkrListings } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockIsIbkrHostedApi: vi.fn(),
  mockSearchIbkrListings: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}))

vi.mock('@/providers/trading/ibkr/auth', () => ({
  isIbkrHostedApi: () => mockIsIbkrHostedApi(),
}))

vi.mock('@/providers/market/ibkr/listing-search', () => ({
  searchIbkrListings: (...args: unknown[]) => mockSearchIbkrListings(...args),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}))

import {
  GET,
  IBKR_HOSTED_SEARCH_UNSUPPORTED_MESSAGE,
} from '@/app/api/providers/trading/ibkr/listing-search/route'

const request = (query: string) =>
  new NextRequest(`http://localhost/api/providers/trading/ibkr/listing-search?${query}`)

describe('GET /api/providers/trading/ibkr/listing-search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } })
    mockIsIbkrHostedApi.mockReturnValue(false)
  })

  it('rejects an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await GET(request('q=MES'))

    expect(response.status).toBe(401)
    expect(mockSearchIbkrListings).not.toHaveBeenCalled()
  })

  it('requires a symbol and a known asset class', async () => {
    expect((await GET(request('q='))).status).toBe(400)
    expect((await GET(request('q=MES&asset_class=spaceship'))).status).toBe(400)
    expect(mockSearchIbkrListings).not.toHaveBeenCalled()
  })

  it('points hosted API deployments at manual entry', async () => {
    mockIsIbkrHostedApi.mockReturnValue(true)

    const response = await GET(request('q=MES'))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: IBKR_HOSTED_SEARCH_UNSUPPORTED_MESSAGE })
    expect(mockSearchIbkrListings).not.toHaveBeenCalled()
  })

  it('returns the listings the gateway search built', async () => {
    const listing = { base: 'MESZ26' }
    mockSearchIbkrListings.mockResolvedValue([listing])

    const response = await GET(request('q=MES&asset_class=future'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [listing] })
    expect(mockSearchIbkrListings).toHaveBeenCalledWith({ query: 'MES', assetClass: 'future' })
  })

  it("reports the gateway's reason when the search fails", async () => {
    mockSearchIbkrListings.mockRejectedValue(new Error('Gateway session is not authenticated'))

    const response = await GET(request('q=MES'))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'Gateway session is not authenticated' })
  })
})
