import { type NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/logs/console/logger'
import { generateRequestId } from '@/lib/utils'
import {
  exportWorkflowAsYaml,
  findMismatchedConditionEdges,
} from '@/stores/workflows/yaml/exporter'

const logger = createLogger('WorkflowYamlAPI')

export async function POST(request: NextRequest) {
  const requestId = generateRequestId()

  try {
    logger.info(`[${requestId}] Converting workflow JSON to YAML`)

    const body = await request.json()
    const { workflowState, subBlockValues, includeMetadata = false } = body

    if (!workflowState) {
      return NextResponse.json(
        { success: false, error: 'workflowState is required' },
        { status: 400 }
      )
    }

    // Ensure loop blocks have their data populated with defaults
    if (workflowState.blocks) {
      Object.entries(workflowState.blocks).forEach(([blockId, block]: [string, any]) => {
        if (block.type === 'loop') {
          // Ensure data field exists
          if (!block.data) {
            block.data = {}
          }

          // Apply defaults if not set
          if (!block.data.loopType) {
            block.data.loopType = 'for'
          }
          if (!block.data.count && block.data.count !== 0) {
            block.data.count = 5
          }
          if (!block.data.collection) {
            block.data.collection = ''
          }
          if (!block.data.maxConcurrency) {
            block.data.maxConcurrency = 1
          }

          logger.debug(`[${requestId}] Applied defaults to loop block ${blockId}:`, {
            loopType: block.data.loopType,
            count: block.data.count,
          })
        }
      })
    }

    // Converted in process. This used to post workflowState and subBlockValues -
    // system prompts, condition expressions, function source - to a remote
    // service, along with local functions serialised as strings for it to run.
    const mismatchedConditionEdges = findMismatchedConditionEdges(workflowState)
    if (mismatchedConditionEdges.length > 0) {
      logger.warn(`[${requestId}] Dropping condition edges that name another block`, {
        edges: mismatchedConditionEdges,
      })
    }
    const yaml = exportWorkflowAsYaml(workflowState, subBlockValues)

    logger.info(`[${requestId}] Successfully generated YAML`, { yamlLength: yaml.length })

    return NextResponse.json({
      success: true,
      yaml,
    })
  } catch (error) {
    logger.error(`[${requestId}] YAML generation failed`, error)
    return NextResponse.json(
      {
        success: false,
        error: `Failed to generate YAML: ${error instanceof Error ? error.message : 'Unknown error'}`,
      },
      { status: 500 }
    )
  }
}
