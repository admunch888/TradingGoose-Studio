import { describe, expect, it } from 'vitest'
import type { Message } from '@/providers/ai/types'
import {
  summarizeVllmMessages,
  VLLM_IMPLICIT_USER_MESSAGE,
  withUserMessage,
} from '@/providers/ai/vllm/utils'

describe('withUserMessage', () => {
  it('adds a user turn to a conversation that has none', () => {
    // An Agent block with only a system prompt (and skills) sends this.
    const messages: Message[] = [{ role: 'system', content: 'You are an options analyst.' }]

    expect(withUserMessage(messages)).toEqual([
      { role: 'system', content: 'You are an options analyst.' },
      { role: 'user', content: VLLM_IMPLICIT_USER_MESSAGE },
    ])
    expect(messages).toHaveLength(1)
  })

  it('returns a conversation that has a user turn unchanged', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are an options analyst.' },
      { role: 'user', content: 'Evaluate this chain.' },
    ]

    expect(withUserMessage(messages)).toBe(messages)
  })
})

describe('summarizeVllmMessages', () => {
  it('describes the request shape without its content', () => {
    const summary = summarizeVllmMessages([
      { role: 'system', content: 'secret playbook' },
      { role: 'user', content: 'Evaluate this chain.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'load_skill', arguments: '{}' } },
        ],
      } as Message,
    ])

    expect(summary).toMatchObject({
      messageCount: 3,
      roles: 'system,user,assistant(calls:1)',
      hasUserMessage: true,
    })
    expect(JSON.stringify(summary)).not.toContain('secret playbook')
  })
})
