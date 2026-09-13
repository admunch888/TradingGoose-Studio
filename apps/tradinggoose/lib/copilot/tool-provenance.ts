/**
 * Tool-execution provenance derived from a turn's chat contexts - the single
 * source of truth for "which entity is open" during a turn.
 *
 * The managed client derives it from the very contexts it is about to send
 * (stores/copilot/store.ts `sendMessage` -> `buildTurnProvenanceFromContexts`)
 * and hands the result to `/api/copilot/execute-copilot-server-tool` as
 * `contextEntityKind`/`contextEntityId`. The local runtime executes server tools
 * in-process, so `app/api/copilot/chat/route.ts` derives the same provenance
 * from the same contexts with this same function.
 *
 * Deliberately NOT under `stores/` and free of `'use client'`: server code has
 * to be able to call it. `stores/copilot/store-provenance.ts` re-exports it
 * unchanged for the client, so both runtimes share one implementation.
 */
import type { ReviewEntityKind } from '@/lib/copilot/review-sessions/types'
import { readCopilotWorkspaceEntityContext } from '@/lib/copilot/workspace-entities'
import { normalizeOptionalString } from '@/lib/utils'
import type { ChatContext, CopilotToolExecutionProvenance } from '@/stores/copilot/types'

type ContextTurnProvenance = {
  workspaceId?: string
  contextEntityKind?: ReviewEntityKind
  contextEntityId?: string
  ownerUserId?: string
  explicit: boolean
}

function applyContextTurnProvenance(
  provenance: CopilotToolExecutionProvenance,
  context: ContextTurnProvenance
): boolean {
  const { explicit } = context
  if (context.workspaceId && (explicit || !provenance.workspaceId)) {
    provenance.workspaceId = context.workspaceId
  }
  if (
    context.contextEntityKind &&
    context.contextEntityKind !== 'dashboard_layout' &&
    context.contextEntityId &&
    !provenance.contextEntityId
  ) {
    provenance.contextEntityKind = context.contextEntityKind
    provenance.contextEntityId = context.contextEntityId
  }

  return Boolean(context.workspaceId || context.contextEntityId)
}

function readDashboardLayoutContext(
  context: ContextTurnProvenance
): CopilotToolExecutionProvenance['dashboardLayoutContext'] | null {
  if (context.contextEntityKind !== 'dashboard_layout') return null
  if (!context.contextEntityId || !context.workspaceId || !context.ownerUserId) return null

  return {
    entityId: context.contextEntityId,
    workspaceId: context.workspaceId,
    ownerUserId: context.ownerUserId,
  }
}

function getContextTurnProvenance(context: ChatContext): ContextTurnProvenance | null {
  const entityContext = readCopilotWorkspaceEntityContext(context)
  if (!entityContext) {
    return null
  }

  return {
    workspaceId: normalizeOptionalString(entityContext.workspaceId),
    contextEntityKind: entityContext.entityKind,
    contextEntityId: normalizeOptionalString(entityContext.entityId),
    ownerUserId: normalizeOptionalString(entityContext.ownerUserId),
    explicit: !entityContext.current,
  }
}

export function buildTurnProvenanceFromContexts(
  contexts: ChatContext[] | undefined,
  workspaceId: string | null | undefined
): CopilotToolExecutionProvenance | undefined {
  const normalizedWorkspaceId = normalizeOptionalString(workspaceId)
  const provenance: CopilotToolExecutionProvenance = {
    ...(normalizedWorkspaceId ? { workspaceId: normalizedWorkspaceId } : {}),
  }
  let hasContext = !!normalizedWorkspaceId

  for (const context of contexts ?? []) {
    const entityContext = getContextTurnProvenance(context)
    if (entityContext) {
      const dashboardLayoutContext = readDashboardLayoutContext(entityContext)
      if (dashboardLayoutContext && !provenance.dashboardLayoutContext) {
        provenance.dashboardLayoutContext = dashboardLayoutContext
      }
      hasContext = applyContextTurnProvenance(provenance, entityContext) || hasContext
    }
  }

  return hasContext ? provenance : undefined
}
