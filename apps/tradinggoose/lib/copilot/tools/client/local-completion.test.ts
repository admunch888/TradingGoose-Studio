import { describe, expect, it } from 'vitest'
import { buildToolCompletionData } from '@/lib/copilot/tools/client/local-completion'

describe('buildToolCompletionData', () => {
  const plan = { objective: 'Build the MES workflow', todoList: ['Add blocks'] }

  it('marks a local-model tool result so the server resumes the local turn', () => {
    expect(
      buildToolCompletionData({
        data: plan,
        selectedModel: 'vllm/qwen3.8-fp8',
        reviewSessionId: 'session-1',
        contextEntityKind: 'workflow',
        contextEntityId: 'workflow-1',
      })
    ).toEqual({
      ...plan,
      local: true,
      reviewSessionId: 'session-1',
      contextEntityKind: 'workflow',
      contextEntityId: 'workflow-1',
    })
  })

  it('carries results that are not plain objects, and results with no data', () => {
    const base = { selectedModel: 'vllm/qwen3.8-fp8', reviewSessionId: 'session-1' }
    expect(buildToolCompletionData({ ...base, data: undefined })).toEqual({
      local: true,
      reviewSessionId: 'session-1',
    })
    expect(buildToolCompletionData({ ...base, data: ['a', 'b'] })).toEqual({
      result: ['a', 'b'],
      local: true,
      reviewSessionId: 'session-1',
    })
    expect(buildToolCompletionData({ ...base, data: 'done' })).toMatchObject({ result: 'done' })
  })

  it('omits a partial entity context', () => {
    expect(
      buildToolCompletionData({
        data: {},
        selectedModel: 'vllm/qwen3.8-fp8',
        reviewSessionId: 'session-1',
        contextEntityKind: 'workflow',
      })
    ).toEqual({ local: true, reviewSessionId: 'session-1' })
  })

  it('leaves hosted-model results and chats without a session unchanged', () => {
    expect(
      buildToolCompletionData({
        data: plan,
        selectedModel: 'claude-sonnet',
        reviewSessionId: 'session-1',
      })
    ).toBe(plan)
    expect(
      buildToolCompletionData({
        data: plan,
        selectedModel: 'vllm/qwen3.8-fp8',
        reviewSessionId: null,
      })
    ).toBe(plan)
    expect(buildToolCompletionData({ data: plan, selectedModel: undefined })).toBe(plan)
  })
})
