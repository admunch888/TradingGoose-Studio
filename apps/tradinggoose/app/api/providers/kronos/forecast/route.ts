import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkSessionOrInternalAuth } from '@/lib/auth/hybrid'
import {
  callKronosForecast,
  isKronosEnabled,
  type KronosCallContext,
  KronosError,
  KronosErrorCode,
} from '@/lib/kronos'
import { type ForecastRequest, ForecastRequestSchema } from '@/lib/kronos/types'
import {
  getListingIdentitySymbol,
  type ListingIdentity,
  parseListingIdentityValueStrict,
} from '@/lib/listing/identity'
import { createLogger } from '@/lib/logs/console/logger'
import { generateRequestId } from '@/lib/utils'

const logger = createLogger('KronosForecastRoute')

const nonEmptyStringSchema = z.string().trim().min(1)

// The block/tool payload. `workspaceId` is supplied by the framework as a query
// param and `idempotencyKey` is not part of the current contract, so both are
// accepted but optional. `listing` is optional: without it the market series'
// own listing is used (see resolveForecastListing).
const forecastRequestSchema = z
  .object({
    workspaceId: nonEmptyStringSchema.optional(),
    idempotencyKey: nonEmptyStringSchema.optional(),
    listing: z.unknown(),
    marketSeries: z.unknown(),
    interval: nonEmptyStringSchema,
    timezone: nonEmptyStringSchema,
    normalizationMode: nonEmptyStringSchema.optional(),
    horizonBars: z.number().int().positive().finite(),
    parameters: z
      .object({
        temperature: z.number().positive().max(5).optional(),
        topP: z.number().positive().max(1).optional(),
        sampleCount: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict()

type ForecastRequestBody = z.infer<typeof forecastRequestSchema>

const parseRequestBody = async (request: NextRequest): Promise<ForecastRequestBody | Response> => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request data' }, { status: 400 })
  }

  const parsed = forecastRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request data', details: parsed.error.issues },
      { status: 400 }
    )
  }
  return parsed.data
}

/**
 * Timestamp stepping for the intervals the market data layer emits
 * (providers/market/types/base.ts MARKET_INTERVALS). Anything else is rejected
 * rather than guessed at.
 */
const INTERVAL_STEP_MS: Record<string, number> = {
  '1m': 60_000,
  '2m': 120_000,
  '3m': 180_000,
  '5m': 300_000,
  '10m': 600_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '45m': 2_700_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '3h': 10_800_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
  '2w': 1_209_600_000,
}

const INTERVAL_STEP_MONTHS: Record<string, number> = {
  '1mo': 1,
  '3mo': 3,
  '6mo': 6,
  '12mo': 12,
}

// Provider-specific interval tokens (e.g. IBKR/Alpha Vantage bar sizes) that
// describe the same canonical step.
const INTERVAL_ALIASES: Record<string, string> = {
  '1min': '1m',
  '5min': '5m',
  '15min': '15m',
  '30min': '30m',
  '60min': '1h',
}

const SUPPORTED_INTERVALS = [...Object.keys(INTERVAL_STEP_MS), ...Object.keys(INTERVAL_STEP_MONTHS)]

const resolveIntervalStep = (interval: string): { ms: number } | { months: number } => {
  const normalized = interval.trim().toLowerCase()
  const canonical = INTERVAL_ALIASES[normalized] ?? normalized

  const ms = INTERVAL_STEP_MS[canonical]
  if (ms !== undefined) return { ms }

  const months = INTERVAL_STEP_MONTHS[canonical]
  if (months !== undefined) return { months }

  throw new Error(
    `Unsupported interval "${interval}" for Kronos forecasting (supported: ${SUPPORTED_INTERVALS.join(', ')})`
  )
}

const toFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const readBarTimestamp = (record: Record<string, unknown>, index: number): string => {
  const raw = record.timeStamp ?? record.timestamp
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`marketSeries.bars[${index}] is missing a timestamp`)
  }
  const parsed = Date.parse(raw.trim())
  if (!Number.isFinite(parsed)) {
    throw new Error(`marketSeries.bars[${index}] has an invalid timestamp`)
  }
  // Normalize to a fixed-width UTC ISO string so the lexicographic ordering the
  // ForecastRequest schema enforces matches chronological order.
  return new Date(parsed).toISOString()
}

/**
 * Map the Historical Data block's normalized market series onto the forecast
 * request's market bar shape. The series bars are already normalized OHLCV, so
 * missing open/high/low fall back to the close rather than being invented.
 */
const buildHistory = (marketSeries: unknown): Array<Record<string, unknown>> => {
  const bars = (marketSeries as { bars?: unknown } | null | undefined)?.bars
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new Error('marketSeries.bars must contain at least one historical bar')
  }

  const records = bars.map((bar) =>
    bar && typeof bar === 'object' ? (bar as Record<string, unknown>) : {}
  )

  // volume/amount must be present for every bar or omitted for every bar, both
  // for the request schema and the inference service.
  const hasUniformVolume = records.every((record) => toFiniteNumber(record.volume) !== undefined)
  const hasUniformAmount = records.every((record) => toFiniteNumber(record.turnover) !== undefined)

  return records.map((record, index) => {
    const timestamp = readBarTimestamp(record, index)
    const close = toFiniteNumber(record.close)
    if (close === undefined) {
      throw new Error(`marketSeries.bars[${index}].close must be a finite number`)
    }
    const open = toFiniteNumber(record.open) ?? close
    const high = Math.max(toFiniteNumber(record.high) ?? close, open, close)
    const low = Math.min(toFiniteNumber(record.low) ?? close, open, close)

    return {
      timestamp,
      open,
      high,
      low,
      close,
      volume: hasUniformVolume ? toFiniteNumber(record.volume) : undefined,
      amount: hasUniformAmount ? toFiniteNumber(record.turnover) : undefined,
    }
  })
}

const DAY_MS = 86_400_000

/** Upper bound on candidate steps, so a degenerate calendar cannot loop forever. */
const MAX_CANDIDATE_STEPS = 200_000

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

interface LocalTime {
  weekday: number
  dateKey: string
  minuteOfDay: number
}

/** Reads an instant's wall-clock weekday, date and minute in the listing's timezone. */
const createLocalTimeReader = (timezone: string): ((instant: number) => LocalTime) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (instant) => {
    const parts: Record<string, string> = {}
    for (const part of formatter.formatToParts(new Date(instant))) {
      parts[part.type] = part.value
    }
    return {
      weekday: WEEKDAY_INDEX[parts.weekday],
      dateKey: `${parts.year}-${parts.month}-${parts.day}`,
      minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
    }
  }
}

interface TradingCalendar {
  tradesWeekends: boolean
  /** First and last bar minute-of-day seen, only when the history spans several days. */
  session?: { openMinute: number; closeMinute: number }
}

/**
 * Infer when the listing trades from its own history, so no exchange calendar is
 * needed: weekend bars mean a 24/7 market (crypto), and several days of bars give
 * the session's first and last bar time. A single day of bars says nothing about
 * the session, so it only contributes the weekend rule.
 */
const inferTradingCalendar = (
  historyMs: number[],
  readLocalTime: (instant: number) => LocalTime
): TradingCalendar => {
  const times = historyMs.map(readLocalTime)
  const tradesWeekends = times.some((time) => time.weekday === 0 || time.weekday === 6)
  if (new Set(times.map((time) => time.dateKey)).size < 2) {
    return { tradesWeekends }
  }

  const minutes = times.map((time) => time.minuteOfDay)
  return {
    tradesWeekends,
    session: { openMinute: Math.min(...minutes), closeMinute: Math.max(...minutes) },
  }
}

/**
 * Derive the forecast target timestamps from the last history bar.
 *
 * Kronos encodes each target's minute, hour, weekday and date, so targets have
 * to land where bars actually occur: steps skip weekends unless the history
 * trades them, intraday steps stay inside the session inferred from the history,
 * and day-or-longer steps keep the bar's wall-clock time across DST changes.
 *
 * Limits: exchange holidays and half days are not modelled. Month steps use UTC
 * calendar months (so 31 Jan + 1mo lands in March).
 */
const deriveFutureTimestamps = (
  historyTimestamps: string[],
  interval: string,
  horizonBars: number,
  timezone: string
): string[] => {
  const historyMs = historyTimestamps.map((timestamp) => Date.parse(timestamp))
  const last = historyMs[historyMs.length - 1]
  if (!Number.isFinite(last)) {
    throw new Error('History must end with a valid timestamp')
  }

  const step = resolveIntervalStep(interval)
  const futureTimestamps: string[] = []

  if ('months' in step) {
    for (let index = 1; index <= horizonBars; index++) {
      const date = new Date(last)
      date.setUTCMonth(date.getUTCMonth() + step.months * index)
      futureTimestamps.push(date.toISOString())
    }
    return futureTimestamps
  }

  const readLocalTime = createLocalTimeReader(timezone)
  const calendar = inferTradingCalendar(historyMs, readLocalTime)
  const intraday = step.ms < DAY_MS

  const advance = (instant: number): number => {
    const next = instant + step.ms
    if (intraday) return next
    // Keep the bar's wall-clock time when a DST change falls between two bars.
    let driftMinutes = readLocalTime(instant).minuteOfDay - readLocalTime(next).minuteOfDay
    if (driftMinutes > 720) driftMinutes -= 1440
    if (driftMinutes < -720) driftMinutes += 1440
    return next + driftMinutes * 60_000
  }

  const isTradingTime = (instant: number): boolean => {
    const time = readLocalTime(instant)
    if (!calendar.tradesWeekends && (time.weekday === 0 || time.weekday === 6)) {
      return false
    }
    if (intraday && calendar.session) {
      return (
        time.minuteOfDay >= calendar.session.openMinute &&
        time.minuteOfDay <= calendar.session.closeMinute
      )
    }
    return true
  }

  let cursor = last
  for (let steps = 0; futureTimestamps.length < horizonBars; steps++) {
    if (steps >= MAX_CANDIDATE_STEPS) {
      throw new Error(
        'Could not place future timestamps within the trading calendar inferred from the history'
      )
    }
    cursor = advance(cursor)
    if (isTradingTime(cursor)) {
      futureTimestamps.push(new Date(cursor).toISOString())
    }
  }

  return futureTimestamps
}

const isBlankListing = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '')

export const KRONOS_MISSING_LISTING_MESSAGE =
  'Kronos needs a listing: set Listing, or pass the market series from a Historical Data block, which carries its listing.'

/**
 * The listing a forecast is for. An explicit listing wins; without one, the
 * market series names it. The Historical Data block's series carries the listing
 * it fetched, so a Kronos block wired to that series needs no listing search of
 * its own - and cannot forecast a different instrument than the history it got.
 *
 * Resolved here rather than in the block, because the executor discards the
 * block's params transform when it throws and dispatches the stored values.
 */
const resolveForecastListing = (listing: unknown, marketSeries: unknown): ListingIdentity => {
  if (!isBlankListing(listing)) return parseListingIdentityValueStrict(listing)

  const seriesListing =
    marketSeries && typeof marketSeries === 'object'
      ? (marketSeries as { listing?: unknown }).listing
      : undefined
  if (isBlankListing(seriesListing)) {
    throw new Error(KRONOS_MISSING_LISTING_MESSAGE)
  }
  return parseListingIdentityValueStrict(seriesListing)
}

const buildForecastRequest = (requestId: string, body: ForecastRequestBody): unknown => {
  const listing = resolveForecastListing(body.listing, body.marketSeries)
  const history = buildHistory(body.marketSeries)
  const historyTimestamps = history.map((bar) => bar.timestamp as string)

  return {
    requestId,
    listing: {
      listingId: getListingIdentitySymbol(listing),
      listingType: listing.listing_type,
    },
    interval: body.interval,
    timezone: body.timezone,
    normalizationMode: body.normalizationMode,
    history,
    futureTimestamps: deriveFutureTimestamps(
      historyTimestamps,
      body.interval,
      body.horizonBars,
      body.timezone
    ),
    parameters: body.parameters,
  }
}

const mapKronosError = (error: KronosError): Response => {
  switch (error.code) {
    case KronosErrorCode.DISABLED:
      return NextResponse.json({ error: error.message }, { status: 404 })
    case KronosErrorCode.UNAVAILABLE:
      return NextResponse.json({ error: error.message }, { status: 503 })
    case KronosErrorCode.TIMEOUT:
      return NextResponse.json({ error: error.message }, { status: 504 })
    case KronosErrorCode.HORIZON_EXCEEDED:
    case KronosErrorCode.TOO_FEW_BARS:
    case KronosErrorCode.TOO_MANY_BARS:
      return NextResponse.json({ error: error.message }, { status: 422 })
    default:
      return NextResponse.json({ error: error.message }, { status: 502 })
  }
}

export async function POST(request: NextRequest) {
  if (!isKronosEnabled()) {
    return NextResponse.json({ error: 'Kronos forecasting is not enabled' }, { status: 404 })
  }

  const requestId = generateRequestId()
  const requestData = await parseRequestBody(request)
  if (requestData instanceof Response) return requestData

  const auth = await checkSessionOrInternalAuth(request, {
    requireWorkflowId: false,
  })
  if (!auth.success || !auth.userId) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 })
  }

  let forecastRequest: ForecastRequest
  try {
    const assembled = buildForecastRequest(requestId, requestData)
    const parsed = ForecastRequestSchema.safeParse(assembled)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid forecast request', details: parsed.error.issues },
        { status: 400 }
      )
    }
    forecastRequest = parsed.data
  } catch (error) {
    logger.warn('Kronos forecast request rejected', { requestId, error })
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid forecast request' },
      { status: 400 }
    )
  }

  try {
    const searchParams = new URL(request.url).searchParams
    const context: KronosCallContext = {
      workflowId: searchParams.get('workflowId')?.trim() || undefined,
      executionId: searchParams.get('executionId')?.trim() || undefined,
      workspaceId:
        searchParams.get('workspaceId')?.trim() || requestData.workspaceId || auth.workspaceId,
      userId: auth.userId,
    }
    const response = await callKronosForecast(forecastRequest, context)

    return NextResponse.json(response)
  } catch (error) {
    if (error instanceof KronosError) {
      return mapKronosError(error)
    }
    logger.error('Kronos forecast failed', { requestId, error })
    return NextResponse.json({ error: 'Kronos forecast failed' }, { status: 502 })
  }
}
