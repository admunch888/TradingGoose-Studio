/**
 * `requireCopilotEntityId` is the guard every workflow-targeted server tool runs
 * before it touches an entity. It now also resolves the id from the execution
 * context (the local runtime supplies the open workflow there; the managed
 * runtime supplies it from the client's tool provenance), and that fallback has
 * to be kind-gated: an id from a context of another kind must never become a
 * tool's target, and no context at all must keep the pre-existing clear error.
 *
 * edit_workflow, edit_workflow_block and read_workflow_logs all call it with
 * ENTITY_KIND_WORKFLOW; the block/log suites cannot load in this environment
 * (their import graph reaches @tradinggoose/db + lib/auth without env), so the
 * shared contract is pinned here.
 */
import { describe, expect, it } from 'vitest'
import { requireCopilotEntityId } from '@/lib/copilot/tools/entity-target'
import { ENTITY_KIND_WORKFLOW } from '@/lib/copilot/review-sessions/types'

const context = {
  contextEntityKind: ENTITY_KIND_WORKFLOW,
  contextEntityId: 'wf-open',
} as const

describe('requireCopilotEntityId', () => {
  it('prefers the id the model supplied', () => {
    expect(
      requireCopilotEntityId(
        { entityId: 'wf-explicit' },
        { toolName: 'edit_workflow', context, entityKind: ENTITY_KIND_WORKFLOW }
      )
    ).toBe('wf-explicit')
  })

  it('falls back to the open entity in the execution context', () => {
    expect(
      requireCopilotEntityId(
        {},
        { toolName: 'edit_workflow', context, entityKind: ENTITY_KIND_WORKFLOW }
      )
    ).toBe('wf-open')
  })

  it('treats a blank id as absent', () => {
    expect(
      requireCopilotEntityId(
        { entityId: '   ' },
        { toolName: 'edit_workflow', context, entityKind: ENTITY_KIND_WORKFLOW }
      )
    ).toBe('wf-open')
  })

  it('never takes the id from a different entity kind', () => {
    expect(() =>
      requireCopilotEntityId(
        {},
        {
          toolName: 'edit_workflow',
          context: { contextEntityKind: 'watchlist', contextEntityId: 'watchlist-1' },
          entityKind: ENTITY_KIND_WORKFLOW,
        }
      )
    ).toThrow('entityId is required for edit_workflow')
  })

  it('keeps the pre-existing error when there is no context at all', () => {
    expect(() => requireCopilotEntityId({}, { toolName: 'edit_workflow' })).toThrow(
      'entityId is required for edit_workflow'
    )
    expect(() =>
      requireCopilotEntityId({}, { toolName: 'edit_workflow', context: {}, entityKind: ENTITY_KIND_WORKFLOW })
    ).toThrow('entityId is required for edit_workflow')
    expect(() => requireCopilotEntityId({})).toThrow('entityId is required')
  })
})
