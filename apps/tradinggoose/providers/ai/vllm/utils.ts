import type { ChatCompletionChunk } from 'openai/resources/chat/completions'
import type { CompletionUsage } from 'openai/resources/completions'
import type { Message } from '@/providers/ai/types'
import { createOpenAICompatibleStream } from '@/providers/ai/utils'

/**
 * Creates a ReadableStream from a vLLM streaming response.
 * Uses the shared OpenAI-compatible streaming utility.
 */
export function createReadableStreamFromVLLMStream(
  vllmStream: AsyncIterable<ChatCompletionChunk>,
  onComplete?: (content: string, usage: CompletionUsage) => void
): ReadableStream<Uint8Array> {
  return createOpenAICompatibleStream(vllmStream, 'vLLM', onComplete)
}

/** The user turn added to a request that has none. */
export const VLLM_IMPLICIT_USER_MESSAGE = 'Follow the instructions above.'

/**
 * Qwen3-family chat templates (and others) refuse a conversation with no user
 * turn ("No user query found in messages"), and SGLang answers with an empty
 * 400 before the model runs. An Agent block whose whole prompt is its system
 * prompt (plus skills) sent exactly that, so a minimal user turn is added when
 * none is present.
 */
export function withUserMessage(messages: Message[]): Message[] {
  if (messages.some((message) => message.role === 'user')) return messages
  return [...messages, { role: 'user', content: VLLM_IMPLICIT_USER_MESSAGE }]
}

/**
 * The shape of a request's messages, for logging a refusal without logging the
 * conversation: roles in order (tool call counts on assistant steps), whether a
 * user turn is present, and the size.
 */
export function summarizeVllmMessages(messages: Message[]): {
  messageCount: number
  roles: string
  hasUserMessage: boolean
  estimatedChars: number
} {
  return {
    messageCount: messages.length,
    roles: messages
      .map((message) =>
        message.tool_calls?.length
          ? `${message.role}(calls:${message.tool_calls.length})`
          : message.role
      )
      .join(','),
    hasUserMessage: messages.some((message) => message.role === 'user'),
    estimatedChars: messages.reduce((total, message) => total + JSON.stringify(message).length, 0),
  }
}
