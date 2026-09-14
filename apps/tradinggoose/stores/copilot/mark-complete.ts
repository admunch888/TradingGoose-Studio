type ContinuationHandler = (params: {
  toolCallId: string
  response: Response
  /** When the completion was posted, to tell a later Stop from an earlier one. */
  postedAt?: number
}) => Promise<void>

export type CopilotMarkCompleteRequest = {
  toolCallId: string
  toolName: string
  status: number
  message?: unknown
  data?: unknown
}

let continuationHandler: ContinuationHandler | null = null
const postedAtByToolCallId = new Map<string, number>()

export function registerCopilotMarkCompleteContinuationHandler(handler: ContinuationHandler): void {
  continuationHandler = handler
}

export function postCopilotMarkCompleteRequest(
  params: CopilotMarkCompleteRequest,
  signal?: AbortSignal
): Promise<Response> {
  postedAtByToolCallId.set(params.toolCallId, Date.now())
  return fetch('/api/copilot/tools/mark-complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      id: params.toolCallId,
      name: params.toolName,
      status: params.status,
      message: params.message,
      data: params.data,
    }),
  })
}

export async function maybeHandleCopilotMarkCompleteContinuation(params: {
  toolCallId: string
  response: Response
}): Promise<boolean> {
  const postedAt = postedAtByToolCallId.get(params.toolCallId)
  postedAtByToolCallId.delete(params.toolCallId)

  const contentType = params.response.headers.get('content-type') || ''
  if (!contentType.includes('text/event-stream') || !params.response.body || !continuationHandler) {
    return false
  }

  await continuationHandler({ ...params, postedAt })
  return true
}
