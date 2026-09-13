/**
 * @vitest-environment jsdom
 *
 * The manual listing form is the authoring surface for a symbol the catalogue
 * has nothing for. It must not invent an id, must not fabricate catalogue
 * metadata, and must refuse to hand over anything the identity schema rejects.
 */

import { act, type ComponentProps } from 'react'
import { NextIntlClientProvider } from 'next-intl'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicCopy } from '@/i18n/public-copy'
import { ManualListingEntry } from './manual-listing-entry'

const reactActEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }

const setNativeValue = (element: HTMLInputElement | HTMLSelectElement, value: string) => {
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })
  )
}

describe('ManualListingEntry', () => {
  let container: HTMLDivElement
  let root: Root
  const copy = getPublicCopy('en').workspace.widgets.listingSelector

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  const render = async (props: Partial<ComponentProps<typeof ManualListingEntry>> = {}) => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale='en' messages={getPublicCopy('en')}>
          <ManualListingEntry onUse={vi.fn()} {...props} />
        </NextIntlClientProvider>
      )
    })
  }

  const symbolInput = () =>
    container.querySelector<HTMLInputElement>('input[name="manual-listing-symbol"]')
  const assetClassSelect = () =>
    container.querySelector<HTMLSelectElement>('select[name="manual-listing-asset-class"]')
  const submit = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')

  it('submits the symbol that was typed, with the asset class it was given', async () => {
    const onUse = vi.fn()
    await render({ onUse })

    act(() => {
      if (!symbolInput() || !assetClassSelect()) throw new Error('Expected manual listing fields')
      setNativeValue(symbolInput()!, 'mesz26')
      setNativeValue(assetClassSelect()!, 'future')
    })
    await act(async () => {
      submit()?.click()
    })

    expect(onUse).toHaveBeenCalledTimes(1)
    expect(onUse.mock.calls[0][0]).toMatchObject({
      listingIdentity: {
        listing_id: 'mesz26',
        base_id: '',
        quote_id: '',
        listing_type: 'default',
        manual: { assetClass: 'future' },
      },
      base: 'mesz26',
      assetClass: 'future',
    })
  })

  it('carries the market when one is given', async () => {
    const onUse = vi.fn()
    await render({ onUse })

    act(() => {
      setNativeValue(symbolInput()!, 'MESZ26')
      setNativeValue(assetClassSelect()!, 'future')
      setNativeValue(
        container.querySelector<HTMLInputElement>('input[name="manual-listing-market"]')!,
        'CME'
      )
    })
    await act(async () => {
      submit()?.click()
    })

    expect(onUse.mock.calls[0][0].listingIdentity.manual).toEqual({
      assetClass: 'future',
      marketCode: 'CME',
    })
  })

  it('prefills from what the operator already typed', async () => {
    await render({ initialSymbol: 'MESZ26', initialAssetClass: 'future' })

    expect(symbolInput()?.value).toBe('MESZ26')
    expect(assetClassSelect()?.value).toBe('future')
  })

  it('refuses to submit an identity the schema would reject', async () => {
    const onUse = vi.fn()
    await render({ onUse })

    expect(submit()?.disabled).toBe(true)
    await act(async () => {
      submit()?.click()
    })

    act(() => setNativeValue(symbolInput()!, 'MESZ26'))
    await act(async () => {
      submit()?.click()
    })
    expect(onUse).not.toHaveBeenCalled()

    act(() => setNativeValue(assetClassSelect()!, 'future'))
    expect(submit()?.disabled).toBe(false)
  })

  it('says what the manual path is and is not, in the copy the operator reads', async () => {
    await render({ initialSymbol: 'MESZ26', initialAssetClass: 'future' })

    expect(container.textContent).toContain(copy.manualHint)
    expect(container.textContent).toContain(copy.noListingsFound)
    expect(submit()?.textContent).toContain(copy.manualUse)
  })
})
