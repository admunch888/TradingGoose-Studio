/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockListSkills = vi.hoisted(() => vi.fn())

vi.mock('@/lib/skills/operations', () => ({
  listSkills: (...args: unknown[]) => mockListSkills(...args),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}))

import {
  buildLocalCopilotSystemPrompt,
  LOCAL_COPILOT_SYSTEM_PROMPT,
} from '@/lib/copilot/local-runtime/prompt'
import {
  loadLocalCopilotWorkspaceInstructions,
  MAX_WORKSPACE_INSTRUCTIONS_CHARS,
  selectCopilotInstructionsSkill,
} from '@/lib/copilot/local-runtime/workspace-instructions'

const skill = (name: string, content: string) => ({ name, content })

describe('Copilot workspace instructions', () => {
  beforeEach(() => {
    mockListSkills.mockReset()
  })

  it('finds the instructions skill by name, however it is spelled', () => {
    for (const name of ['copilot-instructions', 'Copilot Instructions', ' copilot_instructions ']) {
      expect(
        selectCopilotInstructionsSkill([skill('other', 'x'), skill(name, 'rules')])?.content
      ).toBe('rules')
    }
    expect(selectCopilotInstructionsSkill([skill('copilot', 'x')])).toBeUndefined()
  })

  it("loads the workspace's instructions and bounds their size", async () => {
    mockListSkills.mockResolvedValue([skill('Copilot Instructions', '  Use IBKR paper.  ')])
    expect(await loadLocalCopilotWorkspaceInstructions('workspace-1')).toBe('Use IBKR paper.')
    expect(mockListSkills).toHaveBeenCalledWith({ workspaceId: 'workspace-1' })

    mockListSkills.mockResolvedValue([
      skill('copilot-instructions', 'x'.repeat(MAX_WORKSPACE_INSTRUCTIONS_CHARS + 10)),
    ])
    const long = await loadLocalCopilotWorkspaceInstructions('workspace-1')
    expect(long?.endsWith('…[truncated]')).toBe(true)
  })

  it('returns nothing without a workspace, a skill, content, or when skills cannot be read', async () => {
    expect(await loadLocalCopilotWorkspaceInstructions(undefined)).toBeNull()
    expect(mockListSkills).not.toHaveBeenCalled()

    mockListSkills.mockResolvedValue([skill('copilot-instructions', '   ')])
    expect(await loadLocalCopilotWorkspaceInstructions('workspace-1')).toBeNull()

    mockListSkills.mockRejectedValue(new Error('database unavailable'))
    expect(await loadLocalCopilotWorkspaceInstructions('workspace-1')).toBeNull()
  })

  it('appends the instructions to the system prompt only when there are some', () => {
    expect(buildLocalCopilotSystemPrompt()).toBe(LOCAL_COPILOT_SYSTEM_PROMPT)
    expect(buildLocalCopilotSystemPrompt({ workspaceInstructions: '  ' })).toBe(
      LOCAL_COPILOT_SYSTEM_PROMPT
    )

    const prompt = buildLocalCopilotSystemPrompt({ workspaceInstructions: 'Use IBKR paper.' })
    expect(prompt.startsWith(LOCAL_COPILOT_SYSTEM_PROMPT)).toBe(true)
    expect(prompt).toContain('<workspace_instructions>\nUse IBKR paper.\n</workspace_instructions>')
  })

  it('no longer tells the model it is a small model or to keep work minimal', () => {
    expect(LOCAL_COPILOT_SYSTEM_PROMPT).not.toContain('small self-hosted model')
    for (const tool of ['plan', 'read_block_upstream_references', 'search_listing']) {
      expect(LOCAL_COPILOT_SYSTEM_PROMPT).toContain(`\`${tool}\``)
    }
  })
})
