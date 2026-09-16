/**
 * Turn a workflow's state into the YAML the importer beside this file reads.
 *
 * This used to be done by a remote service: the route posted `workflowState`,
 * `subBlockValues`, the whole block registry and three local functions as
 * strings, and got YAML back. That sent block settings - system prompts,
 * condition expressions, function source - to a host the operator had usually
 * never configured, and it made a local-only feature depend on a network call.
 *
 * Nothing here needs a service. The conversion is the exact inverse of
 * `parseBlockConnections`, so the two are written against each other and
 * `exporter.test.ts` round-trips through the importer to keep them that way.
 */

import { dump as yamlDump } from 'js-yaml'

const YAML_VERSION = '1.0'

/** Handles the importer maps to a nested `connections` key rather than a name. */
const STRUCTURAL_HANDLES: Record<string, [group: 'loop' | 'parallel', end: 'start' | 'end']> = {
  'loop-start-source': ['loop', 'start'],
  'loop-end-source': ['loop', 'end'],
  'parallel-start-source': ['parallel', 'start'],
  'parallel-end-source': ['parallel', 'end'],
}

export interface ExportableBlock {
  type?: string
  name?: string
  data?: { parentId?: string | null } | null
}

export interface ExportableEdge {
  source?: string
  target?: string
  sourceHandle?: string | null
}

export interface ExportableWorkflowState {
  blocks: Record<string, ExportableBlock>
  edges: ExportableEdge[]
}

interface YamlConnections {
  success?: string | string[]
  error?: string | string[]
  conditions?: Record<string, string | string[]>
  loop?: { start?: string | string[]; end?: string | string[] }
  parallel?: { start?: string | string[]; end?: string | string[] }
}

interface YamlBlock {
  type: string
  name: string
  inputs?: Record<string, unknown>
  connections?: YamlConnections
  parentId?: string
}

/** One target reads better than a list of one, and the importer accepts both. */
const collapse = (targets: string[]): string | string[] =>
  targets.length === 1 ? targets[0] : targets

/**
 * `condition-<blockId>-<key>` carries the block id, so the key is what is left
 * after removing it. Split on the id rather than on dashes: both the id and the
 * key contain them (`condition-<uuid>-else-if-1752111795510`).
 */
const readConditionKey = (sourceHandle: string, blockId: string): string | null => {
  const prefix = `condition-${blockId}-`
  if (!sourceHandle.startsWith(prefix)) return null
  const key = sourceHandle.slice(prefix.length)
  return key === '' ? null : key
}

const buildConnections = (
  blockId: string,
  edges: ExportableEdge[]
): YamlConnections | undefined => {
  const success: string[] = []
  const error: string[] = []
  const conditions: Record<string, string[]> = {}
  const structural: { loop: Record<string, string[]>; parallel: Record<string, string[]> } = {
    loop: {},
    parallel: {},
  }

  for (const edge of edges) {
    if (edge.source !== blockId || !edge.target) continue
    const handle = edge.sourceHandle ?? 'source'

    const structuralHandle = STRUCTURAL_HANDLES[handle]
    if (structuralHandle) {
      const [group, end] = structuralHandle
      ;(structural[group][end] ??= []).push(edge.target)
      continue
    }

    if (handle === 'error') {
      error.push(edge.target)
      continue
    }

    if (handle.startsWith('condition-')) {
      const key = readConditionKey(handle, blockId)
      if (key) {
        ;(conditions[key] ??= []).push(edge.target)
        continue
      }
      // A condition handle that does not name this block is malformed. Keeping it
      // as a plain connection would silently move the edge onto the default
      // output, so it is dropped here and reported by the caller.
      continue
    }

    success.push(edge.target)
  }

  const connections: YamlConnections = {}
  if (success.length > 0) connections.success = collapse(success)
  if (error.length > 0) connections.error = collapse(error)
  if (Object.keys(conditions).length > 0) {
    connections.conditions = Object.fromEntries(
      Object.entries(conditions).map(([key, targets]) => [key, collapse(targets)])
    )
  }
  for (const group of ['loop', 'parallel'] as const) {
    const ends = structural[group]
    if (Object.keys(ends).length === 0) continue
    connections[group] = Object.fromEntries(
      Object.entries(ends).map(([end, targets]) => [end, collapse(targets)])
    )
  }

  return Object.keys(connections).length > 0 ? connections : undefined
}

/** Edges whose condition handle names a different block than the one they leave. */
export const findMismatchedConditionEdges = (state: ExportableWorkflowState): string[] =>
  state.edges
    .filter((edge) => {
      const handle = edge.sourceHandle
      if (!handle?.startsWith('condition-') || !edge.source) return false
      return readConditionKey(handle, edge.source) === null
    })
    .map((edge) => `${edge.source} -> ${edge.target} (${edge.sourceHandle})`)

export const buildWorkflowYamlDocument = (
  state: ExportableWorkflowState,
  subBlockValues: Record<string, Record<string, unknown>> = {}
): { version: string; blocks: Record<string, YamlBlock> } => {
  const blocks: Record<string, YamlBlock> = {}

  for (const [blockId, block] of Object.entries(state.blocks)) {
    const inputs = subBlockValues[blockId]
    const connections = buildConnections(blockId, state.edges)
    const parentId = block.data?.parentId

    blocks[blockId] = {
      type: block.type ?? '',
      name: block.name ?? blockId,
      ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
      ...(connections ? { connections } : {}),
      ...(parentId ? { parentId } : {}),
    }
  }

  return { version: YAML_VERSION, blocks }
}

export const exportWorkflowAsYaml = (
  state: ExportableWorkflowState,
  subBlockValues: Record<string, Record<string, unknown>> = {}
): string =>
  yamlDump(buildWorkflowYamlDocument(state, subBlockValues), {
    // Keep declaration order, which follows the workflow's own block order, and
    // leave long prompts and code readable rather than wrapped mid-line.
    sortKeys: false,
    lineWidth: -1,
    noRefs: true,
  })
