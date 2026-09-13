/** @vitest-environment jsdom */

import { act } from 'react'
import type { ISeriesApi } from 'lightweight-charts'
import { createRoot, type Root } from 'react-dom/client'
import type { Socket } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import type { ListingIdentity } from '@/lib/listing/identity'
import type { MarketSessionWindow } from '@/providers/market/types'
import type { BarMs } from '@/widgets/widgets/data_chart/series-data'
import type { DataChartDataContext } from '@/widgets/widgets/data_chart/types'
import {
  mapQuoteSnapshotToMarketBar,
  selectLiveSubscriptionChannel,
  useLiveBars,
} from './use-live-bars'

const AAPL_IDENTITY: ListingIdentity = {
  listing_id: 'AAPL',
  base_id: '',
  quote_id: '',
  listing_type: 'default',
}

type Handler = (payload: any) => void

const createFakeSocket = () => {
  const handlers = new Map<string, Set<Handler>>()
  const emitted: Array<{ event: string; payload: any }> = []
  const socket = {
    on(event: string, handler: Handler) {
      const set = handlers.get(event) ?? new Set<Handler>()
      set.add(handler)
      handlers.set(event, set)
      return socket
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler)
      return socket
    },
    emit(event: string, payload?: any) {
      emitted.push({ event, payload })
      return socket
    },
    fire(event: string, payload?: any) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload)
    },
    handlerCount(event: string) {
      return handlers.get(event)?.size ?? 0
    },
    lastEmitted(event: string) {
      return [...emitted].reverse().find((entry) => entry.event === event)
    },
  }
  return socket
}

describe('selectLiveSubscriptionChannel', () => {
  it('selects quote-snapshots for a provider that only declares that channel (IBKR)', () => {
    expect(selectLiveSubscriptionChannel(['quote-snapshots'])).toBe('quote-snapshots')
  })

  it('keeps streaming providers on trades', () => {
    expect(selectLiveSubscriptionChannel(['bars', 'trades', 'quotes'])).toBe('trades')
    expect(selectLiveSubscriptionChannel(['trades', 'bars'])).toBe('trades')
  })

  it('returns null when no live channel is declared', () => {
    expect(selectLiveSubscriptionChannel(null)).toBeNull()
    expect(selectLiveSubscriptionChannel(undefined)).toBeNull()
    expect(selectLiveSubscriptionChannel([])).toBeNull()
  })

  it('returns null for channels this widget cannot render', () => {
    expect(selectLiveSubscriptionChannel(['quotes'])).toBeNull()
    expect(selectLiveSubscriptionChannel(['bars'])).toBeNull()
  })
})

describe('mapQuoteSnapshotToMarketBar', () => {
  it('maps lastPrice into a flat bar', () => {
    const bar = mapQuoteSnapshotToMarketBar({ lastPrice: 187.25 }, '2026-09-12T15:00:00.000Z')
    expect(bar).toEqual({
      timeStamp: '2026-09-12T15:00:00.000Z',
      open: 187.25,
      high: 187.25,
      low: 187.25,
      close: 187.25,
    })
  })

  it('returns null when the snapshot has no usable price', () => {
    expect(mapQuoteSnapshotToMarketBar(null, '2026-09-12T15:00:00.000Z')).toBeNull()
    expect(mapQuoteSnapshotToMarketBar(undefined, '2026-09-12T15:00:00.000Z')).toBeNull()
    expect(mapQuoteSnapshotToMarketBar({ lastPrice: null }, '2026-09-12T15:00:00.000Z')).toBeNull()
    expect(
      mapQuoteSnapshotToMarketBar({ lastPrice: Number.NaN }, '2026-09-12T15:00:00.000Z')
    ).toBeNull()
  })
})

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

describe('useLiveBars live subscription', () => {
  let container: HTMLDivElement
  let root: Root
  let socket: ReturnType<typeof createFakeSocket>
  let api: ReturnType<typeof useLiveBars>
  let dataContext: DataChartDataContext
  let series: { seriesType: () => string; update: Mock; setData: Mock }
  let mainSeriesRef: { current: ISeriesApi<'Candlestick'> | null }
  let onDataUpdated: Mock
  let onError: Mock

  const createDataContext = (): DataChartDataContext => ({
    barsMsRef: { current: [] as BarMs[] },
    indexByOpenTimeMsRef: { current: new Map<number, number>() },
    openTimeMsByIndexRef: { current: [] as number[] },
    marketSessionsRef: { current: [] as MarketSessionWindow[] },
    intervalMs: 60_000,
    dataVersion: 0,
  })

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    socket = createFakeSocket()
    series = { seriesType: () => 'Candlestick', update: vi.fn(), setData: vi.fn() }
    mainSeriesRef = { current: series as unknown as ISeriesApi<'Candlestick'> }
    dataContext = createDataContext()
    onDataUpdated = vi.fn()
    onError = vi.fn()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  })

  const renderHook = async (providerId: string) => {
    const props = {
      socket: socket as unknown as Socket,
      workspaceId: 'ws-1',
      providerId,
      listing: AAPL_IDENTITY,
      interval: '1m',
      providerParams: {},
      auth: {},
      enabled: true,
      candleType: 'candlestick',
      mainSeriesRef,
      dataContext,
      onError,
      onDataUpdated,
    }
    function Harness() {
      api = useLiveBars(props)
      return null
    }
    await act(async () => {
      root.render(<Harness />)
    })
  }

  it('subscribes IBKR charts to the quote-snapshots channel they declare', async () => {
    await renderHook('ibkr')
    act(() => api.startLiveSubscription())

    const subscribe = socket.lastEmitted('market-subscribe')
    expect(subscribe?.payload).toMatchObject({
      provider: 'ibkr',
      channel: 'quote-snapshots',
      listing: AAPL_IDENTITY,
    })
    expect(socket.handlerCount('market-quote-snapshot')).toBe(1)
  })

  it('feeds a market-quote-snapshot into the bar-apply path', async () => {
    await renderHook('ibkr')
    act(() => api.startLiveSubscription())

    act(() => {
      socket.fire('market-quote-snapshot', {
        provider: 'ibkr',
        channel: 'quote-snapshots',
        listing: AAPL_IDENTITY,
        snapshot: { lastPrice: 187.25, change: 1, changePercent: 0.5, previousClose: 186.25 },
      })
    })

    expect(dataContext.barsMsRef.current).toHaveLength(1)
    expect(dataContext.barsMsRef.current[0]?.close).toBe(187.25)
    expect(onDataUpdated).toHaveBeenCalledTimes(1)
    expect(series.setData.mock.calls.length + series.update.mock.calls.length).toBe(1)
  })

  it('ignores a market-quote-snapshot whose price is unusable', async () => {
    await renderHook('ibkr')
    act(() => api.startLiveSubscription())

    act(() => {
      socket.fire('market-quote-snapshot', {
        provider: 'ibkr',
        channel: 'quote-snapshots',
        listing: AAPL_IDENTITY,
        snapshot: { lastPrice: null },
      })
    })

    expect(dataContext.barsMsRef.current).toHaveLength(0)
    expect(onDataUpdated).not.toHaveBeenCalled()
  })

  it('does not subscribe for a provider without declared live channels', async () => {
    await renderHook('unknown-broker')
    act(() => api.startLiveSubscription())

    expect(socket.lastEmitted('market-subscribe')).toBeUndefined()
    expect(socket.handlerCount('market-quote-snapshot')).toBe(0)
    expect(socket.handlerCount('market-trade')).toBe(0)
  })

  it('keeps alpaca on the trades channel and applies market-trade updates', async () => {
    await renderHook('alpaca')
    act(() => api.startLiveSubscription())

    const subscribe = socket.lastEmitted('market-subscribe')
    expect(subscribe?.payload).toMatchObject({ provider: 'alpaca', channel: 'trades' })

    const tradeTimeStamp = new Date(Date.now() + 1_000).toISOString()
    act(() => {
      socket.fire('market-trade', {
        provider: 'alpaca',
        channel: 'trades',
        listing: AAPL_IDENTITY,
        trade: { timeStamp: tradeTimeStamp, price: 190.5, size: 3 },
      })
    })

    expect(dataContext.barsMsRef.current).toHaveLength(1)
    expect(dataContext.barsMsRef.current[0]?.close).toBe(190.5)
    expect(onDataUpdated).toHaveBeenCalledTimes(1)
  })

  it('detaches the snapshot listener when the subscription stops', async () => {
    await renderHook('ibkr')
    act(() => api.startLiveSubscription())
    expect(socket.handlerCount('market-quote-snapshot')).toBe(1)

    act(() => api.stopLiveSubscription())
    expect(socket.handlerCount('market-quote-snapshot')).toBe(0)
    expect(socket.handlerCount('market-trade')).toBe(0)
  })
})
