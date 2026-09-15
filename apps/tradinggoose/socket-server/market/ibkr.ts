import { createLogger } from '@/lib/logs/console/logger'
import type { MarketQuoteSnapshot } from '@/lib/market/quote-snapshot-contract'
import type { AssetClass } from '@/providers/market/types'
import { buildIbkrAuthHeaders, isIbkrHostedApi } from '@/providers/trading/ibkr/auth'
import { buildIbkrApiUrl } from '@/providers/trading/ibkr/client'
import { resolveIbkrApiBaseUrl } from '@/providers/trading/ibkr/config'
import { ensureIbkrSession } from '@/providers/trading/ibkr/session'
import { resolveIbkrConidFromApi } from '@/providers/trading/ibkr/symbols'
import { fetchBrokerJson } from '@/providers/trading/portfolio-utils'

const logger = createLogger('IbkrMarketStream')

/**
 * Streaming top-of-book quotes from the IBKR Client Portal Gateway WebSocket.
 *
 * IBKR prices used to be polled: one REST snapshot per listing every 15s, plus
 * the daily bars a quote snapshot needs, all through the gateway's request
 * pacing. Prices therefore moved every 15s at best, and a few widgets polling
 * together drew 429s from the gateway. The gateway pushes quotes over one
 * WebSocket instead, so a streamed price costs no request at all.
 *
 * Protocol (Client Portal Web API):
 * - `ws(s)://<gateway>/v1/api/ws`, authenticated by the cookie
 *   `api={"session":"<id>"}`; the id is the `session` field of `POST /tickle`.
 * - Subscribe `smd+<conid>+{"fields":[...]}`, unsubscribe `umd+<conid>+{}`.
 * - Updates arrive as `{"topic":"smd+<conid>","conid":...,"31":"7699.50",...}`
 *   and carry only the fields that changed.
 * - A `tic` message keeps the session alive.
 * - Subscriptions are only honoured once the gateway has authenticated the
 *   socket: it sends `{"topic":"system","success":"<user>"}` (and `sts` with
 *   `authenticated: true`) first.
 */

/** Market data field ids requested for each listing. */
export const IBKR_STREAM_FIELDS = {
  last: '31',
  high: '70',
  low: '71',
  change: '82',
  changePercent: '83',
  bid: '84',
  ask: '86',
  volume: '87',
  priorClose: '7741',
  volumeRaw: '7762',
} as const

const STREAM_FIELD_IDS = Object.values(IBKR_STREAM_FIELDS)

/** Quotes for one listing are coalesced and emitted at most this often. */
export const IBKR_QUOTE_EMIT_INTERVAL_MS = 250
/** How often `tic` is sent to keep the gateway session alive. */
export const IBKR_STREAM_HEARTBEAT_INTERVAL_MS = 55_000
/** A socket that has not opened by then is dropped and retried. */
export const IBKR_STREAM_CONNECT_TIMEOUT_MS = 10_000
const MAX_RECONNECT_DELAY_MS = 30_000
const SOCKET_OPEN = 1

/**
 * Streaming is on for the local Client Portal Gateway unless
 * `IBKR_MARKET_STREAMING=false`. The hosted OAuth API has no gateway session
 * cookie, so it keeps polling.
 */
export const isIbkrMarketStreamingEnabled = (): boolean =>
  process.env.IBKR_MARKET_STREAMING?.trim().toLowerCase() !== 'false' && !isIbkrHostedApi()

/** The contract id a listing streams under. */
export async function resolveIbkrStreamConid(params: {
  symbol: string
  assetClass?: AssetClass | null
  marketCode?: string
  currency?: string
}): Promise<number> {
  await ensureIbkrSession()
  const { conid } = await resolveIbkrConidFromApi({
    symbol: params.symbol,
    assetClass: params.assetClass,
    context: { marketCode: params.marketCode, currency: params.currency },
  })
  return conid
}

export interface IbkrWebSocketLike {
  readyState: number
  send: (data: string) => void
  close: () => void
  addEventListener: (type: string, listener: (event: any) => void) => void
}

export interface IbkrStreamRuntime {
  /** The WebSocket URL, derived from the gateway API base URL. */
  url: string
  createSocket: (url: string, headers: Record<string, string>) => IbkrWebSocketLike
  /** The gateway session id the WebSocket cookie carries. */
  getSessionId: () => Promise<string>
}

export interface IbkrStreamHandlers {
  onQuote: (payload: { symbol: string; snapshot: MarketQuoteSnapshot; raw: unknown }) => void
  onStatus?: (payload: { state: 'connected' | 'disconnected'; info?: string }) => void
  onError?: (payload: { message: string; detail?: unknown }) => void
}

/** `http://host:5002/v1/api` -> `ws://host:5002/v1/api/ws`. */
export function buildIbkrStreamUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`
  url.search = ''
  return url.toString()
}

const VOLUME_SUFFIX: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 }

/**
 * Numbers arrive as strings with markers: a `C` (previous close) or `H`
 * (halted) prefix on prices, `%` on percentages, and `K`/`M`/`B` on the
 * formatted volume.
 */
export function parseIbkrStreamNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const match = /^[A-Za-z]*\s*([+-]?[\d,]*\.?\d+)\s*([KMB])?\s*%?$/i.exec(value.trim())
  if (!match) return null
  const parsed = Number.parseFloat(match[1].replace(/,/g, ''))
  if (!Number.isFinite(parsed)) return null
  const multiplier = match[2] ? (VOLUME_SUFFIX[match[2].toUpperCase()] ?? 1) : 1
  return parsed * multiplier
}

/** A quote snapshot from the merged fields streamed for one listing. */
export function buildIbkrQuoteSnapshot(fields: Record<string, unknown>): MarketQuoteSnapshot {
  const lastPrice = parseIbkrStreamNumber(fields[IBKR_STREAM_FIELDS.last])
  const streamedChange = parseIbkrStreamNumber(fields[IBKR_STREAM_FIELDS.change])
  const previousClose =
    parseIbkrStreamNumber(fields[IBKR_STREAM_FIELDS.priorClose]) ??
    (lastPrice !== null && streamedChange !== null ? lastPrice - streamedChange : null)
  const change =
    streamedChange ??
    (lastPrice !== null && previousClose !== null ? lastPrice - previousClose : null)
  const changePercent =
    parseIbkrStreamNumber(fields[IBKR_STREAM_FIELDS.changePercent]) ??
    (change !== null && previousClose ? (change / previousClose) * 100 : null)
  const volume =
    parseIbkrStreamNumber(fields[IBKR_STREAM_FIELDS.volumeRaw]) ??
    parseIbkrStreamNumber(fields[IBKR_STREAM_FIELDS.volume])

  return {
    lastPrice,
    change,
    changePercent,
    previousClose,
    ...(volume !== null ? { volume } : {}),
    ...(volume !== null && lastPrice !== null ? { volumeUsd: volume * lastPrice } : {}),
  }
}

/** The gateway runtime: Bun's WebSocket takes headers, which the cookie needs. */
export function createIbkrStreamRuntime(): IbkrStreamRuntime {
  return {
    url: buildIbkrStreamUrl(resolveIbkrApiBaseUrl()),
    createSocket: (url, headers) =>
      // The gateway serves a self-signed certificate on its default https port.
      new WebSocket(url, { headers, tls: { rejectUnauthorized: false } } as any) as any,
    getSessionId: async () => {
      await ensureIbkrSession()
      const status = await fetchBrokerJson<{ session?: string }>({
        providerId: 'ibkr',
        url: buildIbkrApiUrl('/tickle'),
        init: { method: 'POST', headers: buildIbkrAuthHeaders() },
      })
      if (!status?.session) {
        throw new Error('IBKR gateway returned no session for the market data stream')
      }
      return status.session
    },
  }
}

function decodeMessage(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw)
  if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(raw)
  return null
}

export class IbkrMarketStream {
  private readonly runtime: IbkrStreamRuntime
  private readonly handlers: IbkrStreamHandlers
  private socket: IbkrWebSocketLike | null = null
  private open = false
  /** Open and authenticated by the gateway; subscriptions are only sent then. */
  private ready = false
  private connecting = false
  private closedByClient = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private readonly conidBySymbol = new Map<string, number>()
  private readonly desired = new Set<string>()
  private readonly active = new Set<string>()
  private readonly fieldsBySymbol = new Map<string, Record<string, unknown>>()
  private readonly pendingEmits = new Set<string>()

  constructor(
    handlers: IbkrStreamHandlers,
    runtime: IbkrStreamRuntime = createIbkrStreamRuntime()
  ) {
    this.handlers = handlers
    this.runtime = runtime
  }

  /** Registers the contract a listing symbol streams; required before subscribe. */
  setConid(symbol: string, conid: number) {
    this.conidBySymbol.set(symbol, conid)
  }

  isConnected(): boolean {
    return this.ready
  }

  subscribe(symbols: string[]) {
    for (const symbol of symbols) {
      if (!this.conidBySymbol.has(symbol)) continue
      this.desired.add(symbol)
      if (this.ready) this.sendSubscribe(symbol)
    }
    if (this.desired.size > 0) this.ensureConnection()
  }

  unsubscribe(symbols: string[]) {
    for (const symbol of symbols) {
      this.desired.delete(symbol)
      this.fieldsBySymbol.delete(symbol)
      this.pendingEmits.delete(symbol)
      if (this.ready && this.active.has(symbol)) {
        this.send(`umd+${this.conidBySymbol.get(symbol)}+{}`)
      }
      this.active.delete(symbol)
    }
    if (this.desired.size === 0) this.close()
  }

  close() {
    this.closedByClient = true
    this.clearTimers()
    this.desired.clear()
    this.active.clear()
    this.fieldsBySymbol.clear()
    this.pendingEmits.clear()
    this.open = false
    this.ready = false
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.close()
      } catch (error) {
        logger.warn('Failed closing IBKR market data stream', { error })
      }
    }
  }

  private ensureConnection() {
    if (this.socket || this.connecting) return
    this.closedByClient = false
    void this.connect()
  }

  private async connect() {
    this.clearReconnectTimer()
    this.connecting = true
    let sessionId: string
    try {
      sessionId = await this.runtime.getSessionId()
    } catch (error) {
      this.connecting = false
      const message = error instanceof Error ? error.message : 'IBKR session unavailable'
      this.handlers.onError?.({ message, detail: error })
      this.handlers.onStatus?.({ state: 'disconnected', info: message })
      this.scheduleReconnect()
      return
    }
    this.connecting = false
    if (this.closedByClient || this.desired.size === 0) return

    const socket = this.runtime.createSocket(this.runtime.url, {
      Cookie: `api=${JSON.stringify({ session: sessionId })}`,
    })
    this.socket = socket

    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      if (this.socket !== socket || this.ready) return
      this.handlers.onError?.({ message: 'IBKR market data stream did not connect in time' })
      try {
        socket.close()
      } catch {}
      this.handleSocketClosed(socket)
    }, IBKR_STREAM_CONNECT_TIMEOUT_MS)
    this.connectTimer.unref?.()

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      // Not ready yet: the gateway authenticates the socket first (markReady).
      this.open = true
      this.startHeartbeat()
    })

    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      this.handleMessage(event?.data)
    })

    socket.addEventListener('error', (event) => {
      if (this.socket !== socket) return
      this.handlers.onError?.({ message: 'IBKR market data stream error', detail: event })
    })

    socket.addEventListener('close', () => this.handleSocketClosed(socket))
  }

  private handleSocketClosed(socket: IbkrWebSocketLike) {
    if (this.socket !== socket) return
    this.clearConnectTimer()
    this.socket = null
    this.open = false
    this.ready = false
    this.active.clear()
    this.stopHeartbeat()
    this.handlers.onStatus?.({ state: 'disconnected' })
    if (!this.closedByClient && this.desired.size > 0) this.scheduleReconnect()
  }

  private clearConnectTimer() {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  /**
   * The gateway ignores a subscription sent before it has authenticated the
   * socket. The stream used to subscribe on `open`, marking each listing
   * subscribed, so no quote ever arrived and later subscriptions to the same
   * listing were skipped as already sent. Subscriptions now go out once the
   * gateway reports the session, and again whenever it re-authenticates.
   */
  private markReady() {
    this.clearConnectTimer()
    this.ready = true
    this.reconnectAttempts = 0
    this.active.clear()
    for (const symbol of this.desired) this.sendSubscribe(symbol)
    logger.info('IBKR market data stream connected', { symbols: this.desired.size })
    this.handlers.onStatus?.({ state: 'connected' })
  }

  private sendSubscribe(symbol: string) {
    if (this.active.has(symbol)) return
    const conid = this.conidBySymbol.get(symbol)
    if (conid === undefined) return
    this.send(`smd+${conid}+${JSON.stringify({ fields: STREAM_FIELD_IDS })}`)
    this.active.add(symbol)
  }

  private send(message: string) {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return
    try {
      this.socket.send(message)
    } catch (error) {
      this.handlers.onError?.({
        message: 'Failed sending to IBKR market data stream',
        detail: error,
      })
    }
  }

  private handleMessage(raw: unknown) {
    const text = decodeMessage(raw)
    if (!text) return
    let message: any
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    const topic = typeof message?.topic === 'string' ? message.topic : ''

    if (topic === 'system' && message?.success) {
      if (!this.ready) this.markReady()
      return
    }

    if (topic === 'sts') {
      const authenticated = message?.args?.authenticated
      if (authenticated === true && !this.ready) this.markReady()
      if (authenticated === false && this.ready) {
        const info = 'IBKR gateway session is not authenticated; log in at the gateway.'
        this.ready = false
        this.active.clear()
        this.handlers.onError?.({ message: info, detail: message })
        this.handlers.onStatus?.({ state: 'disconnected', info })
      }
      return
    }

    if (!topic.startsWith('smd+')) return
    const conid = Number(topic.slice(4))
    const symbol = this.findSymbol(conid)
    if (!symbol || !this.desired.has(symbol)) return

    if (typeof message.error === 'string' && message.error) {
      this.handlers.onError?.({ message: `IBKR market data: ${message.error}`, detail: message })
      return
    }

    const fields = this.fieldsBySymbol.get(symbol) ?? {}
    let changed = false
    for (const id of STREAM_FIELD_IDS) {
      if (message[id] !== undefined && fields[id] !== message[id]) {
        fields[id] = message[id]
        changed = true
      }
    }
    this.fieldsBySymbol.set(symbol, fields)
    if (changed) this.scheduleEmit(symbol)
  }

  private findSymbol(conid: number): string | undefined {
    for (const [symbol, candidate] of this.conidBySymbol) {
      if (candidate === conid) return symbol
    }
    return undefined
  }

  private scheduleEmit(symbol: string) {
    this.pendingEmits.add(symbol)
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      const symbols = [...this.pendingEmits]
      this.pendingEmits.clear()
      for (const pending of symbols) {
        const fields = this.fieldsBySymbol.get(pending)
        if (!fields) continue
        const snapshot = buildIbkrQuoteSnapshot(fields)
        if (snapshot.lastPrice === null) continue
        this.handlers.onQuote({ symbol: pending, snapshot, raw: { ...fields } })
      }
    }, IBKR_QUOTE_EMIT_INTERVAL_MS)
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => this.send('tic'), IBKR_STREAM_HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.closedByClient) return
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** this.reconnectAttempts)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closedByClient && this.desired.size > 0) void this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private clearTimers() {
    this.clearReconnectTimer()
    this.clearConnectTimer()
    this.stopHeartbeat()
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
  }
}
