import type { LocalWorkingMessage } from '@/lib/copilot/local-runtime/working-messages'

/**
 * Guard against a local model repeating one tool call forever.
 *
 * The loop runs up to `maxToolIterations` (20 by default, 40 on this
 * deployment) and used to execute whatever the model asked for, so a small
 * model that re-issued `get_blocks_metadata` after every result spent the whole
 * budget on it: the Copilot panel filled with the same step and the turn ended
 * with nothing built. The same call is now answered from its own history
 * instead of being run again, and a model that will not move on ends the turn.
 */

/** Identical calls executed before the tool stops being run again. */
export const REPEATED_TOOL_CALL_LIMIT = 3
/** Identical calls after which the turn ends rather than looping further. */
export const REPEATED_TOOL_CALL_STOP_LIMIT = 5

/** A call is "the same" when both the tool and its arguments match. */
export function buildToolCallSignature(name: string, args: string | undefined): string {
  return `${name}:${(args ?? '{}').trim() || '{}'}`
}

/** How often each call already appears in the turn's history. */
export function countPriorToolCalls(messages: LocalWorkingMessage[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      const signature = buildToolCallSignature(call.function.name, call.function.arguments)
      counts.set(signature, (counts.get(signature) ?? 0) + 1)
    }
  }
  return counts
}

/** The result a repeated call gets instead of running the tool again. */
export function buildRepeatedToolCallResult(name: string, count: number): string {
  return JSON.stringify({
    ok: false,
    error: `Repeated call: ${name} was already called ${count - 1} times in this turn with these arguments, and was not run again. Use the result you already have above, then continue with the next step. Do not call ${name} with the same arguments again.`,
  })
}
