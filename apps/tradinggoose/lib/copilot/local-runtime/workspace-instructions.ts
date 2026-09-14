import { createLogger } from '@/lib/logs/console/logger'

const logger = createLogger('LocalCopilotWorkspaceInstructions')

/**
 * The workspace skill whose content is added to the local Copilot's system
 * prompt on every turn - the workspace's standing instructions for Copilot
 * (conventions, preferred providers, risk rules), so they apply without being
 * repeated or mentioned in each chat.
 */
export const COPILOT_INSTRUCTIONS_SKILL_NAME = 'copilot-instructions'

export const MAX_WORKSPACE_INSTRUCTIONS_CHARS = 16_000

/** `Copilot Instructions`, `copilot_instructions` and `copilot-instructions` all match. */
const normalizeSkillName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')

export const selectCopilotInstructionsSkill = <T extends { name: string; content: string }>(
  skills: readonly T[]
): T | undefined =>
  skills.find((skill) => normalizeSkillName(skill.name) === COPILOT_INSTRUCTIONS_SKILL_NAME)

/**
 * The instructions text for a workspace, or null when there is no workspace, no
 * such skill, or it is empty. A failure to read skills never fails the turn.
 */
export async function loadLocalCopilotWorkspaceInstructions(
  workspaceId?: string
): Promise<string | null> {
  if (!workspaceId) return null
  try {
    const { listSkills } = await import('@/lib/skills/operations')
    const content = selectCopilotInstructionsSkill(
      await listSkills({ workspaceId })
    )?.content.trim()
    if (!content) return null
    return content.length > MAX_WORKSPACE_INSTRUCTIONS_CHARS
      ? `${content.slice(0, MAX_WORKSPACE_INSTRUCTIONS_CHARS)}\n…[truncated]`
      : content
  } catch (error) {
    logger.warn('Could not load Copilot workspace instructions', { workspaceId, error })
    return null
  }
}
