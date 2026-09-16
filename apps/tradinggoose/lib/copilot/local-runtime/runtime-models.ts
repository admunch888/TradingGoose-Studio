export const LOCAL_COPILOT_MODEL_PREFIX = 'vllm/'

/**
 * Models the Copilot runs in process, with server tool-calling, rather than
 * handing to a remote Copilot service.
 *
 * Membership is by prefix, not by an enumerated list, so a model newly served by
 * the endpoint works without an app rebuild. The picker gets its list from
 * `useCopilotLocalModels` (hooks/queries/providers.ts), which asks the Copilot's
 * own endpoint - it may be a different host than the Agent blocks use.
 */
export function isCopilotLocalRuntimeModel(model: string): boolean {
  return typeof model === 'string' && model.startsWith(LOCAL_COPILOT_MODEL_PREFIX)
}
