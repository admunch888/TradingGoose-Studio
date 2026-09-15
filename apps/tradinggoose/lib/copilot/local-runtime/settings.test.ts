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

  it('sends the sampling cutoffs that keep a quantized model off its noisy tail', () => {
    // Without top_p/top_k the server samples the whole vocabulary even at a low
    // temperature, which is how an FP8 model ends up emitting runs of one
    // junk character.
    const settings = normalizeLocalCopilotSettings({
      copilotTemperature: 0.6,
      copilotTopP: 0.95,
      copilotTopK: 20,
      copilotPresencePenalty: 1.5,
    })

    expect(settings).toMatchObject({ temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 1.5 })
    expect(buildLocalCopilotSamplingOptions(settings)).toEqual({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      presence_penalty: 1.5,
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

    // top_k = 0 means "disabled" on some servers and "no tokens" on others, so
    // it is rejected rather than forwarded.
    expect(normalizeLocalCopilotSettings({ copilotTopK: 0 }).topK).toBeUndefined()
    expect(normalizeLocalCopilotSettings({ copilotTopP: 1.5 }).topP).toBeUndefined()
    expect(
      normalizeLocalCopilotSettings({ copilotPresencePenalty: 3 }).presencePenalty
    ).toBeUndefined()
    expect(normalizeLocalCopilotSettings({ copilotTopK: 20.7 }).topK).toBe(20)
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
