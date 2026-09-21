import type { KronosSignalResult } from '@/lib/kronos/signal'
import type { ToolConfig, ToolResponse } from '@/tools/types'

export interface KronosSignalParams {
  workspaceId?: string
  idempotencyKey?: string
  forecast?: unknown
  marketSeries?: unknown
  config?: unknown
}

export interface KronosSignalResponse extends ToolResponse {
  output: KronosSignalResult
}

export const kronosSignalTool: ToolConfig<KronosSignalParams, KronosSignalResponse> = {
  id: 'kronos_signal',
  name: 'Kronos Signal',
  description: 'Turn a Kronos forecast into a long/short/flat signal with its reason.',
  version: '1.0.0',
  execution: {
    workspace: { required: true, access: 'read' },
  },
  params: {
    forecast: {
      type: 'json',
      required: true,
      visibility: 'user-only',
      description: 'Output of the Kronos Forecast block: the forecast points and their bands.',
    },
    marketSeries: {
      type: 'json',
      required: true,
      visibility: 'user-only',
      description:
        'Normalized market series from the Historical Data block, for the closes the forecast was anchored to.',
    },
    config: {
      type: 'json',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Optional thresholds: minTerminalReturnTicks, maxPredictedDrawdownTicks (MES ticks, 0.25 points per tick), maxRealizedVolatility, minAgreement (default from the VIX regime: 0.6 calm and normal, 0.75 elevated; a value here overrides it), allowFlip, barsPerYear, currentPositionSide, currentPositionQuantity. Omitted fields keep their defaults.',
    },
  },
  request: {
    url: '/api/providers/kronos/signal',
    method: 'POST',
    headers: () => ({ 'Content-Type': 'application/json' }),
    body: (params) => ({
      forecast: params.forecast,
      marketSeries: params.marketSeries,
      config: params.config,
    }),
  },
  transformResponse: async (response) => {
    const data = await response.json()
    return {
      success: true,
      output: data,
    }
  },
  outputs: {
    direction: {
      type: 'string',
      description: 'Which way the terminal median points: up, down, or flat.',
    },
    action: {
      type: 'string',
      description: 'What the gates allow: buy, sell, or no_trade. Not the same as direction.',
    },
    reason: { type: 'string', description: 'Why the action was taken, gate by gate.' },
    lastClose: { type: 'number', description: 'Close of the last realized bar.' },
    predictedClose: { type: 'number', description: 'Terminal close of the forecast median path.' },
    terminalReturn: { type: 'number', description: 'Predicted terminal return, as a fraction.' },
    terminalReturnTicks: {
      type: 'number',
      description: 'Predicted terminal return, in MES ticks.',
    },
    predictedDrawdown: { type: 'number', description: 'Predicted path drawdown, as a fraction.' },
    predictedDrawdownTicks: {
      type: 'number',
      description: 'Predicted path drawdown, in MES ticks.',
    },
    realizedVolatilityAnnualized: {
      type: 'number',
      description: 'Annualized realized volatility of the close series.',
    },
    agreement: {
      type: 'number',
      optional: true,
      description:
        'Share of the ensemble that agrees with the predicted direction. Null when the forecast carried no ensemble, in which case the gate is not applied and the signal stands aside.',
    },
    minAgreement: {
      type: 'number',
      description:
        "Effective minimum agreement: the VIX regime's floor, or the caller's own if the config gave one.",
    },
    regime: {
      type: 'string',
      description:
        'The VIX regime the signal was judged under: calm, normal, elevated, stressed, or unknown when no usable VIX quote was available - which always stands the signal aside.',
    },
    vix: {
      type: 'number',
      optional: true,
      description: 'VIX last print. Null when no readable quote was available.',
    },
    vix3m: {
      type: 'number',
      optional: true,
      description: 'VIX3M last print, only ever from a fresh quote. Null when absent or stale.',
    },
    vixStale: {
      type: 'boolean',
      description:
        'Whether the VIX quote was missing or older than the freshness allowance. A stale quote stands the signal aside.',
    },
    impliedMoveFraction: {
      type: 'number',
      optional: true,
      description:
        'One-sigma move the VIX implies over the configured horizon, as a fraction of price. Null with no usable VIX.',
    },
    impliedMovePoints: {
      type: 'number',
      optional: true,
      description: 'The same implied move in index points at lastClose.',
    },
    stopPoints: {
      type: 'number',
      optional: true,
      description:
        "Stop distance in index points: the regime's multiple of the implied move. Null when the regime blocks entries.",
    },
    targetPoints: {
      type: 'number',
      optional: true,
      description: 'Target distance in index points, from the same implied move.',
    },
    stopTicks: {
      type: 'number',
      optional: true,
      description: 'Stop distance in MES ticks of 0.25 index points.',
    },
    targetTicks: {
      type: 'number',
      optional: true,
      description: 'Target distance in MES ticks of 0.25 index points.',
    },
    expiresAt: { type: 'string', description: 'ISO timestamp after which the signal is stale.' },
  },
}
