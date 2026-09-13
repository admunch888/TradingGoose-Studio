import { createWithEqualityFn as create } from 'zustand/traditional'
import { createLogger } from '@/lib/logs/console/logger'
import { getBaseUrl } from '@/lib/urls/utils'
import {
  updateFireworksProviderModels,
  updateOllamaProviderModels,
  updateOpenRouterProviderModels,
  updateVLLMProviderModels,
} from '@/providers/ai/utils'
import type { ProviderConfig, ProviderName, ProvidersStore } from './types'

const logger = createLogger('ProvidersStore')
let hasBootstrappedProviderModels = false

// Slots the server reported as unconfigured (`configured: false`). Their model
// endpoints answer with an empty list without contacting anything, so re-asking
// on every page load is pure noise - and it was the loop that logged a
// connection error for the unconfigured Ollama slot on the deployed box. The
// observation survives a reload (sessionStorage) so a browsing session stops
// asking, and it is dropped the moment an admin saves that service.
const UNCONFIGURED_SLOTS_STORAGE_KEY = 'tradinggoose:unconfigured-provider-slots'
const unconfiguredProviderSlots = new Set<ProviderName>()

const readStoredUnconfiguredSlots = (): ProviderName[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.sessionStorage.getItem(UNCONFIGURED_SLOTS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is ProviderName => typeof value === 'string')
  } catch (_error) {
    return []
  }
}

const isProviderSlotUnconfigured = (provider: ProviderName) => {
  if (unconfiguredProviderSlots.has(provider)) return true
  if (!readStoredUnconfiguredSlots().includes(provider)) return false
  unconfiguredProviderSlots.add(provider)
  return true
}

const markProviderSlotUnconfigured = (provider: ProviderName) => {
  unconfiguredProviderSlots.add(provider)
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(
      UNCONFIGURED_SLOTS_STORAGE_KEY,
      JSON.stringify(Array.from(unconfiguredProviderSlots))
    )
  } catch (_error) {
    // Storage being unavailable only costs a repeated (cheap) request.
  }
}

/** Called when a service is saved: the slot may have just become configured. */
export function resetUnconfiguredProviderSlots() {
  unconfiguredProviderSlots.clear()
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(UNCONFIGURED_SLOTS_STORAGE_KEY)
  } catch (_error) {
    // Nothing to clear if storage is unavailable.
  }
}

const PROVIDER_CONFIGS: Record<ProviderName, ProviderConfig> = {
  base: {
    apiEndpoint: '/api/providers/ai/base/models',
    dedupeModels: true,
    updateFunction: () => {},
  },
  ollama: {
    apiEndpoint: '/api/providers/ai/ollama/models',
    updateFunction: updateOllamaProviderModels,
  },
  openrouter: {
    apiEndpoint: '/api/providers/ai/openrouter/models',
    dedupeModels: true,
    updateFunction: updateOpenRouterProviderModels,
  },
  vllm: {
    apiEndpoint: '/api/providers/ai/vllm/models',
    updateFunction: updateVLLMProviderModels,
  },
  fireworks: {
    apiEndpoint: '/api/providers/ai/fireworks/models',
    dedupeModels: true,
    updateFunction: updateFireworksProviderModels,
  },
}

const resolveApiEndpoint = (endpoint: string): string => {
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint
  }

  const baseUrl =
    typeof window !== 'undefined' && window.location?.origin ? window.location.origin : getBaseUrl()

  try {
    return new URL(endpoint, baseUrl).toString()
  } catch (_error) {
    return endpoint
  }
}

const fetchProviderModels = async (
  provider: ProviderName
): Promise<{ models: string[]; configured: boolean }> => {
  try {
    const config = PROVIDER_CONFIGS[provider]
    const apiEndpoint = resolveApiEndpoint(config.apiEndpoint)
    const response = await fetch(apiEndpoint)

    if (!response.ok) {
      logger.warn(`Failed to fetch ${provider} models from API`, {
        status: response.status,
        statusText: response.statusText,
        apiEndpoint,
      })
      return { models: [], configured: true }
    }

    const data = await response.json()
    return {
      models: data.models || [],
      // Only the model routes that know about an unconfigured slot send this.
      configured: data.configured !== false,
    }
  } catch (error) {
    logger.warn(`Error fetching ${provider} models`, {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return { models: [], configured: true }
  }
}

export const useProvidersStore = create<ProvidersStore>((set, get) => ({
  providers: {
    base: { models: [], isLoading: false },
    ollama: { models: [], isLoading: false },
    openrouter: { models: [], isLoading: false },
    vllm: { models: [], isLoading: false },
    fireworks: { models: [], isLoading: false },
  },

  setModels: (provider, models) => {
    const config = PROVIDER_CONFIGS[provider]

    const processedModels = config.dedupeModels ? Array.from(new Set(models)) : models

    set((state) => ({
      providers: {
        ...state.providers,
        [provider]: {
          ...state.providers[provider],
          models: processedModels,
        },
      },
    }))

    void Promise.resolve(config.updateFunction(models)).catch((error) => {
      logger.warn(`Failed to update ${provider} provider models`, {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    })
  },

  fetchModels: async (provider) => {
    if (typeof window === 'undefined') {
      logger.info(`Skipping client-side ${provider} model fetch on server`)
      return
    }

    if (isProviderSlotUnconfigured(provider)) {
      logger.info(`${provider} model fetch skipped: the service slot is not configured`)
      return
    }

    const currentState = get().providers[provider]
    if (currentState.isLoading) {
      logger.info(`${provider} model fetch already in progress`)
      return
    }

    logger.info(`Fetching ${provider} models from API`)

    set((state) => ({
      providers: {
        ...state.providers,
        [provider]: {
          ...state.providers[provider],
          isLoading: true,
        },
      },
    }))

    try {
      const { models, configured } = await fetchProviderModels(provider)
      if (!configured) {
        markProviderSlotUnconfigured(provider)
        logger.info(`${provider} service slot is not configured; skipping further fetches`)
      }
      logger.info(`Successfully fetched ${provider} models`, {
        count: models.length,
        ...(provider === 'ollama' ? { models } : {}),
      })
      get().setModels(provider, models)
    } catch (error) {
      logger.error(`Failed to fetch ${provider} models`, {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    } finally {
      set((state) => ({
        providers: {
          ...state.providers,
          [provider]: {
            ...state.providers[provider],
            isLoading: false,
          },
        },
      }))
    }
  },

  getProvider: (provider) => {
    return get().providers[provider]
  },
}))

export function bootstrapProviderModels() {
  if (typeof window === 'undefined' || hasBootstrappedProviderModels) {
    return
  }

  hasBootstrappedProviderModels = true

  const store = useProvidersStore.getState()
  store.fetchModels('base')
  store.fetchModels('ollama')
  store.fetchModels('openrouter')
  store.fetchModels('vllm')
  store.fetchModels('fireworks')
}
