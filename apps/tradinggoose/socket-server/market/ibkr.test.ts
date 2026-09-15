/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}))

import {
  buildIbkrQuoteSnapshot,
  buildIbkrStreamUrl,
  IBKR_QUOTE_EMIT_INTERVAL_MS,
  IBKR_STREAM_CONNECT_TIMEOUT_MS,
  IBKR_STREAM_HEARTBEAT_INTERVAL_MS,
  IbkrMarketStream,
  type IbkrStreamRuntime,
  parseIbkrStreamNumber,
} from './ibkr'

class FakeSocket {
  readyState = 0
  sent: string[] = []
  closed = false
  private listeners = new Map<string, Array<(event: any) => void>>()

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>
  ) {}

  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.closed = true
  }

  fire(type: string, event: unknown = {}) {
    if (type === 'open') this.readyState = 1
    if (type === 'close') this.readyState = 3
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  message(payload: unknown) {
    this.fire('message', { data: JSON.stringify(payload) })
  }
}

describe('buildIbkrStreamUrl', () => {
  it('turns the gateway API base URL into its WebSocket URL', () => {
    expect(buildIbkrStreamUrl('http://host.containers.internal:5002/v1/api')).toBe(
      'ws://host.containers.internal:5002/v1/api/ws'
    )
    expect(buildIbkrStreamUrl('https://localhost:5000/v1/api/')).toBe(
      'wss://localhost:5000/v1/api/ws'
    )
  })
})

describe('parseIbkrStreamNumber', () => {
  it('reads prices, percentages and formatted volumes with their markers', () => {
    expect(parseIbkrStreamNumber('7699.50')).toBe(7699.5)
    expect(parseIbkrStreamNumber('C7699.50')).toBe(7699.5)
    expect(parseIbkrStreamNumber('H101.25')).toBe(101.25)
    expect(parseIbkrStreamNumber('-27.75')).toBe(-27.75)
    expect(parseIbkrStreamNumber('-0.36%')).toBe(-0.36)
    expect(parseIbkrStreamNumber('1.25M')).toBe(1_250_000)
    expect(parseIbkrStreamNumber('12,345')).toBe(12_345)
    expect(parseIbkrStreamNumber(42)).toBe(42)
    expect(parseIbkrStreamNumber('N/A')).toBeNull()
    expect(parseIbkrStreamNumber(undefined)).toBeNull()
  })
})

describe('buildIbkrQuoteSnapshot', () => {
  it('builds a quote from streamed fields', () => {
    expect(
      buildIbkrQuoteSnapshot({
        '31': '7699.50',
        '82': '-27.75',
        '83': '-0.36%',
        '7741': '7727.25',
        '7762': '1000',
      })
    ).toEqual({
      lastPrice: 7699.5,
      change: -27.75,
      changePercent: -0.36,
      previousClose: 7727.25,
      volume: 1000,
      volumeUsd: 7_699_500,
    })
  })

  it('derives the previous close from the change when it was not streamed', () => {
    expect(buildIbkrQuoteSnapshot({ '31': '110', '82': '10' })).toMatchObject({
      lastPrice: 110,
      previousClose: 100,
      change: 10,
      changePercent: 10,
    })
  })
})

describe('IbkrMarketStream', () => {
  let sockets: FakeSocket[]
  let runtime: IbkrStreamRuntime
  let onQuote: Mock<(payload: any) => void>
  let onStatus: Mock<(payload: any) => void>
  let onError: Mock<(payload: any) => void>

  const connectedStream = async () => {
    const stream = new IbkrMarketStream({ onQuote, onStatus, onError }, runtime)
    stream.setConid('MESZ26', 730283085)
    stream.subscribe(['MESZ26'])
    await vi.advanceTimersByTimeAsync(0)
    sockets[0]?.fire('open')
    sockets[0]?.message({ topic: 'system', success: 'paper-user', isPaper: true })
    return stream
  }

  beforeEach(() => {
    vi.useFakeTimers()
    sockets = []
    onQuote = vi.fn()
    onStatus = vi.fn()
    onError = vi.fn()
    runtime = {
      url: 'ws://gateway:5002/v1/api/ws',
      createSocket: (url, headers) => {
        const socket = new FakeSocket(url, headers)
        sockets.push(socket)
        return socket
      },
      getSessionId: vi.fn(async () => 'session-abc'),
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('connects with the gateway session cookie and subscribes each contract', async () => {
    const stream = await connectedStream()

    expect(sockets).toHaveLength(1)
    expect(sockets[0].url).toBe('ws://gateway:5002/v1/api/ws')
    expect(sockets[0].headers).toEqual({ Cookie: 'api={"session":"session-abc"}' })
    expect(sockets[0].sent).toEqual([
      'smd+730283085+{"fields":["31","70","71","82","83","84","86","87","7741","7762"]}',
    ])
    expect(onStatus).toHaveBeenCalledWith({ state: 'connected' })
    expect(stream.isConnected()).toBe(true)
    stream.close()
  })

  it('subscribes only after the gateway has authenticated the socket', async () => {
    const stream = new IbkrMarketStream({ onQuote, onStatus, onError }, runtime)
    stream.setConid('MESZ26', 730283085)
    stream.subscribe(['MESZ26'])
    await vi.advanceTimersByTimeAsync(0)

    // A subscription sent on open is ignored by the gateway.
    sockets[0].fire('open')
    expect(sockets[0].sent).toEqual([])
    expect(onStatus).not.toHaveBeenCalled()
    expect(stream.isConnected()).toBe(false)

    sockets[0].message({ topic: 'system', success: 'paper-user', isPaper: true })
    sockets[0].message({ topic: 'sts', args: { authenticated: true } })

    expect(sockets[0].sent).toEqual([
      'smd+730283085+{"fields":["31","70","71","82","83","84","86","87","7741","7762"]}',
    ])
    expect(onStatus).toHaveBeenCalledTimes(1)
    expect(onStatus).toHaveBeenCalledWith({ state: 'connected' })
    stream.close()
  })

  it('subscribes again when the gateway re-authenticates the session', async () => {
    const stream = await connectedStream()

    sockets[0].message({ topic: 'sts', args: { authenticated: false } })
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ state: 'disconnected' }))
    expect(stream.isConnected()).toBe(false)

    sockets[0].message({ topic: 'sts', args: { authenticated: true } })

    expect(sockets[0].sent.filter((message) => message.startsWith('smd+'))).toHaveLength(2)
    expect(stream.isConnected()).toBe(true)
    stream.close()
  })

  it('merges partial updates and emits at most one quote per interval', async () => {
    const stream = await connectedStream()

    sockets[0].message({
      topic: 'smd+730283085',
      conid: 730283085,
      '31': '7699.50',
      '7741': '7727.25',
    })
    sockets[0].message({ topic: 'smd+730283085', conid: 730283085, '31': '7700.00' })
    expect(onQuote).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(IBKR_QUOTE_EMIT_INTERVAL_MS)

    expect(onQuote).toHaveBeenCalledTimes(1)
    expect(onQuote.mock.calls[0][0]).toMatchObject({
      symbol: 'MESZ26',
      snapshot: { lastPrice: 7700, previousClose: 7727.25, change: -27.25 },
    })

    // Messages for other topics or unknown contracts are ignored.
    sockets[0].message({ topic: 'system', hb: 1 })
    sockets[0].message({ topic: 'smd+1', conid: 1, '31': '5' })
    await vi.advanceTimersByTimeAsync(IBKR_QUOTE_EMIT_INTERVAL_MS)
    expect(onQuote).toHaveBeenCalledTimes(1)
    stream.close()
  })

  it('keeps the session alive with tic', async () => {
    const stream = await connectedStream()

    await vi.advanceTimersByTimeAsync(IBKR_STREAM_HEARTBEAT_INTERVAL_MS)

    expect(sockets[0].sent).toContain('tic')
    stream.close()
  })

  it('unsubscribes a contract and closes when nothing is left', async () => {
    const stream = await connectedStream()

    stream.unsubscribe(['MESZ26'])

    expect(sockets[0].sent).toContain('umd+730283085+{}')
    expect(sockets[0].closed).toBe(true)
  })

  it('reconnects and subscribes again after the gateway drops the socket', async () => {
    const stream = await connectedStream()

    sockets[0].fire('close')
    expect(onStatus).toHaveBeenCalledWith({ state: 'disconnected' })

    await vi.advanceTimersByTimeAsync(1_000)
    sockets[1].fire('open')
    sockets[1].message({ topic: 'system', success: 'paper-user', isPaper: true })

    expect(sockets[1].sent).toEqual([
      'smd+730283085+{"fields":["31","70","71","82","83","84","86","87","7741","7762"]}',
    ])
    stream.close()
  })

  it('drops a socket that never opens and retries', async () => {
    const stream = new IbkrMarketStream({ onQuote, onStatus, onError }, runtime)
    stream.setConid('MESZ26', 730283085)
    stream.subscribe(['MESZ26'])
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(IBKR_STREAM_CONNECT_TIMEOUT_MS)

    expect(sockets[0].closed).toBe(true)
    expect(onStatus).toHaveBeenCalledWith({ state: 'disconnected' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sockets).toHaveLength(2)
    stream.close()
  })

  it('drops a socket that opens but is never authenticated', async () => {
    const stream = new IbkrMarketStream({ onQuote, onStatus, onError }, runtime)
    stream.setConid('MESZ26', 730283085)
    stream.subscribe(['MESZ26'])
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].fire('open')

    await vi.advanceTimersByTimeAsync(IBKR_STREAM_CONNECT_TIMEOUT_MS)

    expect(sockets[0].closed).toBe(true)
    expect(sockets[0].sent).toEqual([])
    expect(onStatus).toHaveBeenCalledWith({ state: 'disconnected' })
    stream.close()
  })

  it('reports a session failure and retries later', async () => {
    runtime.getSessionId = vi
      .fn()
      .mockRejectedValueOnce(new Error('IBKR gateway session expired'))
      .mockResolvedValue('session-abc')
    const stream = new IbkrMarketStream({ onQuote, onStatus, onError }, runtime)
    stream.setConid('MESZ26', 730283085)
    stream.subscribe(['MESZ26'])
    await vi.advanceTimersByTimeAsync(0)

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'IBKR gateway session expired' })
    )
    expect(sockets).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(sockets).toHaveLength(1)
    stream.close()
  })
})
