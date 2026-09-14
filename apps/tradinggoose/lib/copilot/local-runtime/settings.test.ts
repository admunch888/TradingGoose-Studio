/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockResolveVllmServiceConfig = vi.hoisted(() => vi.fn())

vi.mock('@/lib/system-services/runtime', () => ({
  resolveVllmServiceConfig: () => mockResolveVllmServiceConfig(),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}))

import {
  buildLocalCopilotSamplingOptions,
  normalizeLocalCopilotSettings,
  resolveLocalCopilotSettings,
} from '@/lib/copilot/local-runtime/settings'

describe('local Copilot settings', () => {
  beforeEach(() => {
    mockResolveVllmServiceConfig.mockReset()
  })

  it('keeps the previous behaviour when nothing is configured', () => {
    const settings = normalizeLocalCopilotSettings({})

    expect(settings).toEqual({
      contextWindow: 32_768,
      maxToolIterations: 20,
      enableThinking: false,
    })
    expect(buildLocalCopilotSamplingOptions(settings)).toEqual({})
  })

  it('uses the configured context window, step budget, temperature and thinking', () => {
    const settings = normalizeLocalCopilotSettings({
      copilotContextWindow: 131_072,
      copilotMaxToolIterations: 40,
      copilotTemperature: 0.6,
      copilotEnableThinking: true,
    })

    expect(settings).toEqual({
      contextWindow: 131_072,
      maxToolIterations: 40,
      temperature: 0.6,
      enableThinking: true,
    })
    expect(buildLocalCopilotSamplingOptions(settings)).toEqual({
      temperature: 0.6,
      chat_template_kwargs: { enable_thinking: true },
    })
  })

  it('ignores values outside the supported range', () => {
    expect(
      normalizeLocalCopilotSettings({
        copilotContextWindow: 1_000,
        copilotMaxToolIterations: 500,
        copilotTemperature: 3,
      })
    ).toEqual({ contextWindow: 32_768, maxToolIterations: 20, enableThinking: false })
    expect(normalizeLocalCopilotSettings({ copilotMaxToolIterations: 0 }).maxToolIterations).toBe(
      20
    )
    expect(normalizeLocalCopilotSettings({ copilotTemperature: 0 }).temperature).toBe(0)
  })

  it('reads the self-hosted endpoint service and survives a failure', async () => {
    mockResolveVllmServiceConfig.mockResolvedValue({
      baseUrl: 'http://ai:8080',
      copilotContextWindow: 262_144,
      copilotEnableThinking: true,
    })
    expect(await resolveLocalCopilotSettings()).toMatchObject({
      contextWindow: 262_144,
      enableThinking: true,
    })

    mockResolveVllmServiceConfig.mockRejectedValue(new Error('database unavailable'))
    expect(await resolveLocalCopilotSettings()).toEqual({
      contextWindow: 32_768,
      maxToolIterations: 20,
      enableThinking: false,
    })
  })
})
