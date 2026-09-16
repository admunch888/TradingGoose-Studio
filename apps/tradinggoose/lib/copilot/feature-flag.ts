/**
 * The Copilot off switch.
 *
 * The Copilot is an authoring tool: it helps build workflows, and takes no part
 * in running them. Nothing a deployed workflow does at execution time goes
 * through it, so turning it off removes a feature, not a capability - workflows
 * keep running exactly as before, edited through export/import instead.
 *
 * Default is on, so an existing deployment that sets nothing is unchanged.
 * Read on the server only: the layout resolves it and passes the result down,
 * which keeps it a plain runtime variable rather than one baked in at build time.
 */
export function isCopilotEnabled(): boolean {
  const value = process.env.COPILOT_ENABLED?.trim().toLowerCase()
  if (value === undefined || value === '') return true
  return !(value === 'false' || value === '0' || value === 'off' || value === 'no')
}

export const COPILOT_DISABLED_MESSAGE =
  'The Copilot is turned off on this deployment (COPILOT_ENABLED=false).'
