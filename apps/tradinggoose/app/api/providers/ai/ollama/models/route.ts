import { type NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/logs/console/logger'
import {
  isOllamaServiceConfigured,
  resolveOllamaServiceConfig,
} from '@/lib/system-services/runtime'
import type { ModelsObject } from '@/providers/ai/ollama/types'

const logger = createLogger('OllamaModelsAPI')

export const dynamic = 'force-dynamic'

/**
 * Get available Ollama models
 */
export async function GET(request: NextRequest) {
  // Same gate the vLLM and Fireworks model routes already use: a slot with
  // nothing saved is not contacted at all. Ollama is the only one of the three
  // whose resolver substitutes a built-in default host
  // (lib/system-services/runtime.ts), so without this check every discovery
  // cycle on a deployment that never configured Ollama talked to
  // http://localhost:11434 and logged a connection error for a service nobody
  // set up. `configured: false` lets the client stop asking.
  //
  // A configuration read that fails counts as "configured": the route then
  // behaves exactly as it did before this gate existed instead of turning a
  // store outage into a new failure mode for model discovery.
  const configured = await isOllamaServiceConfigured().catch((error) => {
    logger.warn('Could not read the Ollama service configuration; attempting discovery anyway', {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return true
  })

  if (!configured) {
    logger.info('Ollama base URL not configured')
    return NextResponse.json({ models: [], configured: false })
  }

  try {
    const ollamaConfig = await resolveOllamaServiceConfig()
    logger.info('Fetching Ollama models', {
      host: ollamaConfig.baseUrl,
    })

    const response = await fetch(`${ollamaConfig.baseUrl}/api/tags`, {
      headers: {
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      logger.warn('Ollama service is not available', {
        status: response.status,
        statusText: response.statusText,
      })
      return NextResponse.json({ models: [], configured: true })
    }

    const data = (await response.json()) as ModelsObject
    const models = data.models.map((model) => model.name)

    logger.info('Successfully fetched Ollama models', {
      count: models.length,
      models,
    })

    return NextResponse.json({ models, configured: true })
  } catch (error) {
    // Only reachable for a service the operator DID configure: an
    // unconfigured slot never gets this far, so this stays a real signal.
    logger.error('Failed to fetch Ollama models', {
      error: error instanceof Error ? error.message : 'Unknown error',
      host: (await resolveOllamaServiceConfig()).baseUrl,
    })

    // Return empty array instead of error to avoid breaking the UI
    return NextResponse.json({ models: [], configured: true })
  }
}
