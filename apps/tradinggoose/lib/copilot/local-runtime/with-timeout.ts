/**
 * Race a promise against a deadline.
 *
 * Server tools run in-process with no timeout of their own, so a single slow tool
 * used to hold a Copilot turn in `in_progress` indefinitely - no error, no
 * completion, and nothing logged. The caller turns the rejection into a failed tool
 * result, which the model can react to.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
