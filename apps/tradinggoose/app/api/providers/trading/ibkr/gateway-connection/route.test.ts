/**
 * @vitest-environment node
 */

import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TradingServiceError } from '@/lib/trading/errors'

const { mockConnectIbkrGateway, mockGetSession } = vi.hoisted(() => ({
  mockConnectIbkrGateway: vi.fn(),
  mockGetSession: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}))

vi.mock('@/lib/trading/ibkr-gateway-connection', () => ({
  connectIbkrGateway: (...args: unknown[]) => mockConnectIbkrGateway(...args),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}))

import { POST } from '@/app/api/providers/trading/ibkr/gateway-connection/route'

const request = (body: unknown) =>
  new NextRequest('http://localhost/api/providers/trading/ibkr/gateway-connection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /api/providers/trading/ibkr/gateway-connection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({ user: { id: 'user-1', email: 'trader@example.com' } })
  })

  it('rejects an unauthenticated request', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await POST(request({ serviceId: 'ibkr-paper' }))

    expect(response.status).toBe(401)
    expect(mockConnectIbkrGateway).not.toHaveBeenCalled()
  })

  it('requires a serviceId', async () => {
    const response = await POST(request({}))

    expect(response.status).toBe(400)
    expect(mockConnectIbkrGateway).not.toHaveBeenCalled()
  })

  it("connects the session user's gateway service", async () => {
    mockConnectIbkrGateway.mockResolvedValue({
      connectionId: 'connection-1',
      ibkrAccountId: 'DU123456',
      environment: 'paper',
    })

    const response = await POST(request({ serviceId: 'ibkr-paper' }))

    expect(mockConnectIbkrGateway).toHaveBeenCalledWith({
      userId: 'user-1',
      email: 'trader@example.com',
      serviceId: 'ibkr-paper',
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      connectionId: 'connection-1',
      ibkrAccountId: 'DU123456',
      environment: 'paper',
    })
  })

  it('answers a refused connection with its status and message', async () => {
    mockConnectIbkrGateway.mockRejectedValue(
      new TradingServiceError('The IBKR gateway is logged in to a live account.', 409)
    )

    const response = await POST(request({ serviceId: 'ibkr-paper' }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'The IBKR gateway is logged in to a live account.',
    })
  })

  it('hides unexpected failures behind a generic 500', async () => {
    mockConnectIbkrGateway.mockRejectedValue(new Error('database exploded'))

    const response = await POST(request({ serviceId: 'ibkr-paper' }))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Failed to connect the IBKR gateway' })
  })
})
