/**
 * @vitest-environment jsdom
 *
 * A model-discovery cycle must not run for a service slot the deployment never
 * configured: on the deployed box every cycle logged
 * `[OllamaModelsAPI] Failed to fetch Ollama models {"host":"http://localhost:11434"}`
 * against a host that does not exist there.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()

const installSessionStorage = () => {
  const entries = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    get length() {
      return entries.size
    },
    removeItem: (key: string) => entries.delete(key),
    setItem: (key: string, value: string) => entries.set(key, String(value)),
  })
  return entries
}

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const requestedPaths = () =>
  fetchMock.mock.calls.map((call) => {
    try {
      return new URL(String(call[0])).pathname
    } catch {
      return String(call[0])
    }
  })

describe('providers store model discovery', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    installSessionStorage()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not request the ollama endpoint again once the server reports it unconfigured', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      jsonResponse(
        String(url).includes('/ollama/models') ? { models: [], configured: false } : { models: [] }
      )
    )

    const { useProvidersStore } = await import('./store')
    await useProvidersStore.getState().fetchModels('ollama')
    await useProvidersStore.getState().fetchModels('ollama')

    expect(
      requestedPaths().filter((path) => path === '/api/providers/ai/ollama/models')
    ).toHaveLength(1)
  })

  it('keeps the skip across a page reload and lifts it when the slot is configured', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      jsonResponse(
        String(url).includes('/ollama/models') ? { models: [], configured: false } : { models: [] }
      )
    )

    const firstLoad = await import('./store')
    await firstLoad.useProvidersStore.getState().fetchModels('ollama')

    vi.resetModules()
    const secondLoad = await import('./store')
    await secondLoad.useProvidersStore.getState().fetchModels('ollama')
    expect(requestedPaths()).toHaveLength(1)

    secondLoad.resetUnconfiguredProviderSlots()
    fetchMock.mockImplementation(async () =>
      jsonResponse({ models: ['gemma3:4b'], configured: true })
    )

    await secondLoad.useProvidersStore.getState().fetchModels('ollama')

    expect(requestedPaths()).toHaveLength(2)
    expect(secondLoad.useProvidersStore.getState().providers.ollama.models).toEqual(['gemma3:4b'])
  })

  it('still discovers models for a configured slot', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ models: ['gemma3:4b'], configured: true })
    )

    const { useProvidersStore } = await import('./store')
    await useProvidersStore.getState().fetchModels('ollama')

    expect(
      requestedPaths().filter((path) => path === '/api/providers/ai/ollama/models')
    ).toHaveLength(1)
    expect(useProvidersStore.getState().providers.ollama.models).toEqual(['gemma3:4b'])
  })
})
