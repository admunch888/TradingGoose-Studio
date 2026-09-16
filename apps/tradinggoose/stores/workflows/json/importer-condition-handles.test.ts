/**
 * Import renumbers every block to a fresh UUID. Anything that names a block by
 * id has to be renumbered with it, and `sourceHandle` was not.
 *
 * The result imported cleanly and then would not open in the editor: the edges
 * leaving a condition block pointed at `condition-<oldId>-<branch>`, a block id
 * that no longer existed anywhere in the workflow. Only workflows containing a
 * condition block were affected, which is why it went unnoticed.
 */
import { describe, expect, it } from 'vitest'
import { parseWorkflowJson } from '@/stores/workflows/json/importer'

/** The stored value is the entries array, or a JSON string holding one. */
const readEntries = (value: unknown): Array<{ id: string }> =>
  typeof value === 'string' ? JSON.parse(value) : (value as Array<{ id: string }>)

const conditionWorkflow = (conditionsValue: unknown) => ({
  version: '1',
  fileType: 'tradingGooseExport',
  exportedAt: '2026-09-16T00:00:00.000Z',
  exportedFrom: 'workflowEditor',
  resourceTypes: ['workflows'],
  workflows: [
    {
      name: 'guarded',
      description: '',
      state: {
        blocks: {
          start: {
            id: 'start',
            type: 'manual_trigger',
            name: 'Manual',
            position: { x: 0, y: 0 },
            subBlocks: {},
          },
          guard: {
            id: 'guard',
            type: 'condition',
            name: 'Guard',
            position: { x: 200, y: 0 },
            subBlocks: { conditions: { id: 'conditions', value: conditionsValue } },
          },
          answer: {
            id: 'answer',
            type: 'response',
            name: 'Answer',
            position: { x: 400, y: 0 },
            subBlocks: {},
          },
        },
        edges: [
          { id: 'e1', source: 'start', target: 'guard', type: 'default', data: {} },
          {
            id: 'e2',
            source: 'guard',
            target: 'answer',
            sourceHandle: 'condition-guard-if',
            type: 'default',
            data: {},
          },
          {
            id: 'e3',
            source: 'guard',
            target: 'answer',
            sourceHandle: 'condition-guard-else-if-1752111795510',
            type: 'default',
            data: {},
          },
        ],
        loops: {},
        parallels: {},
        variables: {},
      },
    },
  ],
  skills: [],
  customTools: [],
  watchlists: [],
  indicators: [],
})

const entries = [
  { id: 'guard-if', title: 'if', value: 'x > 1' },
  { id: 'guard-else-if-1752111795510', title: 'else if', value: 'x > 0' },
]

const importState = (conditionsValue: unknown) => {
  const { data, errors } = parseWorkflowJson(
    JSON.stringify(conditionWorkflow(conditionsValue)),
    true
  )
  if (!data) throw new Error(`import failed: ${errors.join(', ')}`)
  return data.state
}

describe('renumbering a workflow that has a condition block', () => {
  it('moves the branch handle onto the block it now belongs to', () => {
    const state = importState(entries)

    const guardId = Object.keys(state.blocks).find((id) => state.blocks[id].type === 'condition')
    const handles = state.edges
      .map((edge) => edge.sourceHandle)
      .filter((handle): handle is string => Boolean(handle))

    expect(handles).toHaveLength(2)
    for (const handle of handles) {
      expect(handle.startsWith(`condition-${guardId}-`)).toBe(true)
      // The old id must be gone entirely, not merely present alongside the new.
      expect(handle).not.toContain('guard-')
    }
  })

  it('keeps the branch key intact, dashes and all', () => {
    const state = importState(entries)

    const handles = state.edges.map((edge) => edge.sourceHandle).filter(Boolean) as string[]
    expect(handles.some((handle) => handle.endsWith('-if'))).toBe(true)
    expect(handles.some((handle) => handle.endsWith('-else-if-1752111795510'))).toBe(true)
  })

  it('renumbers the declared branches to match', () => {
    const state = importState(entries)

    const guardId = Object.keys(state.blocks).find((id) => state.blocks[id].type === 'condition')
    const declared = readEntries(state.blocks[guardId as string].subBlocks.conditions.value)

    expect(declared.map((entry) => entry.id)).toEqual([
      `${guardId}-if`,
      `${guardId}-else-if-1752111795510`,
    ])
  })

  it('leaves every edge naming a branch the block declares', () => {
    // The two halves agreeing is the whole point: this is what the editor reads.
    const state = importState(entries)

    const guardId = Object.keys(state.blocks).find((id) => state.blocks[id].type === 'condition')
    const declared = new Set(
      readEntries(state.blocks[guardId as string].subBlocks.conditions.value).map(
        (entry) => `condition-${entry.id}`
      )
    )

    for (const edge of state.edges) {
      if (!edge.sourceHandle?.startsWith('condition-')) continue
      expect(declared.has(edge.sourceHandle)).toBe(true)
    }
  })

  it('handles a conditions value that was stored double-encoded', () => {
    const state = importState(JSON.stringify(entries))

    const guardId = Object.keys(state.blocks).find((id) => state.blocks[id].type === 'condition')
    const raw = state.blocks[guardId as string].subBlocks.conditions.value

    // The shape it arrived in is preserved; only the ids move.
    expect(typeof raw).toBe('string')
    expect(JSON.parse(raw as string).map((entry: { id: string }) => entry.id)).toEqual([
      `${guardId}-if`,
      `${guardId}-else-if-1752111795510`,
    ])
  })

  it('leaves a conditions value it cannot parse exactly as it was', () => {
    // Without condition edges, since a block whose branches are unreadable and
    // which still has edges leaving them is refused before renumbering - by the
    // check added with the graph validation, not by this code.
    const file = conditionWorkflow('not json at all')
    file.workflows[0].state.edges = file.workflows[0].state.edges.filter(
      (edge) => !('sourceHandle' in edge)
    )

    const { data, errors } = parseWorkflowJson(JSON.stringify(file), true)
    if (!data) throw new Error(`import failed: ${errors.join(', ')}`)

    const guardId = Object.keys(data.state.blocks).find(
      (id) => data.state.blocks[id].type === 'condition'
    )
    expect(data.state.blocks[guardId as string].subBlocks.conditions.value).toBe('not json at all')
  })

  it('refuses a file whose branches are unreadable but still have edges', () => {
    const { data, errors } = parseWorkflowJson(JSON.stringify(conditionWorkflow('not json')), true)

    expect(data).toBeNull()
    expect(errors[0]).toContain('declares no conditions')
  })
})

describe('non-condition edges', () => {
  it('are untouched by the renumbering', () => {
    const state = importState(entries)

    const plain = state.edges.find((edge) => !edge.sourceHandle)
    expect(plain).toBeDefined()
    expect(plain?.sourceHandle).toBeUndefined()
  })
})
