import { describe, expect, it } from 'vitest'
import {
  getReviewItemIdsReplacedByTranscriptRewrite,
  isLocalWorkingItem,
  LOCAL_WORKING_SEQUENCE_BASE,
} from '@/lib/copilot/local-runtime/working-rows'

describe('getReviewItemIdsReplacedByTranscriptRewrite', () => {
  it('replaces transcript rows and pre-range working rows, and keeps current working rows', () => {
    const items = [
      { id: 'transcript-user', itemId: 'message-1', content: 'Build the workflow', sequence: 0 },
      { id: 'transcript-reply', itemId: 'local_assistant_1', content: 'Done', sequence: 1 },
      {
        id: 'legacy-working',
        itemId: 'local_tool_calls_old',
        content: '[[local-working]]{"tool_calls":[]}',
        sequence: 7,
      },
      {
        id: 'working-user',
        itemId: 'local_user_message-1',
        content: '[[local-working]]{"text":"Build the workflow","role":"user"}',
        sequence: LOCAL_WORKING_SEQUENCE_BASE,
      },
      {
        id: 'working-result',
        itemId: 'local_tool_result_call_1',
        content: '[[local-working]]{"content":"{}","toolCallId":"call_1"}',
        sequence: LOCAL_WORKING_SEQUENCE_BASE + 1,
      },
    ]

    expect(getReviewItemIdsReplacedByTranscriptRewrite(items)).toEqual([
      'transcript-user',
      'transcript-reply',
      'legacy-working',
    ])
  })
})

describe('isLocalWorkingItem', () => {
  it('recognises working rows by item id or content, and nothing in the transcript', () => {
    expect(
      isLocalWorkingItem({
        itemId: 'local_tool_calls_1',
        content: '[[local-working]]{"tool_calls":[]}',
      })
    ).toBe(true)
    expect(isLocalWorkingItem({ itemId: 'local_user_message-1', content: '' })).toBe(true)
    expect(isLocalWorkingItem({ itemId: 'message-1', content: 'Build the workflow' })).toBe(false)
    expect(isLocalWorkingItem({ itemId: 'local_assistant_1', content: 'Here is the plan' })).toBe(
      false
    )
  })
})
