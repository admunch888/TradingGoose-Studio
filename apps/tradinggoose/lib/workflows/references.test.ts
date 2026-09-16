/**
 * Reference extraction has to coexist with `<` and `>` as comparison operators,
 * because condition blocks are JavaScript expressions that also contain
 * references. Getting that wrong does not fail where it happens: the expression
 * resolves partially, and the block throws at run time on the leftover `<`,
 * after its gates have passed and its data has been fetched.
 */
import { describe, expect, it } from 'vitest'
import { extractReferencePrefixes, isLikelyReferenceSegment } from '@/lib/workflows/references'

describe('a condition that compares with < and >', () => {
  // From a live workflow whose Guard failed with "Unexpected token '<'".
  const condition =
    '!(Number.isFinite(<nextexpiry.result.daysToExpiry>)) || ' +
    '<nextexpiry.result.daysToExpiry> < 7 || <nextexpiry.result.daysToExpiry> > 60'

  it('finds every reference, including the one after a less-than', () => {
    const found = extractReferencePrefixes(condition)

    // The scan used to run from the `<` before `7` through to the next
    // reference's closing `>`, swallowing it whole. Two resolved, the third did
    // not, and the leftover `<` broke evaluation.
    expect(found).toHaveLength(3)
    expect(found.every((match) => match.raw === '<nextexpiry.result.daysToExpiry>')).toBe(true)
  })

  it('does not mistake bare operators for references', () => {
    expect(extractReferencePrefixes('a < b > c')).toEqual([])
  })

  it('finds a reference that follows a greater-than', () => {
    expect(extractReferencePrefixes('<a.x> > <b.y>').map((m) => m.raw)).toEqual(['<a.x>', '<b.y>'])
  })

  it('finds references either side of a less-than', () => {
    expect(extractReferencePrefixes('<a.x> < <b.y>').map((m) => m.raw)).toEqual(['<a.x>', '<b.y>'])
  })
})

describe('ordinary references', () => {
  it('reads the block prefix', () => {
    expect(extractReferencePrefixes('<agent.content>')).toEqual([
      { raw: '<agent.content>', prefix: 'agent' },
    ])
  })

  it('reads several in one value', () => {
    expect(extractReferencePrefixes('<a.x> and <b.y>').map((m) => m.prefix)).toEqual(['a', 'b'])
  })

  it.each([
    ['no references', 'plain text'],
    ['an empty string', ''],
  ])('returns nothing for %s', (_label, value) => {
    expect(extractReferencePrefixes(value)).toEqual([])
  })
})

describe('what counts as a reference segment', () => {
  it.each(['<agent.content>', '<variable.killSwitch>', '<optionschain.summary>'])(
    'accepts %s',
    (segment) => {
      expect(isLikelyReferenceSegment(segment)).toBe(true)
    }
  )

  it.each([
    ['a bare operator', '< >'],
    ['a leading space', '< agent.content>'],
    ['arithmetic', '<a + b>'],
  ])('rejects %s', (_label, segment) => {
    expect(isLikelyReferenceSegment(segment)).toBe(false)
  })
})
