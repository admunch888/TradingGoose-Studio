import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCopilotEnabled } from '@/lib/copilot/feature-flag'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isCopilotEnabled', () => {
  it('is on when nothing is set, so an existing deployment is unchanged', () => {
    expect(isCopilotEnabled()).toBe(true)
  })

  it.each(['false', 'FALSE', '0', 'off', 'no', ' false '])('is off for %o', (value) => {
    vi.stubEnv('COPILOT_ENABLED', value)
    expect(isCopilotEnabled()).toBe(false)
  })

  it.each(['true', '1', 'yes', ''])('is on for %o', (value) => {
    vi.stubEnv('COPILOT_ENABLED', value)
    expect(isCopilotEnabled()).toBe(true)
  })
})
