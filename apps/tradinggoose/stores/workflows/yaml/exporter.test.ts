/**
 * The exporter is only correct if the importer beside it reads back what it
 * wrote, so most of these round-trip through the real importer rather than
 * asserting on YAML text. Asserting on the text would pin my reading of the
 * format; round-tripping pins the format itself.
 */
import { describe, expect, it } from 'vitest'
import {
  type ExportableWorkflowState,
  exportWorkflowAsYaml,
  findMismatchedConditionEdges,
} from '@/stores/workflows/yaml/exporter'
import { convertYamlToWorkflow, parseWorkflowYaml } from '@/stores/workflows/yaml/importer'

const edge = (source: string, target: string, sourceHandle?: string) => ({
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
})

/** trigger -> guard, guard branching to journal (if) and answer (else). */
const guardWorkflow = (): ExportableWorkflowState => ({
  blocks: {
    start: { type: 'manual_trigger', name: 'Manual' },
    guard: { type: 'condition', name: 'Guard' },
    journal: { type: 'function', name: 'Journal' },
    answer: { type: 'response', name: 'Answer' },
  },
  edges: [
    edge('start', 'guard'),
    edge('guard', 'journal', 'condition-guard-if'),
    edge('guard', 'answer', 'condition-guard-else'),
    edge('journal', 'answer'),
  ],
})

/** Re-import exported YAML and describe the graph by block name, not by id. */
const roundTrip = (state: ExportableWorkflowState, subBlockValues = {}) => {
  const yaml = exportWorkflowAsYaml(state, subBlockValues)
  const parsed = parseWorkflowYaml(yaml)
  if (!parsed.data) throw new Error(`export produced unparseable YAML: ${parsed.errors.join(', ')}`)
  const result = convertYamlToWorkflow(parsed.data)
  const nameById = new Map(result.blocks.map((block) => [block.id, block.name]))
  return {
    ...result,
    yaml,
    connections: result.edges
      .map(
        (e) =>
          `${nameById.get(e.source)} -${e.sourceHandle && e.sourceHandle !== 'source' ? `[${e.sourceHandle?.replace(/^condition-[^-]+-/, 'if:')}]` : ''}-> ${nameById.get(e.target)}`
      )
      .sort(),
    names: result.blocks.map((block) => block.name).sort(),
  }
}

describe('a workflow survives the round trip', () => {
  it('keeps every block', () => {
    const { names, errors } = roundTrip(guardWorkflow())

    expect(errors).toEqual([])
    expect(names).toEqual(['Answer', 'Guard', 'Journal', 'Manual'])
  })

  it('keeps every connection, including both condition branches', () => {
    const { edges } = roundTrip(guardWorkflow())

    expect(edges).toHaveLength(4)
    const conditionHandles = edges
      .map((e) => e.sourceHandle)
      .filter((handle): handle is string => Boolean(handle?.startsWith('condition-')))
    expect(conditionHandles).toHaveLength(2)
  })

  it('carries block settings through', () => {
    const { blocks } = roundTrip(guardWorkflow(), {
      guard: { conditions: [{ id: 'guard-if', title: 'if', value: 'x > 1' }] },
      journal: { code: 'const agent = <agent.content>;' },
    })

    const journal = blocks.find((block) => block.name === 'Journal')
    expect(journal?.inputs.code).toBe('const agent = <agent.content>;')
  })
})

describe('the connection shapes the importer understands', () => {
  it('writes a plain edge as success', () => {
    const yaml = exportWorkflowAsYaml(guardWorkflow())
    expect(yaml).toContain('success: guard')
  })

  it('writes condition branches under their own keys', () => {
    const yaml = exportWorkflowAsYaml(guardWorkflow())
    expect(yaml).toContain('conditions:')
    expect(yaml).toContain('if: journal')
    expect(yaml).toContain('else: answer')
  })

  it('writes an error handle as error', () => {
    const state = guardWorkflow()
    state.edges.push(edge('journal', 'answer', 'error'))
    expect(exportWorkflowAsYaml(state)).toContain('error: answer')
  })

  it.each([
    ['loop-start-source', 'loop', 'start'],
    ['loop-end-source', 'loop', 'end'],
    ['parallel-start-source', 'parallel', 'start'],
    ['parallel-end-source', 'parallel', 'end'],
  ])('nests %s under %s.%s', (handle, group, end) => {
    const state: ExportableWorkflowState = {
      blocks: {
        container: { type: group, name: 'Container' },
        inner: { type: 'function', name: 'Inner' },
      },
      edges: [edge('container', 'inner', handle)],
    }

    const yaml = exportWorkflowAsYaml(state)
    expect(yaml).toContain(`${group}:`)
    expect(yaml).toContain(`${end}: inner`)
  })

  it('groups several targets on one handle into a list', () => {
    const state = guardWorkflow()
    state.edges.push(edge('start', 'journal'))

    const yaml = exportWorkflowAsYaml(state)
    expect(yaml).toMatch(/success:\n\s+- guard\n\s+- journal/)
  })
})

describe('nesting', () => {
  it('keeps a child pointed at its container', () => {
    const state: ExportableWorkflowState = {
      blocks: {
        start: { type: 'manual_trigger', name: 'Manual' },
        loop: { type: 'loop', name: 'Loop' },
        inner: { type: 'function', name: 'Inner', data: { parentId: 'loop' } },
      },
      edges: [edge('start', 'loop'), edge('loop', 'inner', 'loop-start-source')],
    }

    const { blocks, yaml } = roundTrip(state)
    expect(yaml).toContain('parentId: loop')

    const loopId = blocks.find((block) => block.name === 'Loop')?.id
    const inner = blocks.find((block) => block.name === 'Inner')
    expect(inner?.parentId).toBe(loopId)
  })
})

describe('a condition handle naming another block', () => {
  const crossed = (): ExportableWorkflowState => {
    const state = guardWorkflow()
    state.edges.push(edge('journal', 'answer', 'condition-guard-if'))
    return state
  }

  it('is reported rather than written out', () => {
    // Emitting it as a plain connection would quietly move the edge onto the
    // block's default output, which is a silent change of topology.
    expect(findMismatchedConditionEdges(crossed())).toEqual([
      'journal -> answer (condition-guard-if)',
    ])
  })

  it('does not silently become an extra connection on the wrong block', () => {
    // Journal already has one legitimate edge to Answer. If the mismatched
    // handle were written out as a plain connection, Journal would leave with
    // two, and the graph would have changed shape without anyone being told.
    const { blocks, edges } = roundTrip(crossed())
    const journalId = blocks.find((block) => block.name === 'Journal')?.id

    expect(edges.filter((e) => e.source === journalId)).toHaveLength(1)
  })

  it('reports nothing for a sound workflow', () => {
    expect(findMismatchedConditionEdges(guardWorkflow())).toEqual([])
  })
})
