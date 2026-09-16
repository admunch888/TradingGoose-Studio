import { v4 as uuidv4 } from 'uuid'
import { createLogger } from '@/lib/logs/console/logger'
import { checkWorkflowGraphIntegrity } from '@/lib/workflows/graph-integrity'
import {
  parseImportedWorkflowFile,
  type WorkflowTransferRecord,
} from '@/lib/workflows/import-export'

const logger = createLogger('WorkflowJsonImporter')
type ImportedWorkflowState = WorkflowTransferRecord['state']

const CONDITION_HANDLE_PREFIX = 'condition-'

/**
 * Rewrite `<oldBlockId>-<branch>` to `<newBlockId>-<branch>`.
 *
 * A condition branch is identified by the block it belongs to, so its id has to
 * move with the block. The branch key itself contains dashes
 * (`else-if-1752111795510`), so the old id is removed by prefix rather than by
 * splitting.
 */
const remapConditionEntryId = (entryId: string, blockIdMap: Map<string, string>): string => {
  for (const [oldId, newId] of blockIdMap) {
    const prefix = `${oldId}-`
    if (entryId.startsWith(prefix)) return `${newId}-${entryId.slice(prefix.length)}`
  }
  return entryId
}

/** The same rewrite for an edge's `condition-<blockId>-<branch>` handle. */
const remapSourceHandle = (
  sourceHandle: string | null | undefined,
  blockIdMap: Map<string, string>
): string | null | undefined => {
  if (!sourceHandle?.startsWith(CONDITION_HANDLE_PREFIX)) return sourceHandle
  const entryId = sourceHandle.slice(CONDITION_HANDLE_PREFIX.length)
  return `${CONDITION_HANDLE_PREFIX}${remapConditionEntryId(entryId, blockIdMap)}`
}

/**
 * Renumber the ids inside a condition block's `conditions` value.
 *
 * Normally the array of entries; it has also been seen double-encoded as a JSON
 * string holding that array, so both are handled and the shape is preserved.
 */
const remapConditionEntries = <Value>(value: Value, blockIdMap: Map<string, string>): Value => {
  const remapArray = (entries: unknown[]): unknown[] =>
    entries.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry
      const { id } = entry as { id?: unknown }
      if (typeof id !== 'string') return entry
      return { ...entry, id: remapConditionEntryId(id, blockIdMap) }
    })

  if (Array.isArray(value)) return remapArray(value) as Value

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return JSON.stringify(remapArray(parsed)) as Value
    } catch {
      // Not JSON: leave it exactly as it was rather than guess at its shape.
    }
  }

  return value
}

/**
 * Generate new IDs for all blocks and edges to avoid conflicts
 */
function regenerateIds(workflowState: ImportedWorkflowState): ImportedWorkflowState {
  const blockIdMap = new Map<string, string>()
  const newBlocks: ImportedWorkflowState['blocks'] = {}

  // First pass: create new IDs for all blocks
  Object.entries(workflowState.blocks).forEach(([oldId, block]) => {
    const newId = uuidv4()
    blockIdMap.set(oldId, newId)
    newBlocks[newId] = {
      ...block,
      id: newId,
    }
  })

  // Second pass: update edges with new block IDs
  const newEdges = workflowState.edges.map((edge) => ({
    ...edge,
    id: uuidv4(), // Generate new edge ID
    source: blockIdMap.get(edge.source) || edge.source,
    target: blockIdMap.get(edge.target) || edge.target,
    // `condition-<blockId>-<branch>` names the block it leaves. Left alone it
    // points at an id that no longer exists once the block is renumbered, and
    // the branch silently stops resolving.
    ...(edge.sourceHandle === undefined
      ? {}
      : { sourceHandle: remapSourceHandle(edge.sourceHandle, blockIdMap) }),
  }))

  // Third pass: update loops with new block IDs
  // CRITICAL: Loop IDs must match their block IDs (loops are keyed by their block ID)
  const newLoops: ImportedWorkflowState['loops'] = {}
  if (workflowState.loops) {
    Object.entries(workflowState.loops).forEach(([oldLoopId, loop]) => {
      // Map the loop ID using the block ID mapping (loop ID = block ID)
      const newLoopId = blockIdMap.get(oldLoopId) || oldLoopId
      newLoops[newLoopId] = {
        ...loop,
        id: newLoopId,
        nodes: loop.nodes.map((nodeId) => blockIdMap.get(nodeId) || nodeId),
      }
    })
  }

  // Fourth pass: update parallels with new block IDs
  // CRITICAL: Parallel IDs must match their block IDs (parallels are keyed by their block ID)
  const newParallels: ImportedWorkflowState['parallels'] = {}
  if (workflowState.parallels) {
    Object.entries(workflowState.parallels).forEach(([oldParallelId, parallel]) => {
      // Map the parallel ID using the block ID mapping (parallel ID = block ID)
      const newParallelId = blockIdMap.get(oldParallelId) || oldParallelId
      newParallels[newParallelId] = {
        ...parallel,
        id: newParallelId,
        nodes: parallel.nodes.map((nodeId) => blockIdMap.get(nodeId) || nodeId),
      }
    })
  }

  // Fifth pass: update any block references in subblock values
  Object.entries(newBlocks).forEach(([blockId, block]) => {
    if (block.subBlocks) {
      // A condition block declares its branches as `<blockId>-<branch>`, and the
      // edges leaving it name those ids. Both have to be renumbered together or
      // the branches stop matching their edges.
      const conditions = block.subBlocks.conditions
      if (conditions?.value !== undefined && conditions.value !== null) {
        block.subBlocks.conditions = {
          ...conditions,
          value: remapConditionEntries(conditions.value, blockIdMap),
        }
      }

      Object.entries(block.subBlocks).forEach(([subBlockId, subBlock]) => {
        if (subBlockId === 'conditions') return
        if (subBlock.value && typeof subBlock.value === 'string') {
          // Replace any block references in the value
          let updatedValue = subBlock.value
          blockIdMap.forEach((newId, oldId) => {
            // Replace references like <blockId.output> with new IDs
            const regex = new RegExp(`<${oldId}\\.`, 'g')
            updatedValue = updatedValue.replace(regex, `<${newId}.`)
          })
          block.subBlocks[subBlockId] = {
            ...subBlock,
            value: updatedValue,
          }
        }
      })
    }

    // Update parentId references in block.data
    if (block.data?.parentId) {
      const newParentId = blockIdMap.get(block.data.parentId)
      if (newParentId) {
        block.data.parentId = newParentId
      } else {
        // Parent ID not in mapping - this shouldn't happen but log it
        logger.warn(`Block ${blockId} references unmapped parent ${block.data.parentId}`)
        // Remove invalid parent reference
        block.data.parentId = undefined
        block.data.extent = undefined
      }
    }
  })

  return {
    blocks: newBlocks,
    edges: newEdges,
    loops: newLoops,
    parallels: newParallels,
    variables: workflowState.variables,
  }
}

export function parseWorkflowJson(
  jsonContent: string,
  regenerateIdsFlag = true
): {
  data: WorkflowTransferRecord | null
  errors: string[]
} {
  const parseFailures: string[] = []

  try {
    let data: unknown
    try {
      data = JSON.parse(jsonContent)
    } catch (parseError) {
      logger.error('Failed to parse workflow JSON:', parseError)
      parseFailures.push('Invalid JSON: file could not be parsed')
      return { data: null, errors: parseFailures }
    }

    if (!data || typeof data !== 'object') {
      parseFailures.push('Invalid JSON: root must be an object')
      return { data: null, errors: parseFailures }
    }

    logger.info('Parsing workflow JSON', {
      version: (data as Record<string, unknown>).version,
      fileType: (data as Record<string, unknown>).fileType,
      exportedFrom: (data as Record<string, unknown>).exportedFrom,
    })

    const { data: importedWorkflow, errors: importFailures } = parseImportedWorkflowFile(data)

    if (!importedWorkflow || importFailures.length > 0) {
      return { data: null, errors: importFailures }
    }

    let workflowData: WorkflowTransferRecord = importedWorkflow

    if (regenerateIdsFlag) {
      workflowData = {
        ...workflowData,
        state: regenerateIds(workflowData.state),
      }
      logger.info('Regenerated IDs for imported workflow to avoid conflicts')

      // The file was already checked before renumbering. Checking again after it
      // is what catches a reference the renumbering missed - which is how a
      // condition branch came to point at a block id that no longer existed,
      // importing cleanly and then failing to open in the editor.
      const { errors: renumberErrors } = checkWorkflowGraphIntegrity(workflowData.state)
      if (renumberErrors.length > 0) {
        logger.error('Renumbering produced an inconsistent workflow', { errors: renumberErrors })
        return {
          data: null,
          errors: renumberErrors.map(
            (error) => `The workflow could not be renumbered on import: ${error}`
          ),
        }
      }
    }

    logger.info('Successfully parsed workflow JSON', {
      name: workflowData.name,
      description: workflowData.description,
      blocksCount: Object.keys(workflowData.state.blocks).length,
      edgesCount: workflowData.state.edges.length,
      loopsCount: Object.keys(workflowData.state.loops).length,
      parallelsCount: Object.keys(workflowData.state.parallels).length,
    })

    return { data: workflowData, errors: [] }
  } catch (error) {
    logger.error('Failed to parse workflow JSON:', error)
    parseFailures.push('Unexpected error while parsing workflow file')
    return { data: null, errors: parseFailures }
  }
}
