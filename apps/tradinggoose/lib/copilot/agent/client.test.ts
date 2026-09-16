/**
 * The client used to fall back to a hosted base URL when nothing was
 * configured, so a deployment that had never set one still posted workflow
 * state, block settings and chat contexts to a third party. These pin the
 * replacement rule: with no URL configured, nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resolveConfig = vi.hoisted(() => vi.fn())

vi.mock('@/lib/system-services/runtime', () => ({
  resolveCopilotApiServiceConfig: resolveConfig,
}))

import { simAgentClient } from '@/lib/copilot/agent/client'

const fetchMock = vi.fn()

beforeEach(() => {
  resolveConfig.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const okResponse = () =>
  ({ status: 200, ok: true, text: async () => JSON.stringify({ yaml: 'ok' }) }) as Response

describe('with no base URL configured', () => {
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('sends nothing when the base URL is %s', async (_label, baseUrl) => {
    resolveConfig.mockResolvedValue({ baseUrl })

    const result = await simAgentClient.makeRequest('/api/workflow/to-yaml', {
      body: { workflowState: { secret: 'strategy' } },
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
  })

  it('says it was not configured rather than that a connection failed', async () => {
    resolveConfig.mockResolvedValue({ baseUrl: '' })

    const result = await simAgentClient.makeRequest('/api/workflow/to-yaml', { body: {} })

    // "Connection failed" would send someone looking at the network for a
    // request that was never made.
    expect(result.error).not.toContain('Connection failed')
    expect(result.error).toContain('not configured')
    expect(result.error).toContain('COPILOT_API_URL')
  })
})

describe('with a base URL configured', () => {
  it('uses exactly the configured host', async () => {
    resolveConfig.mockResolvedValue({ baseUrl: 'http://copilot.internal:8080' })
    fetchMock.mockResolvedValue(okResponse())

    const result = await simAgentClient.makeRequest('/api/workflow/to-yaml', { body: {} })

    expect(result.success).toBe(true)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://copilot.internal:8080/api/workflow/to-yaml')
  })

  it('never reaches a host the deployment did not name', async () => {
    resolveConfig.mockResolvedValue({ baseUrl: 'http://copilot.internal:8080' })
    fetchMock.mockResolvedValue(okResponse())

    await simAgentClient.makeRequest('/api/workflow/to-yaml', { body: {} })

    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('tradinggoose.ai')
  })
})
