/**
 * What a model server said when it refused a request. The OpenAI SDK's error
 * serialises to its status and headers only, so a SGLang/vLLM 400 was logged
 * without the reason (for example an unanswered tool call). The message and
 * parsed body are what make the refusal diagnosable.
 */
export function describeModelServerError(error: unknown): {
  status?: number
  message?: string
  body?: unknown
} {
  if (!error || typeof error !== 'object') {
    return { message: String(error) }
  }
  const record = error as { status?: unknown; message?: unknown; error?: unknown }
  return {
    ...(typeof record.status === 'number' ? { status: record.status } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ...(record.error !== undefined ? { body: record.error } : {}),
  }
}
