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
        'Optional thresholds: minTerminalReturnTicks, maxPredictedDrawdownTicks (MES ticks, 0.25 points per tick), maxRealizedVolatility, minAgreement (default 0.6), allowFlip, barsPerYear, currentPositionSide, currentPositionQuantity. Omitted fields keep their defaults.',
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
    minAgreement: { type: 'number', description: 'Effective minimum agreement for this signal.' },
    expiresAt: { type: 'string', description: 'ISO timestamp after which the signal is stale.' },
  },
}
