import { isCopilotLocalRuntimeModel } from '@/lib/copilot/local-runtime/runtime-models'

/**
 * The `data` a browser-executed tool reports to /api/copilot/tools/mark-complete.
 *
 * The route only resumes a self-hosted model's turn when `data` carries
 * `local: true` and the `reviewSessionId` the turn belongs to (plus, optionally,
 * the open entity so edit tools keep their target). No client code added them,
 * so every local turn that reached a browser tool - `plan`, `run_workflow`,
 * `deploy_workflow` - ended there: Copilot showed "Finished planning" and never
 * built anything. Hosted turns are unchanged.
 */
export function buildToolCompletionData({
  data,
  selectedModel,
  reviewSessionId,
  contextEntityKind,
  contextEntityId,
}: {
  data: unknown
  selectedModel?: string | null
  reviewSessionId?: string | null
  contextEntityKind?: string
  contextEntityId?: string
}): unknown {
  if (!selectedModel || !isCopilotLocalRuntimeModel(selectedModel) || !reviewSessionId) {
    return data
  }

  const envelope = {
    local: true,
    reviewSessionId,
    ...(contextEntityKind && contextEntityId ? { contextEntityKind, contextEntityId } : {}),
  }

  if (data === undefined || data === null) return envelope
  if (typeof data === 'object' && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), ...envelope }
  }
  return { result: data, ...envelope }
}
