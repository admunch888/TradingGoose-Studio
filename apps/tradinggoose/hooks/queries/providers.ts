import { useQuery } from '@tanstack/react-query'
import { createLogger } from '@/lib/logs/console/logger'
import type { ProviderName } from '@/stores/providers/types'

const logger = createLogger('ProviderModelsQuery')

const providerEndpoints: Record<ProviderName, string> = {
  base: '/api/providers/ai/base/models',
  ollama: '/api/providers/ai/ollama/models',
  vllm: '/api/providers/ai/vllm/models',
  fireworks: '/api/providers/ai/fireworks/models',
  openrouter: '/api/providers/ai/openrouter/models',
}

async function fetchProviderModels(provider: ProviderName, search = ''): Promise<string[]> {
  const response = await fetch(`${providerEndpoints[provider]}${search}`)

  if (!response.ok) {
    logger.warn(`Failed to fetch ${provider} models`, {
      status: response.status,
      statusText: response.statusText,
    })
    throw new Error(`Failed to fetch ${provider} models`)
  }

  const data = await response.json()
  const models: string[] = Array.isArray(data.models) ? data.models : []

  return provider === 'openrouter' ? Array.from(new Set(models)) : models
}

export function useProviderModels(provider: ProviderName) {
  return useQuery({
    queryKey: ['provider-models', provider],
    queryFn: () => fetchProviderModels(provider),
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * The models the Copilot can actually reach.
 *
 * The Copilot may be pointed at a different host than the Agent blocks, and then
 * offering the shared endpoint's models lists models it cannot run, while hiding
 * the ones it can. Its own query key, so the two lists never share a cache
 * entry.
 */
export function useCopilotLocalModels() {
  return useQuery({
    queryKey: ['provider-models', 'vllm', 'copilot'],
    queryFn: () => fetchProviderModels('vllm', '?for=copilot'),
    staleTime: 5 * 60 * 1000,
  })
}
