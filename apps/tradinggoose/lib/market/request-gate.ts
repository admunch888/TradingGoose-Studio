import { createHash } from 'crypto'
import { readServerJsonCache, writeServerJsonCache } from '@/lib/cache/server-json-cache'
import { MARKET_API_URL_DEFAULT } from '@/lib/market/client/constants'
import { resolveMarketApiServiceConfig } from '@/lib/system-services/runtime'

const CACHE_PREFIX = 'market:request:v1:'
const STALE_CACHE_PREFIX = 'market:request:stale:v1:'
const CACHE_TTL_SECONDS = 60 * 5
/** Listing, currency, crypto and timezone rows change rarely. */
const REFERENCE_CACHE_TTL_SECONDS = 60 * 60 * 6
const MARKET_HOURS_CACHE_TTL_SECONDS = 60 * 60
/** How long a last good `get` answer stays available while the catalogue refuses. */
const STALE_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000
const MAX_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000
const REFERENCE_GET_PATH = /^\/api\/get\/(listing|currency|crypto|timezone)$/
const STRIP_CACHED_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding'])
const inFlight = new Map<string, Promise<CachedMarketResponse>>()

type CachedMarketResponse = {
  body: string
  headers: Array<[string, string]>
  status: number
}

/**
 * The catalogue's last rate-limit refusal. While it holds, requests are answered
 * locally instead of being sent: every refused request still counts against the
 * quota, so retrying through a refusal is what kept the limit from ever resetting.
 */
let rateLimit: { until: number; response: CachedMarketResponse } | null = null

export type TradingGooseMarketRequestInit = RequestInit & {
  apiKey?: string | null
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

const cacheHashForUrl = (rawUrl: string) => {
  const url = new URL(rawUrl)
  const sortedParams = new URLSearchParams(
    Array.from(url.searchParams.entries()).sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyComparison = leftKey.localeCompare(rightKey)
      return keyComparison === 0 ? leftValue.localeCompare(rightValue) : keyComparison
    })
  )
  url.search = sortedParams.toString()
  return hash(url.toString())
}

const isGetPath = (pathname: string) => pathname === '/api/get' || pathname.startsWith('/api/get/')

const isCacheable = (url: string, method: string) => {
  if (method !== 'GET') return false
  const pathname = new URL(url).pathname
  return pathname === '/api/search' || pathname.startsWith('/api/search/') || isGetPath(pathname)
}

const cacheTtlSecondsFor = (pathname: string) => {
  if (pathname === '/api/get/market-hours') return MARKET_HOURS_CACHE_TTL_SECONDS
  if (REFERENCE_GET_PATH.test(pathname)) return REFERENCE_CACHE_TTL_SECONDS
  return CACHE_TTL_SECONDS
}

const toResponse = (cached: CachedMarketResponse) =>
  new Response(cached.body, {
    headers: new Headers(cached.headers),
    status: cached.status,
  })

const toCachedResponse = async (response: Response): Promise<CachedMarketResponse> => ({
  body: await response.text(),
  headers: Array.from(response.headers.entries()).filter(
    ([key]) => !STRIP_CACHED_HEADERS.has(key.toLowerCase())
  ),
  status: response.status,
})

/** `Retry-After` as seconds or an HTTP date, bounded; a minute when absent. */
export const parseRetryAfterMs = (value: string | null, now = Date.now()): number => {
  const trimmed = value?.trim()
  if (!trimmed) return DEFAULT_RATE_LIMIT_COOLDOWN_MS
  const seconds = Number(trimmed)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(trimmed) - now
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_RATE_LIMIT_COOLDOWN_MS
  return Math.min(Math.max(ms, 1000), MAX_RATE_LIMIT_COOLDOWN_MS)
}

const recordRateLimit = (response: CachedMarketResponse) => {
  const retryAfter = response.headers.find(([key]) => key.toLowerCase() === 'retry-after')?.[1]
  rateLimit = { until: Date.now() + parseRetryAfterMs(retryAfter ?? null), response }
}

const activeRateLimit = () => (rateLimit && rateLimit.until > Date.now() ? rateLimit : null)

const replayRateLimit = (active: NonNullable<typeof rateLimit>) => {
  const headers = new Headers(active.response.headers)
  headers.set('retry-after', String(Math.max(1, Math.ceil((active.until - Date.now()) / 1000))))
  return new Response(active.response.body, { headers, status: active.response.status })
}

export async function requestTradingGooseMarket(
  endpoint: string,
  init: TradingGooseMarketRequestInit = {}
): Promise<Response> {
  const { apiKey, headers, method: rawMethod = 'GET', ...rest } = init
  const method = rawMethod.toUpperCase()
  const marketApi = await resolveMarketApiServiceConfig()
  const url = new URL(endpoint, marketApi.baseUrl || MARKET_API_URL_DEFAULT).toString()
  const pathname = new URL(url).pathname
  const requestHeaders = new Headers(headers)
  const resolvedApiKey = apiKey === undefined ? marketApi.apiKey : apiKey

  if (!requestHeaders.get('content-type')) requestHeaders.set('content-type', 'application/json')
  if (resolvedApiKey) requestHeaders.set('x-api-key', resolvedApiKey)
  else requestHeaders.delete('x-api-key')

  const requestInit: RequestInit = { ...rest, cache: 'no-store', headers: requestHeaders, method }

  if (!isCacheable(url, method)) {
    const cooling = activeRateLimit()
    if (cooling) return replayRateLimit(cooling)
    const response = await fetch(url, requestInit)
    if (response.status === 429) recordRateLimit(await toCachedResponse(response.clone()))
    return response
  }

  const cacheHash = cacheHashForUrl(url)
  const cacheKey = `${CACHE_PREFIX}${cacheHash}`
  const staleCacheKey = `${STALE_CACHE_PREFIX}${cacheHash}`
  const servesStale = isGetPath(pathname)

  const cached = await readServerJsonCache<CachedMarketResponse>(cacheKey)
  if (cached) return toResponse(cached)

  const cooling = activeRateLimit()
  if (cooling) {
    const stale = servesStale
      ? await readServerJsonCache<CachedMarketResponse>(staleCacheKey)
      : null
    return stale ? toResponse(stale) : replayRateLimit(cooling)
  }

  const pending = inFlight.get(cacheKey)
  if (pending) return toResponse(await pending)

  const request = (async () => {
    const response = await fetch(url, requestInit)
    const cachedResponse = await toCachedResponse(response)
    if (response.ok) {
      await writeServerJsonCache(cacheKey, cachedResponse, cacheTtlSecondsFor(pathname))
      if (servesStale) {
        await writeServerJsonCache(staleCacheKey, cachedResponse, STALE_CACHE_TTL_SECONDS)
      }
      return cachedResponse
    }
    if (response.status === 429) recordRateLimit(cachedResponse)
    // A refused or failed lookup falls back to the last good answer, so saved
    // charts keep resolving while the catalogue is unavailable.
    if (servesStale) {
      const stale = await readServerJsonCache<CachedMarketResponse>(staleCacheKey)
      if (stale) return stale
    }
    return cachedResponse
  })()

  inFlight.set(cacheKey, request)
  try {
    return toResponse(await request)
  } finally {
    inFlight.delete(cacheKey)
  }
}
