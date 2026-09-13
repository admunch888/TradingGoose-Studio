'use client'

import { type FormEvent, useId, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { type ListingResolved, MANUAL_LISTING_ASSET_CLASSES } from '@/lib/listing/identity'
import { buildManualListingValue } from '@/lib/listing/manual'
import { useWorkspaceWidgetsMessages } from '@/i18n/workspace-widget-hooks'

export type ManualListingEntryProps = {
  /** What the operator already typed, used to prefill rather than replace. */
  initialSymbol?: string
  initialAssetClass?: string | null
  initialMarketCode?: string | null
  onUse: (listing: ListingResolved) => void
}

/**
 * Author a listing BY IDENTITY, for a symbol the hosted catalogue has no row
 * for. Shown in the picker only when a search returned nothing.
 *
 * The fields are exactly what the catalogue row would have supplied and the
 * provider genuinely needs: the symbol, and the asset class a provider picks
 * its instrument type from (IBKR asks for `secType=FUT` only because the asset
 * class is `future`). A market is optional and only narrows the venue.
 *
 * Submit is refused until the identity the schema accepts can be built, so a
 * half-filled form hands nothing to the chart.
 */
export function ManualListingEntry({
  initialSymbol = '',
  initialAssetClass = null,
  initialMarketCode = '',
  onUse,
}: ManualListingEntryProps) {
  const copy = useWorkspaceWidgetsMessages().listingSelector
  const fieldId = useId()
  const [symbol, setSymbol] = useState(initialSymbol)
  const [assetClass, setAssetClass] = useState(initialAssetClass ?? '')
  const [marketCode, setMarketCode] = useState(initialMarketCode ?? '')

  // The same builder the picker hands to the chart: if it cannot produce an
  // identity, there is nothing to submit.
  const value = useMemo(
    () => buildManualListingValue({ symbol, assetClass, marketCode }),
    [symbol, assetClass, marketCode]
  )

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!value) return
    onUse(value)
  }

  const fieldClassName = 'h-8 text-sm'

  return (
    <form
      onSubmit={handleSubmit}
      className='space-y-2 border-t p-3'
      data-market-selector
      data-manual-listing
    >
      <p className='text-muted-foreground text-xs'>{copy.noListingsFound}</p>
      <p className='text-muted-foreground text-xs'>{copy.manualHint}</p>

      <div className='flex flex-col gap-2 sm:flex-row'>
        <div className='flex-1 space-y-1.5'>
          <label className='text-muted-foreground text-xs' htmlFor={`${fieldId}-symbol`}>
            {copy.manualSymbol}
          </label>
          <Input
            id={`${fieldId}-symbol`}
            name='manual-listing-symbol'
            aria-label={copy.manualSymbol}
            className={fieldClassName}
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
          />
        </div>
        <div className='space-y-1.5 sm:w-[9rem]'>
          <label className='text-muted-foreground text-xs' htmlFor={`${fieldId}-asset-class`}>
            {copy.manualAssetClass}
          </label>
          <select
            id={`${fieldId}-asset-class`}
            name='manual-listing-asset-class'
            aria-label={copy.manualAssetClass}
            className='flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
            value={assetClass}
            onChange={(event) => setAssetClass(event.target.value)}
          >
            <option value='' />
            {MANUAL_LISTING_ASSET_CLASSES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <div className='space-y-1.5 sm:w-[9rem]'>
          <label className='text-muted-foreground text-xs' htmlFor={`${fieldId}-market`}>
            {copy.manualMarket}
          </label>
          <Input
            id={`${fieldId}-market`}
            name='manual-listing-market'
            aria-label={copy.manualMarket}
            className={fieldClassName}
            value={marketCode}
            onChange={(event) => setMarketCode(event.target.value)}
          />
        </div>
      </div>

      <div className='flex items-center justify-between gap-3'>
        <p className='text-muted-foreground text-xs'>{copy.manualInvalid}</p>
        <Button type='submit' size='sm' variant='secondary' disabled={!value}>
          {copy.manualUse}
        </Button>
      </div>
    </form>
  )
}
