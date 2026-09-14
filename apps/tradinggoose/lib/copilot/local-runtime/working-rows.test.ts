import { describe, expect, it } from 'vitest'
import {
  isLocalWorkingItem,
  LOCAL_WORKING_SEQUENCE_BASE,
  rebaseLocalWorkingRows,
} from '@/lib/copilot/local-runtime/working-rows'

describe('rebaseLocalWorkingRows', () => {
  it('numbers working rows above the transcript in saved order, detached from turns', () => {
    const rows = [
      { itemId: 'local_tool_calls_1', sequence: 9, turnId: 'turn-1' },
      { itemId: 'local_user_message-1', sequence: 4, turnId: null },
      { itemId: 'local_tool_result_call_1', sequence: 1_000_000_003, turnId: null },
    ]

    expect(rebaseLocalWorkingRows(rows)).toEqual([
      { itemId: 'local_user_message-1', sequence: LOCAL_WORKING_SEQUENCE_BASE, turnId: null },
      { itemId: 'local_tool_calls_1', sequence: LOCAL_WORKING_SEQUENCE_BASE + 1, turnId: null },
      {
        itemId: 'local_tool_result_call_1',
        sequence: LOCAL_WORKING_SEQUENCE_BASE + 2,
        turnId: null,
      },
    ])
    // The rows read from the database are left as they were.
    expect(rows[0]).toEqual({ itemId: 'local_tool_calls_1', sequence: 9, turnId: 'turn-1' })
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
