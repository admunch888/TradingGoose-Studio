/**
 * @vitest-environment jsdom
 *
 * The Kronos Signal block -> tool -> route contract.
 *
 * Two things a workflow's `<kronos_signal_1.field>` references depend on: the block must
 * hand the tool the payloads the operator wired in (as objects, from the JSON the code
 * sub-blocks store), and every output the block declares must be a field the route
 * actually returns. A declared field the route omits renders as an empty reference in
 * the editor and resolves to `undefined` in the next block, which is silent.
 *
 * The representative response here is produced by the real decision layer
 * (`deriveKronosSignal`), which is exactly what the route serializes - so a field added
 * to or removed from the result fails this test rather than drifting.
 *
 * The executor, the real tools registry, the real tool `request.body` builder and the
 * real GenericBlockHandler are used, as in tools/param-coercion.test.ts, so this cannot
 * pass on a mock of the boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveKronosSignal } from '@/lib/kronos/signal'
import { KronosSignalBlock } from '@/blocks/blocks/kronos_signal'
import { mockEnvironmentVariables } from '@/tools/__test-utils__/test-tools'
import { executeTool } from '@/tools/index'

const permissionMocks = vi.hoisted(() => ({
  checkWorkspaceAccess: vi.fn(),
}))

const dbMocks = vi.hoisted(() => {
  const rows: unknown[] = []
  const limit = vi.fn(() => Promise.resolve(rows))
  const whereResult = {
    limit,
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  }
  const where = vi.fn(() => whereResult)
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))

  return { from, limit, select, where }
})

vi.mock('@tradinggoose/db', () => ({
  db: {
    select: dbMocks.select,
  },
}))

vi.mock('@/lib/yjs/server/bootstrap-review-target', () => ({
  readSavedEntityFieldsForExecution: vi.fn(),
}))

vi.mock('@/lib/auth/internal', () => ({
  generateInternalToken: vi.fn().mockResolvedValue('mock-internal-token'),
}))

vi.mock(import('@/lib/permissions/utils'), async (importOriginal) => ({
  ...(await importOriginal()),
  checkWorkspaceAccess: permissionMocks.checkWorkspaceAccess,
}))

// The executor reads block configs through `getBlock`; the full registry is not
// resolvable under vitest, so expose the real Kronos Signal block (same approach as
// tools/param-coercion.test.ts).
vi.mock('@/blocks', async () => {
  const actual = await vi.importActual<typeof import('@/blocks/blocks/kronos_signal')>(
    '@/blocks/blocks/kronos_signal'
  )
  return {
    getBlock: (type: string) => (type === 'kronos_signal' ? actual.KronosSignalBlock : undefined),
  }
})

const ANCHOR = 5000

const MARKET_SERIES = {
  listing: { listing_type: 'default', listing_id: 'MES', base_id: '', quote_id: '' },
  interval: '5m',
  bars: Array.from({ length: 40 }, (_, index) => ({
    timestamp: new Date(Date.parse('2026-03-02T09:00:00.000Z') + index * 300_000).toISOString(),
    open: ANCHOR - (39 - index) * 2.5,
    high: ANCHOR - (39 - index) * 2.5 + 1,
    low: ANCHOR - (39 - index) * 2.5 - 1,
    close: ANCHOR - (39 - index) * 2.5,
  })),
}

const FORECAST = {
  forecast: Array.from({ length: 4 }, (_, index) => ({
    timestamp: new Date(Date.parse('2026-03-02T12:20:00.000Z') + index * 300_000).toISOString(),
    close: ANCHOR + (ANCHOR * 0.01 * (index + 1)) / 4,
    band: { low: ANCHOR - 1 + index, high: ANCHOR + 5 + index },
  })),
  ensemble: { sampleCount: 8, shareUp: 0.8 },
}

/** What the route returns: the decision layer's own flat result. */
const signalInResponse = (body: any) =>
  deriveKronosSignal({
    forecast: body?.forecast,
    closes: (body?.marketSeries?.bars ?? []).map((bar: { close: number }) => bar.close),
    config: body?.config,
    now: new Date('2026-03-02T12:30:00.000Z'),
  })

const representativeResponse = () =>
  signalInResponse({ forecast: FORECAST, marketSeries: MARKET_SERIES })

type CapturedRequest = { url: string; body: any }

let captured: CapturedRequest[] = []
let cleanupEnvVars: () => void

const findRequest = (pathFragment: string): CapturedRequest => {
  const match = captured.find((entry) => entry.url.includes(pathFragment))
  if (!match) {
    throw new Error(
      `No request to ${pathFragment} was made. Captured: ${captured
        .map((entry) => entry.url)
        .join(', ')}`
    )
  }
  return match
}

beforeEach(() => {
  captured = []
  cleanupEnvVars = mockEnvironmentVariables({
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  })
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
  permissionMocks.checkWorkspaceAccess.mockResolvedValue({ hasAccess: true, canWrite: true })

  global.fetch = Object.assign(
    vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      captured.push({ url: String(url), body })
      // A stand-in for the route that answers from the body it was posted, the way the
      // real one does: a threshold the block failed to forward cannot show up here.
      const payload = signalInResponse(body)
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(payload),
        text: () => Promise.resolve(JSON.stringify(payload)),
        headers: { get: () => 'application/json', forEach: () => {} },
        clone: function clone() {
          return { ...this }
        },
      }
    }),
    { preconnect: vi.fn() }
  ) as unknown as typeof fetch
})

afterEach(() => {
  cleanupEnvVars()
  vi.clearAllMocks()
})

const createMockExecutionContext = () =>
  ({
    workflowId: 'test-workflow',
    workspaceId: 'workspace-456',
    userId: 'user-123',
    blockStates: new Map(),
    blockLogs: [],
    metadata: { startTime: new Date().toISOString(), duration: 0 },
    environmentVariables: {},
    decisions: { router: new Map(), condition: new Map() },
    loopIterations: new Map(),
    loopItems: new Map(),
    completedLoops: new Set(),
    executedBlocks: new Set(),
    activeExecutionPath: new Set(),
  }) as any

/**
 * Runs the real GenericBlockHandler for a stored Kronos Signal block and returns the
 * body the tool posted to /api/providers/kronos/signal, plus the block's output.
 *
 * `storedParams` are the values the editor saves for the code sub-blocks: JSON strings,
 * which the executor resolves and passes in as the block's inputs. `resolvedInputs`
 * override them, e.g. with the object a sub-block reference already resolved to.
 */
const dispatchStoredKronosSignalBlock = async (
  storedParams: Record<string, unknown>,
  resolvedInputs: Record<string, unknown> = {}
) => {
  const { GenericBlockHandler } = await import('@/executor/handlers/generic/generic-handler')
  const handler = new GenericBlockHandler()

  const block = {
    id: 'kronos-signal-1',
    metadata: { id: 'kronos_signal', name: 'Kronos Signal' },
    position: { x: 0, y: 0 },
    config: { tool: 'kronos_signal', params: { ...storedParams } },
    inputs: {},
    outputs: {},
    enabled: true,
  } as any

  const output = await handler.execute(
    block,
    {
      forecast: JSON.stringify(FORECAST),
      marketSeries: JSON.stringify(MARKET_SERIES),
      ...storedParams,
      ...resolvedInputs,
    },
    createMockExecutionContext()
  )

  return { body: findRequest('/api/providers/kronos/signal').body, output }
}

describe('kronos signal block -> tool -> route contract', () => {
  describe('the block hands the tool the payloads and thresholds it was given', () => {
    it('parses the JSON the code sub-blocks store into tool params', async () => {
      const { body } = await dispatchStoredKronosSignalBlock({
        forecast: JSON.stringify(FORECAST),
        marketSeries: JSON.stringify(MARKET_SERIES),
        config: JSON.stringify({ minTerminalReturnTicks: 20, minAgreement: 0.7 }),
      })

      expect(body.forecast).toEqual(FORECAST)
      expect(body.marketSeries).toEqual(MARKET_SERIES)
      expect(body.config).toEqual({ minTerminalReturnTicks: 20, minAgreement: 0.7 })
    })

    it('leaves a nested threshold the operator quoted as a string for the route to reject', async () => {
      // The framework coerces a *declared* parameter to its type, not the values nested
      // inside a JSON payload (tools/utils.ts, and the same boundary tools/param-coercion
      // .test.ts documents for kronos_forecast's `parameters`). So a quoted threshold
      // reaches the route as a string and zod reports it there, by name, rather than
      // being silently turned into 0 here - which would disable the gate.
      const { body } = await dispatchStoredKronosSignalBlock({
        forecast: JSON.stringify(FORECAST),
        marketSeries: JSON.stringify(MARKET_SERIES),
        config: JSON.stringify({ minTerminalReturnTicks: '20', maxPredictedDrawdownTicks: '40' }),
      })

      expect(body.config.minTerminalReturnTicks).toBe('20')
    })

    it('leaves an absent config absent', async () => {
      const { body } = await dispatchStoredKronosSignalBlock({
        forecast: JSON.stringify(FORECAST),
        marketSeries: JSON.stringify(MARKET_SERIES),
      })

      expect(body.config).toBeUndefined()
    })

    it('passes an unresolved reference token through untouched', async () => {
      // A block wired to a Forecast block that has not run yet: the token is not JSON,
      // and the route - not the signal - is what has to report the wiring error.
      const { body } = await dispatchStoredKronosSignalBlock(
        {},
        { forecast: '<kronos_forecast_1.output.forecast>' }
      )

      expect(body.forecast).toBe('<kronos_forecast_1.output.forecast>')
    })

    it('accepts an object payload when the reference already resolved', async () => {
      const { body } = await dispatchStoredKronosSignalBlock({}, { forecast: FORECAST })

      expect(body.forecast).toEqual(FORECAST)
    })
  })

  describe('every declared output is produced by a representative response', () => {
    it('declares exactly the fields the decision layer returns', async () => {
      const declared = Object.keys(KronosSignalBlock.outputs).sort()
      const produced = Object.keys(representativeResponse()).sort()

      expect(declared).toEqual(produced)
    })

    it('declares each output with the type the response carries', async () => {
      const response = representativeResponse()

      for (const [field, definition] of Object.entries(KronosSignalBlock.outputs)) {
        const value = (response as unknown as Record<string, unknown>)[field]
        // A block output is either a bare type name or an object carrying one.
        const declaredType = typeof definition === 'string' ? definition : definition.type
        expect(value, `${field} is declared but missing`).toBeDefined()
        if (declaredType === 'number') {
          expect(typeof value, `${field} should be a number`).toBe('number')
        }
        if (declaredType === 'string') {
          expect(typeof value, `${field} should be a string`).toBe('string')
        }
      }
    })

    it('resolves each declared output from the executed block', async () => {
      const { output } = await dispatchStoredKronosSignalBlock({
        forecast: JSON.stringify(FORECAST),
        marketSeries: JSON.stringify(MARKET_SERIES),
        config: JSON.stringify({ minAgreement: 0.7 }),
      })

      // What a downstream `<kronos_signal_1.action>` reference resolves to.
      for (const field of Object.keys(KronosSignalBlock.outputs)) {
        expect(output[field], `${field} resolved to undefined`).toBeDefined()
      }
      expect(output.direction).toBe('up')
      expect(output.action).toBe('buy')
      expect(output.agreement).toBe(0.8)
      expect(output.minAgreement).toBe(0.7)
    })
  })

  describe('the tool params survive the tool registry', () => {
    it('posts the same body when the tool is called directly', async () => {
      await executeTool(
        'kronos_signal',
        {
          forecast: FORECAST,
          marketSeries: MARKET_SERIES,
          config: { minTerminalReturnTicks: 20 },
          _context: { workspaceId: 'workspace-456', userId: 'user-123' },
        } as any,
        false,
        createMockExecutionContext()
      )

      const body = findRequest('/api/providers/kronos/signal').body
      expect(body.forecast).toEqual(FORECAST)
      expect(body.marketSeries).toEqual(MARKET_SERIES)
      expect(body.config).toEqual({ minTerminalReturnTicks: 20 })
      // The execution context is not part of the signal request.
      expect(body._context).toBeUndefined()
    })
  })
})
