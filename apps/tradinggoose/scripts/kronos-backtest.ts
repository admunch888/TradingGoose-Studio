#!/usr/bin/env bun

/**
 * Score Kronos forecasts against bars that have already happened.
 *
 * Answers the question the plan puts before building an execution workflow: does
 * the forecast beat a coin toss? Runs inside the app container, where the
 * KRONOS_* variables the client reads are already set:
 *
 *   podman exec -it tradinggoose-app-1 \
 *     bun run apps/tradinggoose/scripts/kronos-backtest.ts \
 *     --symbol "MES=F" --out /tmp/mes-backtest.jsonl
 *
 * 60 days of MES=F at 15 minutes is about 4,490 usable bars, which is 993
 * windows at the default --step 4 and 3,971 at --step 1. On CPU each window is a
 * forecast of tens of seconds, so that is roughly 8-16 hours and several days
 * respectively: the step is the knob that trades statistical resolution for
 * wall-clock, and on this hardware time binds well before data does.
 *
 * Results are appended per window and the run resumes, so an interruption costs
 * minutes rather than the whole measurement.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  type ForecastScore,
  scoreForecast,
  sliceBacktestWindows,
  smallestDetectableHitRate,
  summariseForecastScores,
} from '@/lib/kronos/backtest'
import {
  type Bar,
  barsFromYahooChart,
  buildWindowRequest,
  formatProgress,
  normaliseBars,
  observationFrom,
  parseRunRecords,
  type RunRecord,
} from '@/lib/kronos/backtest-driver'

/**
 * Posts to the Kronos service directly rather than through `lib/kronos`.
 *
 * The production image ships the source tree without node_modules, so importing
 * the app client pulls in `types.ts` -> zod and the script cannot start inside
 * the container it is meant to run in. The modules it does import
 * (`backtest`, `backtest-driver`) have no package dependencies at all.
 *
 * This is the same request the app makes: POST /v1/forecast with a bearer token.
 */
async function requestForecast(
  request: unknown,
  timeoutMs: number
): Promise<{ forecast: Array<{ close: number }> }> {
  const url = (process.env.KRONOS_INTERNAL_URL || '').replace(/\/$/, '')
  const token = process.env.KRONOS_INTERNAL_TOKEN
  if (!url || !token) {
    throw new Error(
      'KRONOS_INTERNAL_URL and KRONOS_INTERNAL_TOKEN must be set. Run this inside the app container.'
    )
  }

  const response = await fetch(`${url}/v1/forecast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`Kronos returned ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }

  const body = (await response.json()) as { forecast?: unknown }
  if (!Array.isArray(body.forecast)) {
    throw new Error('Kronos response carried no forecast array')
  }
  return body as { forecast: Array<{ close: number }> }
}

const arg = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const num = (name: string, fallback: number): number => {
  const value = arg(name)
  const parsed = value === undefined ? Number.NaN : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const options = {
  symbol: arg('symbol', 'MES=F') as string,
  bars: arg('bars'),
  interval: arg('interval', '15m') as string,
  range: arg('range', '60d') as string,
  timezone: arg('timezone', 'America/New_York') as string,
  context: num('context', 512),
  horizon: num('horizon', 8),
  step: num('step', 4),
  samples: num('samples', 1),
  temperature: num('temperature', 1),
  topP: num('top-p', 0.9),
  out: arg('out', '/tmp/kronos-backtest.jsonl') as string,
  limit: num('limit', Number.POSITIVE_INFINITY),
  // A CPU forecast of 512 bars takes tens of seconds; the app's default is far
  // shorter than a backtest window needs.
  timeoutMs: num('timeout-ms', 10 * 60 * 1000),
}

async function loadBars(): Promise<Bar[]> {
  if (options.bars) {
    const parsed = JSON.parse(readFileSync(options.bars, 'utf8'))
    return normaliseBars(Array.isArray(parsed) ? parsed : parsed.bars)
  }

  // Yahoo is the only source offering 60 days at this bar size; the IBKR
  // provider is configured for 30.
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(options.symbol)}` +
    `?interval=${options.interval}&range=${options.range}`
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!response.ok) {
    throw new Error(
      `Yahoo returned ${response.status} ${response.statusText} for ${options.symbol}`
    )
  }
  return normaliseBars(barsFromYahooChart(await response.json()))
}

function report(scores: ForecastScore[], bars: number, skipped: number) {
  const summary = summariseForecastScores(scores)
  const { directional: d } = summary
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`

  const lines = [
    '',
    '='.repeat(64),
    `  ${options.symbol}   ${bars} bars   ${options.interval}   horizon ${options.horizon}`,
    '='.repeat(64),
    `  scored              ${summary.scored}${skipped > 0 ? `   (${skipped} not scoreable)` : ''}`,
    `  took a direction    ${d.evaluated}`,
    `  hit rate            ${percent(d.hitRate)}  (${d.hits}/${d.evaluated})`,
    `  95% interval        ${percent(d.confidenceInterval95.low)} – ${percent(d.confidenceInterval95.high)}`,
    `  beats a coin toss   ${d.beatsChance ? 'YES' : 'no'}`,
    `  mean abs error      ${summary.meanAbsoluteError.toFixed(3)}  (${summary.meanAbsolutePercentError.toFixed(3)}%)`,
  ]

  if (summary.bandCoverage) {
    lines.push(
      `  band coverage       ${percent(summary.bandCoverage.rate)}  (${summary.bandCoverage.covered}/${summary.bandCoverage.evaluated})`
    )
  } else {
    // sample_count is capped at 1 until the ensemble work lands, so there is no
    // band to check. Saying so beats printing a zero that reads like a result.
    lines.push('  band coverage       n/a - forecasts carried no ensemble band')
  }

  for (const [regime, stats] of Object.entries(summary.byRegime)) {
    lines.push(`  ${regime.padEnd(18)}  ${percent(stats.hitRate)} of ${stats.evaluated}`)
  }

  lines.push('='.repeat(64))
  if (!d.beatsChance && d.evaluated > 0) {
    const floor = smallestDetectableHitRate(d.evaluated)
    lines.push(
      '  The interval includes 50%, so this run does not show an edge.',
      '  That is "not proven", not "no".',
      ...(floor
        ? [
            `  At ${d.evaluated} forecasts, anything below ${percent(floor)} is`,
            '  indistinguishable from chance. Run more windows (a smaller',
            '  --step) to resolve a smaller edge.',
          ]
        : []),
      '='.repeat(64)
    )
  }
  console.log(lines.join('\n'))

  writeFileSync(`${options.out}.summary.json`, JSON.stringify(summary, null, 2))
  console.log(`\nsummary  ${options.out}.summary.json\nwindows  ${options.out}\n`)
}

async function main() {
  const bars = await loadBars()
  if (bars.length < options.context + options.horizon) {
    throw new Error(
      `Need at least ${options.context + options.horizon} bars, got ${bars.length}. ` +
        'Try a smaller --context, or a longer --range.'
    )
  }

  const windows = [
    ...sliceBacktestWindows(bars, {
      contextBars: options.context,
      horizonBars: options.horizon,
      step: options.step,
    }),
  ].slice(0, options.limit)

  const done = existsSync(options.out)
    ? parseRunRecords(readFileSync(options.out, 'utf8'))
    : new Map<number, RunRecord>()

  console.log(
    `${bars.length} bars  ->  ${windows.length} windows` +
      (done.size > 0 ? `  (${done.size} already done, resuming)` : '')
  )

  const scores: ForecastScore[] = []
  let skipped = 0
  const started = Date.now()

  for (const [index, window] of windows.entries()) {
    const existing = done.get(window.originIndex)
    const record: RunRecord | null = existing
      ? existing
      : await (async () => {
          try {
            const response = await requestForecast(
              buildWindowRequest(window, {
                listingId: options.symbol,
                interval: options.interval,
                timezone: options.timezone,
                temperature: options.temperature,
                topP: options.topP,
                sampleCount: options.samples,
              }),
              options.timeoutMs
            )
            const next: RunRecord = {
              originIndex: window.originIndex,
              lastBar: window.context[window.context.length - 1].timestamp,
              predictedCloses: response.forecast.map((point) => point.close),
              realizedCloses: window.realized.map((bar) => bar.close),
            }
            appendFileSync(options.out, `${JSON.stringify(next)}\n`)
            return next
          } catch (error) {
            // One refused window must not end a run that is hours long.
            console.warn(
              `  window ${window.originIndex} failed: ${error instanceof Error ? error.message : error}`
            )
            return null
          }
        })()

    if (!record) {
      skipped++
    } else {
      const score = scoreForecast(
        observationFrom(
          window,
          record.predictedCloses.map((close) => ({ close })),
          record.regime
        )
      )
      if (score) scores.push(score)
      else skipped++
    }

    if ((index + 1) % 10 === 0 || index === windows.length - 1) {
      console.log(`  ${formatProgress(index + 1, windows.length, Date.now() - started)}`)
    }
  }

  report(scores, bars.length, skipped)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
