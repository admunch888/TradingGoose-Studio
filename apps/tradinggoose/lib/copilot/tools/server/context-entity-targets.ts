import { CopilotTool } from '@/lib/copilot/registry'
import { ENTITY_KIND_WORKFLOW, type ReviewEntityKind } from '@/lib/copilot/review-sessions/types'
import type { ServerToolExecutionContext } from '@/lib/copilot/tools/server/base-tool'

/**
 * Server tools whose target is the turn's OPEN entity, and whose arg schema
 * still marks that id required. When the model omits the id, the router injects
 * the execution context's entity id before validation (see
 * `buildContextDerivedToolArgs` in router.ts) so the tool's own
 * `requireCopilotEntityId` can resolve it from the same context.
 *
 * Explicit and kind-gated on purpose: an id from a context of a DIFFERENT kind
 * must never be handed to a tool as its target, so an unmapped tool keeps
 * today's "entityId is required" failure instead of editing a guessed entity.
 * Small local models are exactly the ones that drop the discover-then-echo
 * chain, and pointing them at the wrong workflow is worse than failing.
 */
export const SERVER_TOOL_CONTEXT_ENTITY_KIND: Partial<Record<string, ReviewEntityKind>> = {
  [CopilotTool.edit_workflow]: ENTITY_KIND_WORKFLOW,
  [CopilotTool.edit_workflow_block]: ENTITY_KIND_WORKFLOW,
  [CopilotTool.read_workflow_logs]: ENTITY_KIND_WORKFLOW,
}

/**
 * The context-derived arguments a tool may accept when its payload is missing
 * them: the context workspace, and the context entity id for the tools that
 * target that entity kind. Returns only fields the context actually supplies.
 */
export function buildContextDerivedToolArgs(
  toolName: string,
  payload: unknown,
  context?: ServerToolExecutionContext
): Record<string, unknown> {
  const isPlainPayload = !payload || (typeof payload === 'object' && !Array.isArray(payload))
  if (!isPlainPayload) {
    return {}
  }

  const args: Record<string, unknown> = {}
  const workspaceId = context?.workspaceId?.trim()
  if (workspaceId) {
    args.workspaceId = workspaceId
  }

  const contextEntityId = context?.contextEntityId?.trim()
  const contextEntityKind = context?.contextEntityKind
  if (
    contextEntityId &&
    contextEntityKind &&
    SERVER_TOOL_CONTEXT_ENTITY_KIND[toolName] === contextEntityKind
  ) {
    const existing = (payload as { entityId?: unknown } | null | undefined)?.entityId
    if (typeof existing !== 'string' || existing.trim().length === 0) {
      args.entityId = contextEntityId
    }
  }

  return args
}
