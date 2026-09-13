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
import { getListingIdentitySymbol, parseListingIdentityValueStrict } from '@/lib/listing/identity'
import { createLogger } from '@/lib/logs/console/logger'
import { generateRequestId } from '@/lib/utils'

const logger = createLogger('KronosForecastRoute')

const nonEmptyStringSchema = z.string().trim().min(1)

// The block/tool payload. `workspaceId` is supplied by the framework as a query
// param and `idempotencyKey` is not part of the current contract, so both are
// accepted but optional.
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

/**
 * Derive the forecast target timestamps by advancing the last history bar by
 * the request interval.
 *
 * Limits: this is plain calendar arithmetic on the last bar's instant, so it
 * does not model trading sessions, exchange holidays or half days - a 1d
 * forecast over a weekend lands on the calendar next day, not the next trade
 * date. Month steps use UTC calendar months (so 31 Jan + 1mo lands in March).
 */
const deriveFutureTimestamps = (
  lastTimestamp: string,
  interval: string,
  horizonBars: number
): string[] => {
  const last = Date.parse(lastTimestamp)
  if (!Number.isFinite(last)) {
    throw new Error('History must end with a valid timestamp')
  }

  const step = resolveIntervalStep(interval)
  const futureTimestamps: string[] = []

  for (let index = 1; index <= horizonBars; index++) {
    if ('months' in step) {
      const date = new Date(last)
      date.setUTCMonth(date.getUTCMonth() + step.months * index)
      futureTimestamps.push(date.toISOString())
      continue
    }
    futureTimestamps.push(new Date(last + step.ms * index).toISOString())
  }

  return futureTimestamps
}

const buildForecastRequest = (requestId: string, body: ForecastRequestBody): unknown => {
  const listing = parseListingIdentityValueStrict(body.listing)
  const history = buildHistory(body.marketSeries)
  const lastBar = history[history.length - 1].timestamp as string

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
    futureTimestamps: deriveFutureTimestamps(lastBar, body.interval, body.horizonBars),
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
