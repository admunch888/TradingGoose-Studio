/**
 * A local turn must carry the OPEN entity's context into its tool executions.
 *
 * This is the local-runtime half of the reported symptom: `edit_workflow`,
 * `edit_workflow_block` and `read_workflow_logs` resolve their target from
 * `contextEntityId`/`contextEntityKind` (and the workspace from `workspaceId`),
 * which the managed path fills in from the client's tool provenance but the
 * local path never did - so a local model had to discover a workflow id with
 * `list_workflows` and pass it back exactly.
 *
 * The whole stack below the turn params is REAL here (chat handler -> agent ->
 * tool-execution): only the vLLM client, the review staging and the tool
 * ROUTER (the observation point, one level under the seam under test) are
 * stubbed. Mocking tool-execution instead - as agent.test.ts does - would assert
 * nothing about what the executed tool actually receives.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({
  executions: [] as Array<{
    toolName: string
    payload: unknown
    context: Record<string, unknown> | undefined
  }>,
}))

vi.mock('@tradinggoose/db', () => {
  const rows: unknown[] = []
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    values: () => chain,
    set: () => chain,
    onConflictDoNothing: () => chain,
    returning: () => chain,
    execute: () => chain,
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  }
  const db = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
    execute: () => chain,
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  }
  return { db, copilotReviewSessions: {}, copilotReviewItems: {} }
})

vi.mock('@/lib/copilot/local-runtime/persistence', () => ({
  persistLocalWorkingMessage: async () => {},
  persistLocalWorkingUserMessage: async () => {},
  persistLocalWorkingAssistantMessage: async () => {},
  persistLocalReviewMessage: async () => {},
  appendLocalAssistantText: async () => {},
  loadLocalWorkingMessages: async () => [],
}))

// The observation point: tool-execution is real, its downstream router is not.
vi.mock('@/lib/copilot/tools/server/router', () => ({
  routeExecution: async (toolName: string, payload: unknown, context?: Record<string, unknown>) => {
    captured.executions.push({ toolName, payload, context })
    return { success: true, entityKind: 'workflow', entityId: 'wf-open', message: 'updated' }
  },
}))

vi.mock('@/lib/copilot/tools/server/review-acceptance', () => ({
  stageServerManagedToolReview: async (_toolName: string, _payload: unknown, result: unknown) =>
    result,
  acceptServerManagedToolReview: async () => ({ success: true }),
}))

vi.mock('@/lib/copilot/runtime-tool-manifest', () => ({
  getCopilotRuntimeToolManifest: async () => ({
    tools: [
      {
        name: 'edit_workflow',
        description: 'Edit a workflow document',
        parameters: {
          type: 'object',
          properties: { entityId: { type: 'string' }, entityDocument: { type: 'string' } },
        },
      },
    ],
  }),
}))

vi.mock('@/lib/system-services/runtime', () => ({
  resolveVllmServiceConfig: async () => ({ baseUrl: 'http://127.0.0.1:8000' }),
}))

// Scripted self-hosted model: iteration 1 calls edit_workflow WITHOUT an entity
// id (exactly what a small local model does), iteration 2 answers.
const llm = vi.hoisted(() => ({ iterations: 0 }))

vi.mock('openai', () => {
  class FakeOpenAI {
    chat = {
      completions: {
        create: async () => {
          const iteration = llm.iterations++
          if (iteration === 0) {
            return (async function* toolCallStream() {
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call-1',
                          function: {
                            name: 'edit_workflow',
                            arguments: JSON.stringify({ entityDocument: 'flowchart TD' }),
                          },
                        },
                      ],
                    },
                  },
                ],
              }
            })()
          }
          return (async function* textStream() {
            yield { choices: [{ delta: { content: 'Done.' } }] }
          })()
        },
      },
    }
  }
  return { default: FakeOpenAI }
})

import { handleLocalCopilotChat } from '@/lib/copilot/local-runtime/chat-handler'

type Frame = Record<string, unknown>

type TurnParams = {
  contextEntityKind?: string
  contextEntityId?: string
  workspaceId?: string
}

async function runLocalTurn(params: TurnParams = {}): Promise<Frame[]> {
  const response = await handleLocalCopilotChat({
    model: 'vllm/qwen3.8-fp8',
    message: 'change the second block',
    modelMessage: 'change the second block',
    userMessageId: 'user-item-1',
    reviewSessionId: 'session-1',
    userId: 'user-1',
    ...params,
    requestId: 'req-1',
  })
  const text = await new Response(response.body).text()
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)) as Frame)
}

describe('local turn tool context', () => {
  beforeEach(() => {
    captured.executions = []
    llm.iterations = 0
  })

  /**
   * The turn's open workflow must reach the executed tool. Without this the tool
   * throws "entityId is required for edit_workflow" no matter how clearly the
   * system prompt describes the open entity.
   */
  it('passes the open entity context through to the executed tool', async () => {
    await runLocalTurn({
      contextEntityKind: 'workflow',
      contextEntityId: 'wf-open',
      workspaceId: 'workspace-1',
    })

    expect(captured.executions).toHaveLength(1)
    const execution = captured.executions[0]
    expect(execution.toolName).toBe('edit_workflow')
    expect(execution.payload).toMatchObject({ entityDocument: 'flowchart TD' })
    expect(execution.context).toMatchObject({
      userId: 'user-1',
      accessLevel: 'full',
      contextEntityKind: 'workflow',
      contextEntityId: 'wf-open',
      workspaceId: 'workspace-1',
    })
  })

  /**
   * Safety case: with no context the runtime must not invent a target. Nothing
   * entity-shaped may reach the tool, so its own "entityId is required" guard
   * still fires and an edit can never land on a guessed workflow.
   */
  it('sends no entity context when the turn has none', async () => {
    await runLocalTurn({ workspaceId: 'workspace-1' })

    expect(captured.executions).toHaveLength(1)
    const context = captured.executions[0].context ?? {}
    expect(context.contextEntityId).toBeUndefined()
    expect(context.contextEntityKind).toBeUndefined()
    expect(context.workspaceId).toBe('workspace-1')
  })
})
