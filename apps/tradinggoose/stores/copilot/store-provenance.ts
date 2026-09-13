'use client'

import { DASHBOARD_LAYOUT_TOOL_NAMES } from '@/lib/copilot/registry'
import type {
  CopilotMessage,
  CopilotToolCall,
  CopilotToolExecutionProvenance,
} from '@/stores/copilot/types'

/**
 * Re-exported from `lib/copilot/tool-provenance` so the client store and the
 * server-side local runtime share ONE implementation of "which entity is open"
 * (the local runtime executes server tools in-process, so it derives the
 * provenance from the same contexts the client sends).
 */
export { buildTurnProvenanceFromContexts } from '@/lib/copilot/tool-provenance'

export function withPinnedToolExecutionProvenance(
  toolCall: CopilotToolCall,
  baseProvenance?: CopilotToolExecutionProvenance
): CopilotToolCall {
  if (!toolCall.provenance && !baseProvenance) {
    return toolCall
  }

  const dashboardLayoutContext =
    toolCall.provenance?.dashboardLayoutContext ?? baseProvenance?.dashboardLayoutContext
  const { dashboardLayoutContext: _baseDashboardLayoutContext, ...baseProvenanceRest } =
    baseProvenance ?? {}
  const { dashboardLayoutContext: _toolDashboardLayoutContext, ...toolProvenanceRest } =
    toolCall.provenance ?? {}
  const mergedProvenance = {
    ...baseProvenanceRest,
    ...toolProvenanceRest,
  }

  if (dashboardLayoutContext && DASHBOARD_LAYOUT_TOOL_NAMES.has(toolCall.name)) {
    mergedProvenance.contextEntityKind = 'dashboard_layout'
    mergedProvenance.contextEntityId = dashboardLayoutContext.entityId
    mergedProvenance.workspaceId = dashboardLayoutContext.workspaceId
  }

  return {
    ...toolCall,
    provenance: mergedProvenance,
  }
}

export function findAssistantMessageIdForToolCall(
  messages: CopilotMessage[],
  toolCallId: string
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue

    if (
      Array.isArray(message.contentBlocks) &&
      message.contentBlocks.some(
        (block) => block.type === 'tool_call' && block.toolCall?.id === toolCallId
      )
    ) {
      return message.id
    }
  }

  return null
}
