/**
 * @vitest-environment jsdom
 *
 * Contracts between the Historical Data block and the market-series execution path.
 *
 * A workflow the editor saved must be runnable. Historically the block emitted
 * `start`/`end` while the tool required a compound `window`, so every fresh block
 * died at dispatch with `"Window" is required for Market Series Fetch`.
 */
import { describe, expect, it, vi } from 'vitest'
import { HistoricalDataBlock } from '@/blocks/blocks/historical_data'
import { getMarketProvidersByKind, getMarketSeriesCapabilities } from '@/providers/market/providers'
import { resolveDefaultSeriesInterval } from '@/providers/market/series-window'
import { Serializer } from '@/serializer/index'
import { historicalDataTool } from '@/tools/market_data/series'
import { validateRequiredParametersAfterMerge } from '@/tools/utils'

// The serializer reads block configs through `getBlock` from `@/blocks`; the full
// registry is not resolvable under vitest, so expose the real block here.
vi.mock('@/blocks', async () => {
  const actual = await vi.importActual<typeof import('@/blocks/blocks/historical_data')>(
    '@/blocks/blocks/historical_data'
  )
  return {
    getBlock: (type: string) =>
      type === 'historical_data' ? actual.HistoricalDataBlock : undefined,
  }
})

const SERIES_PROVIDERS = getMarketProvidersByKind('series').map((provider) => provider.id)

const LISTING = {
  listing_type: 'default',
  listing_id: 'AAPL',
  base_id: '',
  quote_id: '',
} as const

const buildParams = (overrides: Record<string, any> = {}) =>
  HistoricalDataBlock.tools.config!.params!({
    provider: SERIES_PROVIDERS[0],
    listing: LISTING,
    ...overrides,
  } as any)

const buildBlock = (subBlocks: Record<string, any>) =>
  ({
    id: 'historical-data-1',
    type: 'historical_data',
    name: 'Historical Data',
    position: { x: 0, y: 0 },
    subBlocks,
    outputs: {},
    enabled: true,
  }) as any

describe('historical data block -> tool contract', () => {
  it('defaults a fresh block to a window the selected provider accepts', () => {
    for (const provider of SERIES_PROVIDERS) {
      const params = buildParams({ provider })
      const window = params.window
      const capabilities = getMarketSeriesCapabilities(provider)

      expect(window, `${provider} should emit a window`).toBeTruthy()
      expect(capabilities?.windowModes ?? [], `${provider} window modes`).toContain(window.mode)
      expect(window.mode).toBe('bars')
      expect(window.barCount).toBeGreaterThanOrEqual(300)
      expect(window.barCount).toBeLessThanOrEqual(500)

      // The tool filters windows by the provider's advertised modes; a default the
      // provider rejects would arrive here as an empty list.
      const body = historicalDataTool.request.body!(params as any) as { windows: any[] }
      expect(body.windows, `${provider} request windows`).toEqual([window])
    }
  })

  it('turns the Start/End inputs into an absolute window instead of dropping them', () => {
    const params = buildParams({
      provider: 'ibkr',
      start: '2024-01-01T00:00:00.000Z',
      end: '2024-06-01T00:00:00.000Z',
    })

    expect(params.window).toEqual({
      mode: 'absolute',
      start: '2024-01-01T00:00:00.000Z',
      end: '2024-06-01T00:00:00.000Z',
    })
  })

  it('keeps a provider-supported explicit window', () => {
    const params = buildParams({ provider: 'ibkr', window: { mode: 'bars', barCount: 120 } })

    expect(params.window).toEqual({ mode: 'bars', barCount: 120 })
  })

  it('only emits an interval default the provider actually supports', () => {
    for (const provider of SERIES_PROVIDERS) {
      const params = buildParams({ provider })
      const capabilities = getMarketSeriesCapabilities(provider)!
      const intervals = capabilities.intervals ?? []

      if (capabilities.supportsInterval === false || intervals.length === 0) {
        expect(params.interval, provider).toBeUndefined()
      } else {
        expect(intervals, provider).toContain(params.interval)
      }
    }
  })

  it('resolves no interval default for providers that reject intervals', () => {
    expect(
      resolveDefaultSeriesInterval({ supportsInterval: false, intervals: ['1d'] })
    ).toBeUndefined()
    expect(resolveDefaultSeriesInterval({ intervals: [] })).toBeUndefined()
    expect(resolveDefaultSeriesInterval(null)).toBeUndefined()
  })

  it('prefers a daily interval when the provider supports it', () => {
    expect(resolveDefaultSeriesInterval({ supportsInterval: true, intervals: ['5m', '1d'] })).toBe(
      '1d'
    )
    expect(resolveDefaultSeriesInterval({ supportsInterval: true, intervals: ['10m', '1h'] })).toBe(
      '10m'
    )
  })
})

describe('historical data block -> pre-dispatch validation', () => {
  it('reports a missing provider before dispatch, naming the block and the input', () => {
    const serializer = new Serializer()

    expect(() =>
      serializer.serializeWorkflow(
        {
          'historical-data-1': buildBlock({
            provider: { value: null },
            listing: { value: LISTING },
          }),
        },
        [],
        {},
        undefined,
        true
      )
    ).toThrow('Historical Data is missing required fields: Data Provider')
  })

  it('reports a missing listing before dispatch, naming the block and the input', () => {
    const serializer = new Serializer()

    expect(() =>
      serializer.serializeWorkflow(
        {
          'historical-data-1': buildBlock({
            provider: { value: 'ibkr' },
            listing: { value: null },
          }),
        },
        [],
        {},
        undefined,
        true
      )
    ).toThrow('Historical Data is missing required fields: Listing')
  })

  it('serializes a fully configured block into tool params the tool accepts', () => {
    const serializer = new Serializer()

    const workflow = serializer.serializeWorkflow(
      {
        'historical-data-1': buildBlock({
          provider: { value: 'ibkr' },
          listing: { value: LISTING },
        }),
      },
      [],
      {},
      undefined,
      true
    )

    const serialized = workflow.blocks[0]
    expect(serialized.config.tool).toBe('historical_data_fetch')

    // The executor applies the block transform over resolver inputs before executeTool.
    const dispatched = HistoricalDataBlock.tools.config!.params!(serialized.config.params as any)

    expect(dispatched.window).toBeTruthy()
    expect(() =>
      validateRequiredParametersAfterMerge(
        'historical_data_fetch',
        historicalDataTool,
        dispatched as any
      )
    ).not.toThrow()

    const body = historicalDataTool.request.body!(dispatched as any) as { windows: any[] }
    expect(body.windows).toEqual([{ mode: 'bars', barCount: 500 }])
  })
})
