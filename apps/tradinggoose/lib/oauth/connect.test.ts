/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch, mockLink, mockToastError } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockLink: vi.fn(),
  mockToastError: vi.fn(),
}))

vi.mock('@/lib/auth-client', () => ({
  client: { oauth2: { link: (...args: unknown[]) => mockLink(...args) } },
}))

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}))

vi.mock('@/i18n/utils', () => ({
  normalizeCallbackUrl: (url: string) => url,
}))

import { startOAuthConnectFlow } from '@/lib/oauth/connect'

const callbackURL = '/workspace/ws-1/integrations'

describe('startOAuthConnectFlow', () => {
  const originalLocation = window.location

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch)
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin: 'http://localhost', href: 'http://localhost/start' },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  })

  it.each(['ibkr-paper', 'ibkr-live'])(
    'connects %s through the gateway route and returns to the callback',
    async (providerId) => {
      mockFetch.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))

      await startOAuthConnectFlow({ providerId, callbackURL })

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/providers/trading/ibkr/gateway-connection',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ serviceId: providerId }),
        })
      )
      expect(window.location.href).toBe(callbackURL)
      expect(mockLink).not.toHaveBeenCalled()
    }
  )

  it("shows the server's refusal and stays on the page", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'The IBKR gateway is logged in to a live account.' }), {
        status: 409,
      })
    )

    await expect(startOAuthConnectFlow({ providerId: 'ibkr-paper', callbackURL })).rejects.toThrow(
      'logged in to a live account'
    )
    expect(mockToastError).toHaveBeenCalledWith('The IBKR gateway is logged in to a live account.')
    expect(window.location.href).toBe('http://localhost/start')
  })

  it('falls back to a generic message when the refusal has no body', async () => {
    mockFetch.mockResolvedValue(new Response('gateway down', { status: 502 }))

    await expect(startOAuthConnectFlow({ providerId: 'ibkr-live', callbackURL })).rejects.toThrow(
      'Failed to connect the IBKR gateway'
    )
    expect(mockToastError).toHaveBeenCalledWith('Failed to connect the IBKR gateway')
  })

  it('still links other providers through OAuth', async () => {
    await startOAuthConnectFlow({ providerId: 'alpaca-paper', callbackURL })

    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockLink).toHaveBeenCalledWith({
      providerId: 'alpaca-paper',
      callbackURL,
      errorCallbackURL: callbackURL,
    })
  })
})
