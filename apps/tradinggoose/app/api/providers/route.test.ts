/**
 * @vitest-environment node
 *
 * Routing contract for /api/providers: a body that carries market request
 * fields must reach the MARKET handler, never the AI handler.
 */

import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handleAIProviderRequest: vi.fn(),
  handleMarketProviderRequest: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}))

vi.mock('@/app/api/providers/ai/handler', () => ({
  handleAIProviderRequest: (...args: unknown[]) => mocks.handleAIProviderRequest(...args),
}))

vi.mock('@/app/api/providers/market/handler', () => ({
  handleMarketProviderRequest: (...args: unknown[]) => mocks.handleMarketProviderRequest(...args),
}))

vi.mock('@/lib/auth/hybrid', () => ({
  checkSessionOrInternalAuth: vi.fn(async () => null),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: () => mocks.logger,
}))

vi.mock('@/lib/utils', () => ({
  generateRequestId: () => 'providers-route-test-1',
}))

const listing = {
  listing_id: 'AAPL',
  base_id: '',
  quote_id: '',
  listing_type: 'default' as const,
}

/** Exactly the body widgets/widgets/data_chart/hooks/use-chart-data-loader.ts sends. */
const marketSeriesBody = {
  provider: 'ibkr',
  providerNamespace: 'market',
  workspaceId: 'ws-1',
  kind: 'series',
  listing,
  interval: '1d',
  windows: [{ mode: 'bars', barCount: 100 }],
}

const postRoute = async (body: unknown) => {
  const { POST } = await import('./route')
  return POST(
    new NextRequest('http://localhost/api/providers', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  )
}

describe('POST /api/providers namespace resolution', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.handleAIProviderRequest.mockResolvedValue(
      new Response(JSON.stringify({ handledBy: 'ai' }), { status: 200 })
    )
    mocks.handleMarketProviderRequest.mockResolvedValue(
      new Response(JSON.stringify({ handledBy: 'market' }), { status: 200 })
    )
  })

  it('routes a market-shaped request with an explicit namespace to the market handler', async () => {
    const response = await postRoute(marketSeriesBody)

    expect(mocks.handleMarketProviderRequest).toHaveBeenCalledTimes(1)
    expect(mocks.handleAIProviderRequest).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
  })

  it('routes a market-shaped request with NO namespace field to the market handler', async () => {
    // A dropped/misread namespace field used to fall through to the AI handler,
    // which answered "Model is required" - a non-market error in a market chart.
    const { providerNamespace: _dropped, ...withoutNamespace } = marketSeriesBody

    await postRoute(withoutNamespace)

    expect(mocks.handleMarketProviderRequest).toHaveBeenCalledTimes(1)
    expect(mocks.handleAIProviderRequest).not.toHaveBeenCalled()
  })

  it('routes a market-shaped request that carries providerType instead to the market handler', async () => {
    const { providerNamespace: _dropped, ...rest } = marketSeriesBody

    await postRoute({ ...rest, providerType: 'market' })

    expect(mocks.handleMarketProviderRequest).toHaveBeenCalledTimes(1)
    expect(mocks.handleAIProviderRequest).not.toHaveBeenCalled()
  })

  it('keeps the colon form working', async () => {
    const { providerNamespace: _dropped, ...rest } = marketSeriesBody

    await postRoute({ ...rest, provider: 'market:ibkr' })

    expect(mocks.handleMarketProviderRequest).toHaveBeenCalledTimes(1)
    expect(mocks.handleAIProviderRequest).not.toHaveBeenCalled()
  })

  it('leaves an AI-shaped request with no namespace on the AI handler', async () => {
    // tools/llm/chat.ts sends { provider, model, ... } and no namespace at all.
    await postRoute({ provider: 'openai', model: 'gpt-4o-mini' })

    expect(mocks.handleAIProviderRequest).toHaveBeenCalledTimes(1)
    expect(mocks.handleMarketProviderRequest).not.toHaveBeenCalled()
  })

  it('honours an explicit AI namespace even when market fields are present', async () => {
    await postRoute({ ...marketSeriesBody, providerNamespace: 'ai' })

    expect(mocks.handleAIProviderRequest).toHaveBeenCalledTimes(1)
    expect(mocks.handleMarketProviderRequest).not.toHaveBeenCalled()
  })

  it('no longer invents the AI namespace for a provider that is not an AI provider', async () => {
    // The silent `'ai'` default is what turned a market request into an AI error.
    const response = await postRoute({ provider: 'ibkr', model: 'ignored' })
    const payload = (await response.json()) as { handledBy?: string }

    expect(payload.handledBy).toBe('market')
  })

  it('answers an unusable provider field with a request error, not a runtime one', async () => {
    const response = await postRoute({ provider: 42, listing })

    expect(response.status).toBe(400)
    expect(mocks.handleAIProviderRequest).not.toHaveBeenCalled()
    expect(mocks.handleMarketProviderRequest).not.toHaveBeenCalled()
  })
})
