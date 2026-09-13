/**
 * The turn provenance the server derives from a request's contexts must be the
 * SAME value the managed client derives (stores/copilot/store.ts ->
 * buildTurnProvenanceFromContexts), because it is what tells the local runtime's
 * in-process server tools which workflow is open.
 */
import { describe, expect, it } from 'vitest'
import { buildTurnProvenanceFromContexts } from '@/lib/copilot/tool-provenance'

describe('buildTurnProvenanceFromContexts', () => {
  it('reads the open workflow from a workflow context', () => {
    expect(
      buildTurnProvenanceFromContexts(
        [{ kind: 'workflow', workflowId: 'wf-current', label: 'Current workflow' }],
        'workspace-1'
      )
    ).toMatchObject({
      workspaceId: 'workspace-1',
      contextEntityKind: 'workflow',
      contextEntityId: 'wf-current',
    })
  })

  it('keeps an explicit mention ahead of the implicit open entity', () => {
    expect(
      buildTurnProvenanceFromContexts(
        [
          { kind: 'workflow', workflowId: 'wf-implicit', label: 'Current workflow' },
          { kind: 'workflow', workflowId: 'wf-explicit', label: 'Attached workflow' },
        ],
        'workspace-1'
      )
    ).toMatchObject({ contextEntityKind: 'workflow', contextEntityId: 'wf-implicit' })
  })

  it('ignores contexts that name no entity', () => {
    expect(
      buildTurnProvenanceFromContexts([{ kind: 'docs', label: 'Docs' }], undefined)
    ).toBeUndefined()
  })

  it('does not present an owner-scoped layout as a generic entity target', () => {
    const provenance = buildTurnProvenanceFromContexts(
      [
        {
          kind: 'current_dashboard_layout',
          dashboardLayoutId: 'layout-1',
          workspaceId: 'workspace-1',
          ownerUserId: 'user-1',
          label: 'Layout',
        },
      ],
      undefined
    )

    expect(provenance?.contextEntityId).toBeUndefined()
    expect(provenance?.contextEntityKind).toBeUndefined()
  })
})
