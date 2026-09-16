import { describe, expect, it } from 'vitest'
import { resolveCopilotEndpoint } from '@/lib/copilot/local-runtime/endpoint'

const shared = { baseUrl: 'http://10.20.18.50:8080', apiKey: 'shared-key' }

describe('with no Copilot endpoint set', () => {
  it('uses the shared one, which is the previous behaviour', () => {
    expect(resolveCopilotEndpoint(shared)).toEqual({
      baseUrl: 'http://10.20.18.50:8080',
      apiKey: 'shared-key',
      isCopilotOverride: false,
    })
  })

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['absent', undefined],
  ])('treats a %s Copilot URL as unset', (_label, copilotBaseUrl) => {
    expect(resolveCopilotEndpoint({ ...shared, copilotBaseUrl })?.isCopilotOverride).toBe(false)
  })

  it('is null when nothing is configured at all', () => {
    expect(resolveCopilotEndpoint({})).toBeNull()
  })
})

describe('with a Copilot endpoint set', () => {
  it('sends Copilot traffic there and leaves the shared one alone', () => {
    const resolved = resolveCopilotEndpoint({
      ...shared,
      copilotBaseUrl: 'https://api.deepseek.com',
      copilotApiKey: 'deepseek-key',
    })

    expect(resolved).toEqual({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'deepseek-key',
      isCopilotOverride: true,
    })
  })

  it('does not lend the shared key to a different host', () => {
    // Borrowing it would send the local endpoint's bearer token to whoever the
    // Copilot now points at.
    const resolved = resolveCopilotEndpoint({
      ...shared,
      copilotBaseUrl: 'https://api.deepseek.com',
    })

    expect(resolved?.apiKey).toBe('')
  })

  it('drops a trailing slash, since callers append /v1', () => {
    const resolved = resolveCopilotEndpoint({ copilotBaseUrl: 'https://api.deepseek.com/' })

    expect(resolved?.baseUrl).toBe('https://api.deepseek.com')
  })
})
