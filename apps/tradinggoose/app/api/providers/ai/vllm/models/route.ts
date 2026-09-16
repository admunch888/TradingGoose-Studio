import { NextResponse } from 'next/server'
import { resolveCopilotEndpoint } from '@/lib/copilot/local-runtime/endpoint'
import { createLogger } from '@/lib/logs/console/logger'
import { resolveVllmServiceConfig } from '@/lib/system-services/runtime'
import { filterBlacklistedModels } from '@/providers/ai/utils'

const logger = createLogger('VLLMModelsAPI')

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const config = await resolveVllmServiceConfig()

    // The Copilot may be pointed at a different host than the Agent blocks, and
    // must then offer that host's models rather than the shared endpoint's.
    const forCopilot = new URL(request.url).searchParams.get('for') === 'copilot'
    const endpoint = forCopilot
      ? resolveCopilotEndpoint(config)
      : config.baseUrl
        ? { baseUrl: config.baseUrl.replace(/\/$/, ''), apiKey: config.apiKey ?? '' }
        : null

    if (!endpoint) {
      logger.info('vLLM base URL not configured')
      return NextResponse.json({ models: [] })
    }
    const { baseUrl } = endpoint

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    const apiKey = endpoint.apiKey
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
    }

    const response = await fetch(`${baseUrl}/v1/models`, {
      headers,
      next: { revalidate: 60 },
    })

    if (!response.ok) {
      logger.warn('vLLM service is not available', {
        status: response.status,
        statusText: response.statusText,
      })
      return NextResponse.json({ models: [] })
    }

    const data = (await response.json()) as { data: Array<{ id: string }> }
    const models = filterBlacklistedModels(data.data.map((model) => `vllm/${model.id}`))

    logger.info('Successfully fetched vLLM models', {
      count: models.length,
    })

    return NextResponse.json({ models })
  } catch (error) {
    logger.error('Failed to fetch vLLM models', {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return NextResponse.json({ models: [] })
  }
}
