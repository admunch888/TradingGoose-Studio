/**
 * @vitest-environment node
 *
 * A trading error becomes the response status, so the status has to be one the
 * Response constructor accepts: anything outside 200-599 throws a RangeError at
 * the route and the caller never sees the error body.
 */

import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TradingServiceError } from '@/lib/trading/errors'

const mocks = vi.hoisted(() => ({
  checkAuth: vi.fn(),
  getTradingPortfolioDetail: vi.fn(),
}))

vi.mock('@/lib/auth/hybrid', () => ({
  checkSessionOrInternalAuth: (...args: unknown[]) => mocks.checkAuth(...args),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}))

vi.mock('@/lib/trading/portfolio-detail', () => ({
  getTradingPortfolioDetail: (...args: unknown[]) => mocks.getTradingPortfolioDetail(...args),
}))

vi.mock('@/lib/utils', () => ({
  generateRequestId: vi.fn(() => 'request-1'),
}))

const createRequest = () =>
  new NextRequest('http://localhost/api/tools/trading/portfolio-detail?workspaceId=workspace-1', {
    method: 'POST',
    body: JSON.stringify({ portfolioIdentity: { providerId: 'alpaca' } }),
  })

describe('trading portfolio detail route error responses', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.checkAuth.mockResolvedValue({ success: true, userId: 'user-1' })
  })

  it('answers a trading error whose status is not an HTTP status with a valid 502', async () => {
    mocks.getTradingPortfolioDetail.mockRejectedValueOnce(
      new TradingServiceError('Broker request failed for alpaca: Unable to connect', 0)
    )
    const { POST } = await import('./route')

    const response = await POST(createRequest())

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { message: 'Broker request failed for alpaca: Unable to connect' },
    })
  })

  it('keeps a genuine trading status', async () => {
    mocks.getTradingPortfolioDetail.mockRejectedValueOnce(new TradingServiceError('Not found', 404))
    const { POST } = await import('./route')

    const response = await POST(createRequest())

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { message: 'Not found' },
    })
  })
})
