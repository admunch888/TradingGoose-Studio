import { describe, expect, it } from 'vitest'
import type { Message } from '@/providers/ai/types'
import {
  normalizeMessageOrder,
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

describe('normalizeMessageOrder', () => {
  it('moves system instructions in front of the block context', () => {
    // The Agent block sends its context first, then its system and user prompts.
    const messages: Message[] = [
      { role: 'user', content: 'chain json' },
      { role: 'system', content: 'You are an options analyst.' },
      { role: 'user', content: 'Evaluate this chain.' },
    ]

    expect(normalizeMessageOrder(messages)).toEqual([
      { role: 'system', content: 'You are an options analyst.' },
      { role: 'user', content: 'chain json' },
      { role: 'user', content: 'Evaluate this chain.' },
    ])
  })

  it('merges several system messages into the leading one', () => {
    const messages: Message[] = [
      { role: 'system', content: 'Playbook.' },
      { role: 'user', content: 'Evaluate this chain.' },
      { role: 'system', content: 'Skills: options-playbook.' },
    ]

    expect(normalizeMessageOrder(messages)).toEqual([
      { role: 'system', content: 'Playbook.\n\nSkills: options-playbook.' },
      { role: 'user', content: 'Evaluate this chain.' },
    ])
  })

  it('leaves a conversation that already leads with one system message unchanged', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are an options analyst.' },
      { role: 'user', content: 'Evaluate this chain.' },
    ]

    expect(normalizeMessageOrder(messages)).toBe(messages)
  })

  it('leaves a conversation with no system message unchanged', () => {
    const messages: Message[] = [{ role: 'user', content: 'Evaluate this chain.' }]

    expect(normalizeMessageOrder(messages)).toBe(messages)
  })
})
