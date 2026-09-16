/**
 * These are drawn from a workflow that a model edited outside the app: it
 * imported cleanly, passed every shape check, and would have run every day with
 * its Journal block silently never executing, because the edit that wired the
 * condition branches left nothing pointing at it.
 */
import { describe, expect, it } from 'vitest'
import { checkWorkflowGraphIntegrity, type WorkflowGraph } from '@/lib/workflows/graph-integrity'

const TRIGGER_TYPES = new Set(['manual_trigger', 'schedule'])
const isTrigger = (block: { type?: string }) => TRIGGER_TYPES.has(block.type ?? '')

const check = (graph: WorkflowGraph) => checkWorkflowGraphIntegrity(graph, { isTrigger })

const edge = (source: string, target: string, sourceHandle?: string) => ({
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
})

/** trigger -> guard, guard branches to journal (if) and answer (else). */
const guardGraph = (): WorkflowGraph => ({
  blocks: {
    start: { type: 'manual_trigger', name: 'Manual' },
    guard: {
      type: 'condition',
      name: 'Guard',
      subBlocks: {
        conditions: {
          value: [
            { id: 'guard-if', title: 'if' },
            { id: 'guard-else', title: 'else' },
          ],
        },
      },
    },
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

describe('a sound graph', () => {
  it('reports nothing', () => {
    expect(check(guardGraph())).toEqual({ errors: [], warnings: [] })
  })
})

describe('a block no trigger reaches', () => {
  it('is an error, because nothing else would ever say so', () => {
    const graph = guardGraph()
    // Exactly the real fault: the branch edge into Journal is missing, so it
    // keeps its outgoing edge and looks connected in the file.
    graph.edges = graph.edges.filter((e) => e.target !== 'journal')

    const { errors } = check(graph)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"Journal" (journal)')
    expect(errors[0]).toContain('never run')
  })

  it('is not reported for a block the operator disabled', () => {
    const graph = guardGraph()
    graph.edges = graph.edges.filter((e) => e.target !== 'journal')
    graph.blocks.journal.enabled = false

    expect(check(graph).errors).toEqual([])
  })

  it('is not reported for a block inside a reachable container', () => {
    // A loop's children are reached through the container, not by an edge.
    const graph = guardGraph()
    graph.blocks.loop = { type: 'loop', name: 'Loop' }
    graph.blocks.inner = { type: 'function', name: 'Inner', data: { parentId: 'loop' } }
    graph.edges.push(edge('answer', 'loop'))

    expect(check(graph).errors).toEqual([])
  })

  it('still reports a container that is itself unreachable', () => {
    const graph = guardGraph()
    graph.blocks.loop = { type: 'loop', name: 'Loop' }
    graph.blocks.inner = { type: 'function', name: 'Inner', data: { parentId: 'loop' } }

    const names = check(graph).errors.join(' ')
    expect(names).toContain('"Loop" (loop)')
    expect(names).toContain('"Inner" (inner)')
  })
})

describe('condition branches', () => {
  it('rejects an edge leaving a branch the block never declared', () => {
    const graph = guardGraph()
    graph.edges = graph.edges.map((e) =>
      e.sourceHandle === 'condition-guard-else'
        ? { ...e, sourceHandle: 'condition-guard-else-if' }
        : e
    )

    const { errors } = check(graph)
    expect(errors[0]).toContain('condition-guard-else-if')
    expect(errors[0]).toContain('condition-guard-if, condition-guard-else')
  })

  it('reads conditions that were stored double-encoded as a JSON string', () => {
    // Seen in the wild; the branches are declared, just wrapped in a string.
    const graph = guardGraph()
    graph.blocks.guard.subBlocks = {
      conditions: {
        value: JSON.stringify([
          { id: 'guard-if', title: 'if' },
          { id: 'guard-else', title: 'else' },
        ]),
      },
    }

    expect(check(graph).errors).toEqual([])
  })

  it('rejects a condition edge from a block that declares nothing', () => {
    const graph = guardGraph()
    graph.blocks.guard.subBlocks = {}

    expect(check(graph).errors[0]).toContain('declares no conditions')
  })
})

describe('edges pointing at nothing', () => {
  it('names the end that is wrong', () => {
    const graph = guardGraph()
    graph.edges.push(edge('answer', 'ghost'))

    expect(check(graph).errors[0]).toContain('target "ghost"')
  })
})

describe('warnings', () => {
  it('mentions a branch that ends without reaching a response', () => {
    const graph = guardGraph()
    graph.edges = graph.edges.filter((e) => e.source !== 'journal')

    const { errors, warnings } = check(graph)
    expect(errors).toEqual([])
    expect(warnings[0]).toContain('"Journal" (journal)')
  })

  it('says so when nothing can start the workflow', () => {
    const graph = guardGraph()
    graph.blocks.start.type = 'function'

    expect(check(graph).warnings).toContain(
      'This workflow has no trigger block, so nothing can start it.'
    )
  })
})
