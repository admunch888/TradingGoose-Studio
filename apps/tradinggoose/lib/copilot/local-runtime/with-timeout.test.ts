import { describe, expect, it, vi } from 'vitest'
import { withTimeout } from '@/lib/copilot/local-runtime/with-timeout'

describe('withTimeout', () => {
  it('passes a result through when the work finishes in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1_000, 'Tool x')).resolves.toBe('ok')
  })

  it('rejects and names the label when the work outlives the deadline', async () => {
    vi.useFakeTimers()
    const never = new Promise<string>(() => {})
    const pending = withTimeout(never, 50, 'Tool slow_tool')
    const assertion = expect(pending).rejects.toThrow('Tool slow_tool timed out after 50ms')
    await vi.advanceTimersByTimeAsync(60)
    await assertion
    vi.useRealTimers()
  })

  it('surfaces the original failure rather than a timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1_000, 'Tool x')).rejects.toThrow(
      'boom'
    )
  })
})
