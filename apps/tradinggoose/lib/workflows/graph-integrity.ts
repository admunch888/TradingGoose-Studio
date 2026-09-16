/**
 * Structural checks for an imported workflow graph.
 *
 * Shape validation (a block has an id, an edge has a source) does not catch the
 * failure that actually hurts: a workflow that imports cleanly, runs without
 * error, and silently never executes one of its blocks because nothing points at
 * it. Nothing reports that. It shows up later as a missing journal entry or a
 * branch that produced no response, long after the run.
 *
 * That risk arrives with editing workflow JSON outside the app - by hand, or with
 * an external agent - where there is no editor to refuse a broken edit.
 *
 * Errors are faults with no legitimate reading: an edge pointing at a block that
 * does not exist, a condition branch that was never declared, a block no trigger
 * can reach. Warnings are shapes that are usually wrong but can be deliberate.
 */

import { TriggerUtils } from '@/lib/workflows/triggers'

export interface GraphIntegrityResult {
  errors: string[]
  warnings: string[]
}

interface GraphBlock {
  type?: string
  name?: string
  enabled?: boolean
  triggerMode?: boolean
  data?: { parentId?: string | null } | null
  subBlocks?: Record<string, { value?: unknown } | undefined> | null
}

interface GraphEdge {
  source?: string
  target?: string
  sourceHandle?: string | null
}

export interface WorkflowGraph {
  blocks: Record<string, GraphBlock>
  edges: GraphEdge[]
}

const CONDITION_HANDLE_PREFIX = 'condition-'

/** How a block is named in a message: its name if it has one, else its id. */
const label = (blocks: Record<string, GraphBlock>, blockId: string): string => {
  const name = blocks[blockId]?.name
  return name ? `"${name}" (${blockId})` : `"${blockId}"`
}

/**
 * The branch ids a condition block declares.
 *
 * The stored value is normally the array of condition entries, but it has been
 * seen double-encoded as a JSON string holding that array, so both are read.
 * Returning null means "not a condition block, or nothing declared" - the caller
 * treats that differently from an empty list.
 */
const readConditionBranchIds = (block: GraphBlock | undefined): string[] | null => {
  const raw = block?.subBlocks?.conditions?.value
  if (raw === undefined || raw === null) return null

  let entries: unknown = raw
  if (typeof entries === 'string') {
    try {
      entries = JSON.parse(entries)
    } catch {
      return null
    }
  }
  if (!Array.isArray(entries)) return null

  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const id = (entry as { id?: unknown }).id
    return typeof id === 'string' && id !== '' ? [id] : []
  })
}

/**
 * Every block a trigger can actually reach.
 *
 * Edges are followed forwards, and a block nested in a container (a loop or
 * parallel) is reached through its parent rather than through an edge, so the
 * two rules are applied together until nothing new is found.
 */
const reachableFromTriggers = (
  blocks: Record<string, GraphBlock>,
  edges: GraphEdge[],
  isTrigger: (block: GraphBlock) => boolean
): Set<string> => {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    if (!edge.source || !edge.target) continue
    const targets = outgoing.get(edge.source)
    if (targets) {
      targets.push(edge.target)
      continue
    }
    outgoing.set(edge.source, [edge.target])
  }

  const reached = new Set<string>()
  const visit = (blockId: string) => {
    if (reached.has(blockId) || !blocks[blockId]) return
    reached.add(blockId)
    for (const target of outgoing.get(blockId) ?? []) visit(target)
  }

  for (const [blockId, block] of Object.entries(blocks)) {
    if (isTrigger(block)) visit(blockId)
  }

  // A container's children come along with it, and may lead on to further blocks.
  let changed = true
  while (changed) {
    changed = false
    for (const [blockId, block] of Object.entries(blocks)) {
      const parentId = block.data?.parentId
      if (!parentId || reached.has(blockId) || !reached.has(parentId)) continue
      visit(blockId)
      changed = true
    }
  }

  return reached
}

export const checkWorkflowGraphIntegrity = (
  graph: WorkflowGraph,
  options: { isTrigger?: (block: GraphBlock) => boolean } = {}
): GraphIntegrityResult => {
  const isTrigger =
    options.isTrigger ??
    ((block: GraphBlock) =>
      TriggerUtils.isTriggerBlock({ type: block.type ?? '', triggerMode: block.triggerMode }))

  const { blocks, edges } = graph
  const errors: string[] = []
  const warnings: string[] = []

  // 1. Edges have to point at blocks that exist.
  edges.forEach((edge, index) => {
    for (const [end, blockId] of [
      ['source', edge.source],
      ['target', edge.target],
    ] as const) {
      if (blockId && !blocks[blockId]) {
        errors.push(`Edge ${index} has a ${end} "${blockId}" that is not a block in this workflow.`)
      }
    }
  })

  // 2. A condition edge has to leave a branch the block declares. Getting this
  //    wrong leaves the branch silently unwired rather than failing at run time.
  for (const edge of edges) {
    const handle = edge.sourceHandle
    if (!handle?.startsWith(CONDITION_HANDLE_PREFIX) || !edge.source) continue

    const block = blocks[edge.source]
    if (!block) continue

    const branchId = handle.slice(CONDITION_HANDLE_PREFIX.length)
    const declared = readConditionBranchIds(block)
    if (declared === null) {
      errors.push(
        `Edge from ${label(blocks, edge.source)} uses condition branch "${handle}", but that block declares no conditions.`
      )
      continue
    }
    if (!declared.includes(branchId)) {
      errors.push(
        `Edge from ${label(blocks, edge.source)} uses condition branch "${handle}", which that block does not declare. It has: ${
          declared.map((id) => `${CONDITION_HANDLE_PREFIX}${id}`).join(', ') || 'none'
        }.`
      )
    }
  }

  // 3. A block no trigger reaches never runs, and nothing says so at run time.
  const reached = reachableFromTriggers(blocks, edges, isTrigger)
  const hasTrigger = Object.values(blocks).some((block) => isTrigger(block))
  if (hasTrigger) {
    for (const [blockId, block] of Object.entries(blocks)) {
      if (reached.has(blockId) || block.enabled === false) continue
      errors.push(
        `${label(blocks, blockId)} cannot be reached from any trigger, so it would never run. Connect it, or remove it.`
      )
    }
  } else {
    warnings.push('This workflow has no trigger block, so nothing can start it.')
  }

  // 4. A reachable block with nothing after it ends its branch. Often deliberate
  //    (a notification, a response), so this is only worth mentioning.
  const hasOutgoing = new Set(edges.map((edge) => edge.source).filter(Boolean) as string[])
  for (const blockId of reached) {
    const block = blocks[blockId]
    if (block?.enabled === false || hasOutgoing.has(blockId)) continue
    if (block?.type === 'response') continue
    warnings.push(
      `${label(blocks, blockId)} has nothing after it, so that branch ends there without reaching a response.`
    )
  }

  return { errors, warnings }
}
