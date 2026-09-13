/**
 * @vitest-environment node
 */

import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isOllamaServiceConfigured: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  resolveOllamaServiceConfig: vi.fn(),
}))

vi.mock('@/lib/system-services/runtime', () => ({
  isOllamaServiceConfigured: (...args: unknown[]) => mocks.isOllamaServiceConfigured(...args),
  resolveOllamaServiceConfig: (...args: unknown[]) => mocks.resolveOllamaServiceConfig(...args),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: () => mocks.logger,
}))

const fetchMock = vi.fn()

/** Bun's connection-refused text, which is what this route logged on the box. */
const connectionRefused = () =>
  Object.assign(new TypeError('Unable to connect. Is the computer able to access the url?'), {
    code: 'ConnectionRefused',
  })

const ollamaModelsResponse = (names: string[]) =>
  new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const runRoute = async () => {
  const { GET } = await import('./route')
  return GET(new NextRequest('http://localhost/api/providers/ai/ollama/models'))
}

describe('GET /api/providers/ai/ollama/models', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    mocks.resolveOllamaServiceConfig.mockResolvedValue({ baseUrl: 'http://localhost:11434' })
  })

  it('neither contacts the unconfigured service nor logs an error for it', async () => {
    mocks.isOllamaServiceConfigured.mockResolvedValue(false)

    const response = await runRoute()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ models: [], configured: false })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.logger.error).not.toHaveBeenCalled()
  })

  it('still discovers models from a configured host', async () => {
    mocks.isOllamaServiceConfigured.mockResolvedValue(true)
    mocks.resolveOllamaServiceConfig.mockResolvedValue({ baseUrl: 'http://ollama.internal:11434' })
    fetchMock.mockResolvedValue(ollamaModelsResponse(['gemma3:4b', 'qwen3:8b']))

    const response = await runRoute()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://ollama.internal:11434/api/tags',
      expect.anything()
    )
    await expect(response.json()).resolves.toEqual({
      models: ['gemma3:4b', 'qwen3:8b'],
      configured: true,
    })
  })

  it('still reports a configured host that cannot be reached', async () => {
    mocks.isOllamaServiceConfigured.mockResolvedValue(true)
    fetchMock.mockRejectedValue(connectionRefused())

    const response = await runRoute()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ models: [], configured: true })
    expect(mocks.logger.error).toHaveBeenCalledTimes(1)
  })

  it('treats an upstream error status as an unavailable, configured service', async () => {
    mocks.isOllamaServiceConfigured.mockResolvedValue(true)
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }))

    const response = await runRoute()

    await expect(response.json()).resolves.toEqual({ models: [], configured: true })
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1)
    expect(mocks.logger.error).not.toHaveBeenCalled()
  })

  it('falls back to attempting discovery when the configuration cannot be read', async () => {
    // A store outage must not turn into a new failure mode for discovery.
    mocks.isOllamaServiceConfigured.mockRejectedValue(new Error('store is down'))
    fetchMock.mockResolvedValue(ollamaModelsResponse(['gemma3:4b']))

    const response = await runRoute()

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(response.json()).resolves.toEqual({ models: ['gemma3:4b'], configured: true })
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1)
  })
})
