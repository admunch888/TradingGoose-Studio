import { DEFAULT_LOCAL_CONTEXT_WINDOW } from '@/lib/copilot/local-runtime/working-messages'
import { createLogger } from '@/lib/logs/console/logger'
import { resolveVllmServiceConfig } from '@/lib/system-services/runtime'

const logger = createLogger('LocalCopilotSettings')

export const DEFAULT_LOCAL_MAX_TOOL_ITERATIONS = 20

const MIN_CONTEXT_WINDOW = 8_192
const MAX_CONTEXT_WINDOW = 1_048_576
const MAX_TOOL_ITERATIONS_LIMIT = 100
const MAX_TEMPERATURE = 2

/**
 * How the local Copilot talks to the self-hosted model, from the
 * "Self-hosted / custom OpenAI-compatible endpoint" system service.
 *
 * Every field is optional there: an unset field keeps the previous behaviour
 * (32,768-token window, 20 tool steps, the server's own sampling defaults, no
 * chat-template override).
 */
export interface LocalCopilotSettings {
  /** Model context window in tokens; history is trimmed to half of it. */
  contextWindow: number
  /** Model calls allowed in one turn before the loop stops. */
  maxToolIterations: number
  /** Sampling temperature; undefined leaves the server default. */
  temperature?: number
  /**
   * Ask the chat template to think before answering
   * (`chat_template_kwargs.enable_thinking`, understood by Qwen3-family
   * templates on SGLang and vLLM). False sends nothing, so a server-side default
   * still applies.
   */
  enableThinking: boolean
}

export interface LocalCopilotSettingsInput {
  copilotContextWindow?: number
  copilotMaxToolIterations?: number
  copilotTemperature?: number
  copilotEnableThinking?: boolean
}

const inRange = (value: number | undefined, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

/** Out-of-range values fall back to the default rather than reaching the model. */
export const normalizeLocalCopilotSettings = (
  input: LocalCopilotSettingsInput
): LocalCopilotSettings => ({
  contextWindow: inRange(input.copilotContextWindow, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW)
    ? Math.floor(input.copilotContextWindow)
    : DEFAULT_LOCAL_CONTEXT_WINDOW,
  maxToolIterations: inRange(input.copilotMaxToolIterations, 1, MAX_TOOL_ITERATIONS_LIMIT)
    ? Math.floor(input.copilotMaxToolIterations)
    : DEFAULT_LOCAL_MAX_TOOL_ITERATIONS,
  ...(inRange(input.copilotTemperature, 0, MAX_TEMPERATURE)
    ? { temperature: input.copilotTemperature }
    : {}),
  enableThinking: input.copilotEnableThinking === true,
})

export async function resolveLocalCopilotSettings(): Promise<LocalCopilotSettings> {
  try {
    return normalizeLocalCopilotSettings(
      (await resolveVllmServiceConfig()) as LocalCopilotSettingsInput
    )
  } catch (error) {
    logger.warn('Could not read local Copilot settings; using defaults', { error })
    return normalizeLocalCopilotSettings({})
  }
}

/** The extra request fields the settings add to a chat completion. */
export const buildLocalCopilotSamplingOptions = (
  settings: LocalCopilotSettings
): Record<string, unknown> => ({
  ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
  ...(settings.enableThinking ? { chat_template_kwargs: { enable_thinking: true } } : {}),
})
