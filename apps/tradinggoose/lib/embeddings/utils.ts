import { isRetryableError, retryWithExponentialBackoff } from '@/lib/knowledge/documents/utils'
import { createLogger } from '@/lib/logs/console/logger'
import {
  resolveAzureOpenAIServiceConfig,
  resolveOpenAICompatibleEmbeddingsServiceConfig,
  resolveOpenAIServiceConfig,
} from '@/lib/system-services/runtime'
import { batchByTokenLimit, getTotalTokenCount } from '@/lib/tokenization'

const logger = createLogger('EmbeddingUtils')

const MAX_TOKENS_PER_REQUEST = 8000

/** Knowledge embeddings are stored as `vector(1536)` (text-embedding-3-small). */
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1536

export class EmbeddingAPIError extends Error {
  public status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'EmbeddingAPIError'
    this.status = status
  }
}

type EmbeddingProvider = 'self-hosted' | 'azure' | 'openai'

interface EmbeddingConfig {
  provider: EmbeddingProvider
  apiUrl: string
  headers: Record<string, string>
  modelName: string
  /** Self-hosted only: send `dimensions` so a Matryoshka model returns 1536 values. */
  sendDimensions: boolean
}

const PROVIDER_LABELS: Record<EmbeddingProvider, string> = {
  'self-hosted': 'self-hosted OpenAI-compatible endpoint',
  azure: 'Azure OpenAI',
  openai: 'OpenAI',
}

/** `http://host:8081`, `http://host:8081/` or `http://host:8081/v1` -> `http://host:8081/v1/embeddings`. */
export function buildOpenAICompatibleEmbeddingsUrl(baseUrl: string): string {
  const root = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
  return `${root}/v1/embeddings`
}

/**
 * Fits a vector to the stored dimension. A longer vector keeps its leading
 * values and is re-normalised to unit length, which is how Matryoshka models
 * (Qwen3-Embedding) are meant to be shortened; a shorter one is zero-padded,
 * which leaves cosine similarity between vectors of that model unchanged.
 */
export function fitEmbeddingDimensions(vector: number[], dimensions: number): number[] {
  if (vector.length === dimensions) return vector
  if (vector.length < dimensions) {
    return [...vector, ...new Array<number>(dimensions - vector.length).fill(0)]
  }
  const truncated = vector.slice(0, dimensions)
  const norm = Math.sqrt(truncated.reduce((sum, value) => sum + value * value, 0))
  return norm > 0 ? truncated.map((value) => value / norm) : truncated
}

async function getEmbeddingConfig(
  embeddingModel = 'text-embedding-3-small'
): Promise<EmbeddingConfig> {
  const [selfHostedConfig, azureConfig, openaiConfig] = await Promise.all([
    resolveOpenAICompatibleEmbeddingsServiceConfig(),
    resolveAzureOpenAIServiceConfig(),
    resolveOpenAIServiceConfig(),
  ])

  // A self-hosted endpoint keeps knowledge search on the operator's own
  // hardware, so it wins whenever it is configured.
  if (selfHostedConfig.baseUrl) {
    if (!selfHostedConfig.model) {
      throw new Error(
        'The self-hosted embeddings service needs a model name (Admin > Services > Self-hosted embeddings)'
      )
    }
    return {
      provider: 'self-hosted',
      apiUrl: buildOpenAICompatibleEmbeddingsUrl(selfHostedConfig.baseUrl),
      headers: {
        'Content-Type': 'application/json',
        ...(selfHostedConfig.apiKey ? { Authorization: `Bearer ${selfHostedConfig.apiKey}` } : {}),
      },
      modelName: selfHostedConfig.model,
      sendDimensions: selfHostedConfig.sendDimensions,
    }
  }

  const azureApiKey = azureConfig.apiKey || ''
  const azureEndpoint = azureConfig.endpoint
  const azureApiVersion = azureConfig.apiVersion
  const kbModelName = azureConfig.embeddingModel || embeddingModel
  const openaiApiKey = openaiConfig.defaultApiKey || ''

  const useAzure = !!(azureApiKey && azureEndpoint)

  if (!useAzure && !openaiApiKey) {
    throw new Error(
      'Configure a self-hosted embeddings endpoint, the OpenAI default API key, or the Azure OpenAI service'
    )
  }

  const apiUrl = useAzure
    ? `${azureEndpoint}/openai/deployments/${kbModelName}/embeddings?api-version=${azureApiVersion}`
    : 'https://api.openai.com/v1/embeddings'

  const headers: Record<string, string> = useAzure
    ? {
        'api-key': azureApiKey!,
        'Content-Type': 'application/json',
      }
    : {
        Authorization: `Bearer ${openaiApiKey!}`,
        'Content-Type': 'application/json',
      }

  return {
    provider: useAzure ? 'azure' : 'openai',
    apiUrl,
    headers,
    modelName: useAzure ? kbModelName : embeddingModel,
    sendDimensions: false,
  }
}

async function callEmbeddingAPI(inputs: string[], config: EmbeddingConfig): Promise<number[][]> {
  return retryWithExponentialBackoff(
    async () => {
      const requestBody =
        config.provider === 'azure'
          ? {
              input: inputs,
              encoding_format: 'float',
            }
          : {
              input: inputs,
              model: config.modelName,
              encoding_format: 'float',
              ...(config.sendDimensions ? { dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS } : {}),
            }

      const response = await fetch(config.apiUrl, {
        method: 'POST',
        headers: config.headers,
        body: JSON.stringify(requestBody),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new EmbeddingAPIError(
          `Embedding API failed: ${response.status} ${response.statusText} - ${errorText}`,
          response.status
        )
      }

      const data = await response.json()
      const embeddings: number[][] = data.data.map((item: any) => item.embedding)
      // A self-hosted model's native size need not match the stored vector(1536).
      return config.provider === 'self-hosted'
        ? embeddings.map((vector) => fitEmbeddingDimensions(vector, KNOWLEDGE_EMBEDDING_DIMENSIONS))
        : embeddings
    },
    {
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      retryCondition: (error: any) => {
        if (error instanceof EmbeddingAPIError) {
          return error.status === 429 || error.status >= 500
        }
        return isRetryableError(error)
      },
    }
  )
}

/**
 * Generate embeddings for multiple texts with token-aware batching
 * Uses tiktoken for token counting
 */
export async function generateEmbeddings(
  texts: string[],
  embeddingModel = 'text-embedding-3-small'
): Promise<number[][]> {
  const config = await getEmbeddingConfig(embeddingModel)

  logger.info(
    `Using ${PROVIDER_LABELS[config.provider]} for embeddings generation (${texts.length} texts)`
  )

  const batches = batchByTokenLimit(texts, MAX_TOKENS_PER_REQUEST, embeddingModel)

  logger.info(
    `Split ${texts.length} texts into ${batches.length} batches (max ${MAX_TOKENS_PER_REQUEST} tokens per batch)`
  )

  const allEmbeddings: number[][] = []

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    const batchTokenCount = getTotalTokenCount(batch, embeddingModel)

    logger.info(
      `Processing batch ${i + 1}/${batches.length}: ${batch.length} texts, ${batchTokenCount} tokens`
    )

    try {
      const batchEmbeddings = await callEmbeddingAPI(batch, config)
      allEmbeddings.push(...batchEmbeddings)

      logger.info(
        `Generated ${batchEmbeddings.length} embeddings for batch ${i + 1}/${batches.length}`
      )
    } catch (error) {
      logger.error(`Failed to generate embeddings for batch ${i + 1}:`, error)
      throw error
    }

    if (i + 1 < batches.length) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  logger.info(`Successfully generated ${allEmbeddings.length} embeddings total`)

  return allEmbeddings
}

/**
 * Generate embedding for a single search query
 */
export async function generateSearchEmbedding(
  query: string,
  embeddingModel = 'text-embedding-3-small'
): Promise<number[]> {
  const config = await getEmbeddingConfig(embeddingModel)

  logger.info(`Using ${PROVIDER_LABELS[config.provider]} for search embedding generation`)

  const embeddings = await callEmbeddingAPI([query], config)
  return embeddings[0]
}
