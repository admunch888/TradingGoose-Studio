import { describe, expect, it } from 'vitest'
import { buildContextDerivedToolArgs } from '@/lib/copilot/tools/server/context-entity-targets'

const WORKFLOW_CONTEXT = {
  userId: 'user-1',
  accessLevel: 'full' as const,
  contextEntityKind: 'workflow' as const,
  contextEntityId: 'wf-open',
  workspaceId: 'workspace-1',
}

describe('buildContextDerivedToolArgs', () => {
  /**
   * The arg schema marks `entityId` required (registry.ts EntityTargetArgs), so
   * without this injection a model that omits the id never reaches the tool's
   * own context fallback - validation rejects the call first.
   */
  it('fills the open entity id for a tool that targets that entity kind', () => {
    expect(
      buildContextDerivedToolArgs('edit_workflow', { entityDocument: 'flowchart TD' }, WORKFLOW_CONTEXT)
    ).toEqual({ workspaceId: 'workspace-1', entityId: 'wf-open' })
  })

  it('keeps an explicit entity id', () => {
    expect(
      buildContextDerivedToolArgs(
        'edit_workflow',
        { entityId: 'wf-explicit', entityDocument: 'flowchart TD' },
        WORKFLOW_CONTEXT
      )
    ).toEqual({ workspaceId: 'workspace-1' })

    expect(
      buildContextDerivedToolArgs(
        'edit_workflow',
        { entityId: '   ', entityDocument: 'flowchart TD' },
        WORKFLOW_CONTEXT
      )
    ).toEqual({ workspaceId: 'workspace-1', entityId: 'wf-open' })
  })

  /**
   * Safety: an id from a context of another kind must never be handed over as
   * this tool's target, or an edit lands on a workflow the user never opened
   * (the tool would fail its kind-scoped access check, but with a confusing
   * access-denied instead of the clear "entityId is required").
   */
  it('never crosses entity kinds', () => {
    expect(
      buildContextDerivedToolArgs('edit_workflow', {}, { ...WORKFLOW_CONTEXT, contextEntityKind: 'watchlist' })
    ).toEqual({ workspaceId: 'workspace-1' })
  })

  it('leaves tools that do not target the open entity alone', () => {
    expect(buildContextDerivedToolArgs('read_workflow', {}, WORKFLOW_CONTEXT)).toEqual({
      workspaceId: 'workspace-1',
    })
  })

  it('derives nothing without a context', () => {
    expect(buildContextDerivedToolArgs('edit_workflow', {}, undefined)).toEqual({})
    expect(
      buildContextDerivedToolArgs('edit_workflow', {}, { userId: 'user-1', accessLevel: 'full' })
    ).toEqual({})
  })

  it('keeps the existing rule that only plain object payloads are augmented', () => {
    expect(buildContextDerivedToolArgs('edit_workflow', ['a'], WORKFLOW_CONTEXT)).toEqual({})
  })
})
