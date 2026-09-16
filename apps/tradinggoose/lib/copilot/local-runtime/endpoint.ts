/**
 * Which OpenAI-compatible endpoint the Copilot talks to.
 *
 * The Copilot and the Agent blocks used to share one `baseUrl`, so pointing the
 * Copilot at a hosted provider silently repointed every Agent block too. A
 * workflow whose Agent runs `vllm/qwen3.8-fp8` would then send that model name
 * to a host that has never heard of it, and fail mid-run - after its gates had
 * passed - with nothing in pre-flight to catch it.
 *
 * So the Copilot may carry its own endpoint, and falls back to the shared one
 * when it does not. Leaving the Copilot fields empty keeps the previous
 * behaviour exactly.
 */

/** Nullable because the service resolver reads absent settings as null. */
export interface VllmEndpointConfig {
  baseUrl?: string | null
  apiKey?: string | null
  copilotBaseUrl?: string | null
  copilotApiKey?: string | null
}

export interface ResolvedEndpoint {
  baseUrl: string
  apiKey: string
  /** True when the Copilot is pointed somewhere the Agent blocks are not. */
  isCopilotOverride: boolean
}

const clean = (value: string | null | undefined): string => (value ?? '').trim().replace(/\/$/, '')

/**
 * The endpoint for Copilot traffic.
 *
 * The key follows the URL it belongs to: a Copilot base URL with no Copilot key
 * must not silently borrow the shared endpoint's key, which is for a different
 * host and would leak it there.
 */
export const resolveCopilotEndpoint = (config: VllmEndpointConfig): ResolvedEndpoint | null => {
  const copilotBaseUrl = clean(config.copilotBaseUrl)
  if (copilotBaseUrl) {
    return {
      baseUrl: copilotBaseUrl,
      apiKey: (config.copilotApiKey ?? '').trim(),
      isCopilotOverride: true,
    }
  }

  const baseUrl = clean(config.baseUrl)
  if (!baseUrl) return null

  return { baseUrl, apiKey: (config.apiKey ?? '').trim(), isCopilotOverride: false }
}
