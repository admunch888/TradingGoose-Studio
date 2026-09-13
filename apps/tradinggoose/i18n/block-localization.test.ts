import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { getAllBlockTypes, getBlock } from '@/blocks/registry'
import { getLocalizedBlockMetadata } from './block-editor'
import type { LocaleCode } from './utils'

// vitest.setup.ts mocks @/blocks/registry with a 5-block fixture; this suite must
// assert against the real registry the workflow toolbar enumerates.
vi.unmock('@/blocks/registry')

const messagesDir = fileURLToPath(new URL('./messages', import.meta.url))

const locales = readdirSync(messagesDir)
  .filter((fileName) => fileName.endsWith('.json'))
  .map((fileName) => fileName.replace(/\.json$/, ''))
  .sort()

type BlockEditorCopy = {
  blockNames?: Record<string, string | undefined>
  blockDescriptions?: Record<string, string | undefined>
}

function readBlockEditorCopy(locale: string): BlockEditorCopy {
  const raw = readFileSync(join(messagesDir, `${locale}.json`), 'utf8')
  const copy = JSON.parse(raw)
  return (copy?.workspace?.widgets?.blockEditor ?? {}) as BlockEditorCopy
}

describe('block localization coverage', () => {
  it('ships more than one locale bundle', () => {
    expect(locales.length).toBeGreaterThan(1)
  })

  it('localizes the name and description of every registered block type in every locale', () => {
    const registeredTypes = getAllBlockTypes().filter((blockType) => getBlock(blockType))
    expect(registeredTypes.length).toBeGreaterThan(0)

    const missing: string[] = []

    for (const locale of locales) {
      const { blockNames, blockDescriptions } = readBlockEditorCopy(locale)

      for (const blockType of registeredTypes) {
        // Mirrors requireLocalizedBlockText in i18n/workflow-inspector-core.ts: a registered
        // block without localized copy throws at palette build time and kills the toolbar.
        if (typeof blockNames?.[blockType] !== 'string') {
          missing.push(`${locale}:workspace.widgets.blockEditor.blockNames.${blockType}`)
        }
        if (typeof blockDescriptions?.[blockType] !== 'string') {
          missing.push(`${locale}:workspace.widgets.blockEditor.blockDescriptions.${blockType}`)
        }
      }
    }

    expect(missing).toEqual([])
  })

  it('resolves localized palette metadata for every registered block type', () => {
    const registeredTypes = getAllBlockTypes()
    expect(registeredTypes.length).toBeGreaterThan(0)

    for (const locale of locales as LocaleCode[]) {
      for (const blockType of registeredTypes) {
        const block = getBlock(blockType)
        if (!block) {
          throw new Error(`Registry returned no config for block type "${blockType}".`)
        }

        expect(() => getLocalizedBlockMetadata(locale, block)).not.toThrow()
      }
    }
  })
})
