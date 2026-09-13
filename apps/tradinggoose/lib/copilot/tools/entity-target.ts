import type { ReviewEntityKind } from '@/lib/copilot/review-sessions/types'
import { normalizeOptionalString } from '@/lib/utils'

export type CopilotEntityTargetArgs = {
  entityId?: string | null
}

export type CopilotEntityExecutionContext = {
  contextEntityKind?: ReviewEntityKind | null
  contextEntityId?: string | null
}

export function resolveOptionalCopilotEntityId(
  args: CopilotEntityTargetArgs | null | undefined
): string | undefined {
  return normalizeOptionalString(args?.entityId)
}

export function requireCopilotEntityId(
  args: CopilotEntityTargetArgs | null | undefined,
  options?: {
    toolName?: string
    /**
     * Execution context to fall back to when the model supplied no id (the
     * local runtime's in-process tools, and the managed runtime's
     * `/api/copilot/execute-copilot-server-tool` route, both carry the open
     * entity there). Only consulted together with `entityKind`, and only when
     * the context's entity kind matches it: an id belonging to another kind must
     * never be used to target this tool's entity.
     */
    context?: CopilotEntityExecutionContext | null
    entityKind?: ReviewEntityKind
  }
): string {
  const entityId =
    resolveOptionalCopilotEntityId(args) ??
    (options?.entityKind
      ? resolveCopilotContextEntityId(options.context, options.entityKind)
      : undefined)
  if (entityId) {
    return entityId
  }

  throw new Error(
    options?.toolName ? `entityId is required for ${options.toolName}` : 'entityId is required'
  )
}

export function resolveCopilotContextEntityId(
  context: CopilotEntityExecutionContext | null | undefined,
  entityKind: ReviewEntityKind
): string | undefined {
  if (context?.contextEntityKind !== entityKind) {
    return undefined
  }

  return normalizeOptionalString(context.contextEntityId)
}
