/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/environment', () => ({ isHosted: false }))

vi.mock('@/stores/providers/store', () => ({
  useProvidersStore: {
    getState: () => ({
      providers: {
        ollama: { models: ['llama3.1:8b'] },
        vllm: { models: ['vllm/qwen3.8-fp8'] },
      },
    }),
  },
}))

import { getApiKey } from '@/providers/ai/utils-server'

describe('getApiKey', () => {
  it('needs no block key for vLLM models, leaving the service key to the provider', async () => {
    await expect(getApiKey('vllm', 'vllm/qwen3.8-fp8')).resolves.toBe('')
  })

  it('passes a key typed into the block through for vLLM models', async () => {
    await expect(getApiKey('vllm', 'vllm/qwen3.8-fp8', 'sk-local')).resolves.toBe('sk-local')
  })

  it('keeps Ollama models keyless', async () => {
    await expect(getApiKey('ollama', 'llama3.1:8b')).resolves.toBe('empty')
  })

  it('still requires a key for hosted providers', async () => {
    await expect(getApiKey('openai', 'gpt-4o')).rejects.toThrow(
      'API key is required for openai gpt-4o'
    )
  })
})
