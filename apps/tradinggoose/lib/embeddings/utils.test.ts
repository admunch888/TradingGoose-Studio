/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  resolveAzureOpenAIServiceConfig,
  resolveOpenAICompatibleEmbeddingsServiceConfig,
  resolveOpenAIServiceConfig,
} = vi.hoisted(() => ({
  resolveAzureOpenAIServiceConfig: vi.fn(),
  resolveOpenAICompatibleEmbeddingsServiceConfig: vi.fn(),
  resolveOpenAIServiceConfig: vi.fn(),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}))
vi.mock('@/lib/knowledge/documents/utils', () => ({
  retryWithExponentialBackoff: (fn: () => unknown) => fn(),
  isRetryableError: () => false,
}))
vi.mock('@/lib/system-services/runtime', () => ({
  resolveAzureOpenAIServiceConfig,
  resolveOpenAICompatibleEmbeddingsServiceConfig,
  resolveOpenAIServiceConfig,
}))

import {
  buildOpenAICompatibleEmbeddingsUrl,
  fitEmbeddingDimensions,
  generateEmbeddings,
  generateSearchEmbedding,
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
} from '@/lib/embeddings/utils'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const respondWith = (...vectors: number[][]) =>
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data: vectors.map((embedding) => ({ embedding })) }),
  })

const requestBody = (callIndex = 0) => JSON.parse(fetchMock.mock.calls[callIndex][1].body)

const selfHosted = (overrides: Record<string, unknown> = {}) =>
  resolveOpenAICompatibleEmbeddingsServiceConfig.mockResolvedValue({
    apiKey: null,
    baseUrl: 'http://10.20.18.50:8081',
    model: 'Qwen/Qwen3-Embedding-4B',
    sendDimensions: false,
    ...overrides,
  })

const norm = (vector: number[]) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))

describe('fitEmbeddingDimensions', () => {
  it('keeps a vector of the stored size as it is', () => {
    const vector = [0.6, 0.8]
    expect(fitEmbeddingDimensions(vector, 2)).toBe(vector)
  })

  it('truncates a longer vector and re-normalises it to unit length', () => {
    const fitted = fitEmbeddingDimensions([3, 4, 12], 2)
    expect(fitted).toEqual([0.6, 0.8])
    expect(norm(fitted)).toBeCloseTo(1)
  })

  it('zero-pads a shorter vector', () => {
    expect(fitEmbeddingDimensions([0.1, 0.2], 4)).toEqual([0.1, 0.2, 0, 0])
  })
})

describe('buildOpenAICompatibleEmbeddingsUrl', () => {
  it('appends /v1/embeddings whatever form the base URL takes', () => {
    expect(buildOpenAICompatibleEmbeddingsUrl('http://host:8081')).toBe(
      'http://host:8081/v1/embeddings'
    )
    expect(buildOpenAICompatibleEmbeddingsUrl('http://host:8081/')).toBe(
      'http://host:8081/v1/embeddings'
    )
    expect(buildOpenAICompatibleEmbeddingsUrl('http://host:8081/v1/')).toBe(
      'http://host:8081/v1/embeddings'
    )
  })
})

describe('embedding provider selection', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    resolveOpenAICompatibleEmbeddingsServiceConfig.mockResolvedValue({
      apiKey: null,
      baseUrl: null,
      model: null,
      sendDimensions: false,
    })
    resolveAzureOpenAIServiceConfig.mockResolvedValue({
      apiKey: 'azure-key',
      endpoint: 'https://example.openai.azure.com',
      apiVersion: '2024-07-01-preview',
      embeddingModel: null,
    })
    resolveOpenAIServiceConfig.mockResolvedValue({ defaultApiKey: 'openai-key', rotationKeys: [] })
  })

  it('uses a configured self-hosted endpoint ahead of Azure and OpenAI', async () => {
    selfHosted()
    respondWith(Array.from({ length: 2560 }, (_, index) => (index % 7) + 1))

    const vector = await generateSearchEmbedding('iron condor on MES')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('http://10.20.18.50:8081/v1/embeddings')
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' })
    expect(requestBody()).toEqual({
      input: ['iron condor on MES'],
      model: 'Qwen/Qwen3-Embedding-4B',
      encoding_format: 'float',
    })
    // Qwen3-Embedding-4B returns 2560 values; the knowledge base stores 1536.
    expect(vector).toHaveLength(KNOWLEDGE_EMBEDDING_DIMENSIONS)
    expect(norm(vector)).toBeCloseTo(1)
  })

  it('requests 1536 dimensions and sends the bearer token when configured', async () => {
    selfHosted({ apiKey: 'local-token', sendDimensions: true, baseUrl: 'http://host:8081/v1' })
    respondWith(new Array(KNOWLEDGE_EMBEDDING_DIMENSIONS).fill(0.01))

    await generateEmbeddings(['first chunk'])

    expect(fetchMock.mock.calls[0][0]).toBe('http://host:8081/v1/embeddings')
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer local-token',
    })
    expect(requestBody().dimensions).toBe(KNOWLEDGE_EMBEDDING_DIMENSIONS)
  })

  it('pads a smaller model to the stored size for every chunk', async () => {
    selfHosted({ model: 'Qwen/Qwen3-Embedding-0.6B' })
    respondWith(new Array(1024).fill(0.5), new Array(1024).fill(0.25))

    const vectors = await generateEmbeddings(['a', 'b'])

    expect(vectors).toHaveLength(2)
    for (const vector of vectors) {
      expect(vector).toHaveLength(KNOWLEDGE_EMBEDDING_DIMENSIONS)
      expect(vector.slice(1024).every((value) => value === 0)).toBe(true)
    }
    expect(vectors[0][0]).toBe(0.5)
  })

  it('asks for a model name when only the base URL is set', async () => {
    selfHosted({ model: null })

    await expect(generateSearchEmbedding('query')).rejects.toThrow(
      'The self-hosted embeddings service needs a model name'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps Azure and OpenAI responses as they are when no self-hosted endpoint is set', async () => {
    respondWith([0.1, 0.2, 0.3])

    const vector = await generateSearchEmbedding('query')

    expect(fetchMock.mock.calls[0][0]).toContain(
      'https://example.openai.azure.com/openai/deployments/'
    )
    expect(vector).toEqual([0.1, 0.2, 0.3])
  })

  it('names every option when nothing is configured', async () => {
    resolveAzureOpenAIServiceConfig.mockResolvedValue({
      apiKey: null,
      endpoint: null,
      apiVersion: '2024-07-01-preview',
      embeddingModel: null,
    })
    resolveOpenAIServiceConfig.mockResolvedValue({ defaultApiKey: null, rotationKeys: [] })

    await expect(generateSearchEmbedding('query')).rejects.toThrow(
      'Configure a self-hosted embeddings endpoint, the OpenAI default API key, or the Azure OpenAI service'
    )
  })
})
