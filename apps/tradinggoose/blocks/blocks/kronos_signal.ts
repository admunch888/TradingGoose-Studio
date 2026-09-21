import { SignalIcon } from '@/components/icons/icons'
import type { KronosSignalResult } from '@/lib/kronos/signal'
import type { BlockConfig } from '@/blocks/types'
import type { ToolResponse } from '@/tools/types'

interface KronosSignalResponse extends ToolResponse {
  output: KronosSignalResult
}

export const KronosSignalBlock: BlockConfig<KronosSignalResponse> = {
  type: 'kronos_signal',
  name: 'Kronos Signal',
  description: 'Turn a Kronos forecast into a long/short/flat signal with its reason.',
  longDescription:
    'Apply the signal policy to a Kronos forecast: realized-volatility, predicted-drawdown and minimum-return gates, then an ensemble agreement gate, and report the resulting long/short/flat decision with the reason for it. The direction it reports comes from the same rule the backtest scores with, and stays separate from the action, which is what the gates allow. A forecast that ran a single sample carries no ensemble, so the agreement gate is not applied and the signal stands aside saying so. The VIX complex decides the rest: the regime sets the agreement floor (0.6 calm and normal, 0.75 elevated), a stressed reading blocks new entries outright, a terminal move outside the sane multiples of the implied move stands aside, and the stop and target are sized from that implied move. With no VIX quote - none supplied, or one older than the freshness allowance - the signal stands aside naming what was missing rather than trading a regime it cannot know; the route fetches VIX and VIX3M itself until a dedicated VIX-context step exists. This block reads data and decides; it does not place orders or access broker credentials.',
  category: 'tools',
  bgColor: '#0d9488',
  icon: SignalIcon,
  subBlocks: [
    {
      id: 'forecast',
      title: 'Forecast',
      type: 'code',
      layout: 'full',
      language: 'json',
      required: true,
      placeholder: 'Paste the output of the Kronos Forecast block.',
      description:
        'Forecast payload from the Kronos Forecast block. Run it with more than one sample: without an ensemble there is nothing to measure agreement against.',
    },
    {
      id: 'marketSeries',
      title: 'Market Series',
      type: 'code',
      layout: 'full',
      language: 'json',
      required: true,
      placeholder: 'Paste the output of the Historical Data block.',
      description:
        'Normalized market series payload from the Historical Data block, for the closes the forecast was anchored to.',
    },
    {
      id: 'config',
      title: 'Config',
      type: 'code',
      layout: 'full',
      language: 'json',
      required: false,
      placeholder:
        '{"minTerminalReturnTicks": 20, "maxPredictedDrawdownTicks": 40, "minAgreement": 0.6}',
      description:
        'Optional thresholds. Leave empty for the defaults (minTerminalReturn 0.5%, maxPredictedDrawdown 2%, maxRealizedVolatility 0.6, minAgreement from the VIX regime: 0.6 calm and normal, 0.75 elevated). Move thresholds are quoted in MES ticks of 0.25 index points; minTerminalReturnTicks is the smallest terminal move worth trading and maxPredictedDrawdownTicks the largest excursion worth risking. currentPositionSide can be set when the workflow knows the account side. A minAgreement given here overrides the regime floor.',
    },
  ],
  tools: {
    access: ['kronos_signal'],
    config: {
      tool: () => 'kronos_signal',
      params: (params) => {
        // The forecast and market series arrive as the code sub-blocks store them: a
        // JSON string, or the object itself when the value resolved from a reference.
        const parsePayload = (value: unknown): unknown => {
          if (typeof value !== 'string') return value
          const trimmed = value.trim()
          // An unresolved reference token is not JSON and is passed through untouched,
          // so the route reports the wiring error instead of the signal guessing.
          if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
          try {
            return JSON.parse(trimmed)
          } catch {
            return value
          }
        }

        return {
          forecast: parsePayload(params.forecast),
          marketSeries: parsePayload(params.marketSeries),
          config: parsePayload(params.config),
        }
      },
    },
  },
  inputs: {
    forecast: {
      type: 'json',
      description: 'Forecast payload from the Kronos Forecast block.',
    },
    marketSeries: {
      type: 'json',
      description: 'Normalized market series payload from the Historical Data block.',
    },
    config: {
      type: 'json',
      description: 'Optional thresholds, in MES ticks where a price move is described.',
    },
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
      description:
        'VIX last print. Null when no readable quote was available; check vixStale before treating it as live.',
    },
    vix3m: {
      type: 'number',
      description: 'VIX3M last print, only ever from a fresh quote. Null when absent or stale.',
    },
    vixStale: {
      type: 'boolean',
      description:
        'Whether the VIX quote was missing or older than the freshness allowance. A stale quote stands the signal aside.',
    },
    impliedMoveFraction: {
      type: 'number',
      description:
        'One-sigma move the VIX implies over the configured horizon, as a fraction of price. Null with no usable VIX.',
    },
    impliedMovePoints: {
      type: 'number',
      description: 'The same implied move in index points at lastClose.',
    },
    stopPoints: {
      type: 'number',
      description:
        "Stop distance in index points: the regime's multiple of the implied move. Null when the regime blocks entries.",
    },
    targetPoints: {
      type: 'number',
      description: 'Target distance in index points, from the same implied move.',
    },
    stopTicks: {
      type: 'number',
      description: 'Stop distance in MES ticks of 0.25 index points.',
    },
    targetTicks: {
      type: 'number',
      description: 'Target distance in MES ticks of 0.25 index points.',
    },
    expiresAt: { type: 'string', description: 'ISO timestamp after which the signal is stale.' },
  },
}
