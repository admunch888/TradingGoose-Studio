import { z } from 'zod'

export const LISTING_IDENTITY_VALUE_TYPE = 'json' as const

export const KronosStatus = {
  DISABLED: 'disabled',
  ENABLED: 'enabled',
} as const

export type KronosStatus = (typeof KronosStatus)[keyof typeof KronosStatus]

const marketBarSchema = z.object({
  timestamp: z.string(),
  open: z.number().positive().finite(),
  high: z.number().positive().finite(),
  low: z.number().positive().finite(),
  close: z.number().positive().finite(),
  volume: z.number().min(0).finite().nullable().optional(),
  amount: z.number().min(0).finite().nullable().optional(),
})

const isValidTimezone = (value: string): boolean => {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value })
    return true
  } catch {
    return false
  }
}

export const ForecastRequestSchema = z
  .object({
    requestId: z.string().min(1).max(255),
    listing: z.object({
      listingId: z.string().min(1).max(255),
      listingType: z.string().min(1).max(64),
    }),
    interval: z.string().min(1).max(16),
    timezone: z.string().min(1).max(64).refine(isValidTimezone, {
      message: 'timezone must be a valid IANA timezone',
    }),
    normalizationMode: z.string().min(1).max(32).default('raw'),
    history: z.array(marketBarSchema).min(32).max(512),
    futureTimestamps: z.array(z.string()).min(1).max(32),
    parameters: z
      .object({
        temperature: z.number().positive().max(5).default(1.0),
        topP: z.number().positive().max(1).default(0.9),
        // The upper bound is KRONOS_MAX_SAMPLES, which the client enforces: an env
        // value cannot be read from a schema literal. Above it the service refuses.
        sampleCount: z.number().int().positive().default(1),
      })
      .default({ temperature: 1.0, topP: 0.9, sampleCount: 1 }),
  })
  .refine(
    (data) => {
      const timestamps = data.history.map((bar) => bar.timestamp)
      const unique = new Set(timestamps)
      return unique.size === timestamps.length
    },
    { message: 'historical timestamps must be unique' }
  )
  .refine(
    (data) => {
      const timestamps = data.history.map((bar) => bar.timestamp)
      for (let i = 1; i < timestamps.length; i++) {
        if (timestamps[i] <= timestamps[i - 1]) return false
      }
      return true
    },
    { message: 'historical timestamps must be strictly increasing' }
  )
  .refine(
    (data) => {
      const lastBar = data.history[data.history.length - 1].timestamp
      return data.futureTimestamps.every((timestamp) => timestamp > lastBar)
    },
    { message: 'future timestamps must be after the final historical timestamp' }
  )

export type ForecastRequest = z.infer<typeof ForecastRequestSchema>

const ForecastBandSchema = z.object({
  low: z.number(),
  high: z.number(),
})

export type ForecastBand = z.infer<typeof ForecastBandSchema>

// How much the sampled paths agreed on direction: the share whose terminal close landed
// above the last historical close. Absent, not null, at one sample (there is no agreement
// in a single path), so anything reading it must handle `undefined`.
const ForecastEnsembleSchema = z.object({
  sampleCount: z.number().int(),
  // Both ends are real answers - a unanimous ensemble reports exactly 0 or 1 - so the
  // bounds are inclusive.
  shareUp: z.number().min(0).max(1),
})

export type ForecastEnsemble = z.infer<typeof ForecastEnsembleSchema>

export const ForecastPointSchema = z.object({
  timestamp: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
  amount: z.number(),
  // The 10th/90th percentile of the sampled closes at this step. Absent, not
  // null, when the forecast ran a single sample (`response_model_exclude_none`),
  // and absent entirely from a service that does not compute bands.
  band: ForecastBandSchema.optional(),
})

export const ForecastResponseSchema = z.object({
  requestId: z.string(),
  forecast: z.array(ForecastPointSchema),
  model: z.object({
    name: z.string(),
    sourceRevision: z.string(),
    modelRevision: z.string(),
    tokenizerRevision: z.string(),
    device: z.string(),
    maxContext: z.number().int(),
  }),
  input: z.object({
    listing: z.object({
      listingId: z.string(),
      listingType: z.string(),
    }),
    interval: z.string(),
    timezone: z.string(),
    normalizationMode: z.string(),
    barCount: z.number().int(),
    lastCompletedBarTimestamp: z.string(),
  }),
  parameters: z.object({
    temperature: z.number(),
    topP: z.number(),
    sampleCount: z.number().int(),
  }),
  // The count actually reduced and the share of samples that agreed on direction, omitted
  // by the service at one sample (`response_model_exclude_none`).
  ensemble: ForecastEnsembleSchema.optional(),
  diagnostics: z.object({
    volumeImputed: z.boolean(),
    amountImputed: z.boolean(),
    candleReconciliationCount: z.number().int(),
    warnings: z.array(z.string()),
  }),
  timingMs: z.object({
    queue: z.number(),
    inference: z.number(),
    total: z.number(),
  }),
})

export type ForecastResponse = z.infer<typeof ForecastResponseSchema>

export const KronosErrorCode = {
  DISABLED: 'KRONOS_DISABLED',
  UNAVAILABLE: 'KRONOS_UNAVAILABLE',
  TIMEOUT: 'KRONOS_TIMEOUT',
  INVALID_RESPONSE: 'KRONOS_INVALID_RESPONSE',
  LISTING_REQUIRED: 'KRONOS_LISTING_REQUIRED',
  MARKET_DATA_REQUIRED: 'KRONOS_MARKET_DATA_REQUIRED',
  INTERVAL_REQUIRED: 'KRONOS_INTERVAL_REQUIRED',
  TOO_FEW_BARS: 'KRONOS_TOO_FEW_BARS',
  TOO_MANY_BARS: 'KRONOS_TOO_MANY_BARS',
  HORIZON_EXCEEDED: 'KRONOS_HORIZON_EXCEEDED',
  SAMPLE_LIMIT_EXCEEDED: 'KRONOS_SAMPLE_LIMIT_EXCEEDED',
  MARKET_DATA_STALE: 'KRONOS_MARKET_DATA_STALE',
} as const

export type KronosErrorCode = (typeof KronosErrorCode)[keyof typeof KronosErrorCode]

export class KronosError extends Error {
  constructor(
    public readonly code: KronosErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'KronosError'
  }
}
