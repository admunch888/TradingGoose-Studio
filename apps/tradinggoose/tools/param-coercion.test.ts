/**
 * @vitest-environment jsdom
 *
 * The block -> tool parameter boundary must coerce each parameter to the type the
 * tool declares, before validation and dispatch.
 *
 * Live failure (podman deployment @ db2734d9, workflow "Historical Data -> Kronos Forecast"):
 *
 *   [ERROR] [Tools] Internal API error for kronos_forecast: {"status":400,"errorData":{"error":"Invalid request data","details":[{"expected":"number","code":"invalid_type","path":["horizonBars"],"message":"Invalid input: expected number, received string"}]}}
 *   [ERROR] [Executor] Error executing block Kronos Forecast: Invalid input: expected number, received string
 *
 * A `short-input` with `inputType: 'number'` stores a *string* in the workflow
 * (`lib/workflows/subblock-values.ts` copies sub-block values verbatim; `inputType`
 * is a UI hint only). The only thing that used to convert it was the block's own
 * `tools.config.params` transform - and `GenericBlockHandler` discards that whole
 * transform when it throws (`executor/handlers/generic/generic-handler.ts:49-53`),
 * leaving the raw stored strings to be dispatched. The tool then posts them and the
 * route's zod schema rejects them.
 *
 * These tests assert on the request body that actually goes to the route, with the
 * real tools registry, the real tool `request.body` builders and the real executor
 * handler, so they cannot pass on a mock of the coercion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockEnvironmentVariables } from '@/tools/__test-utils__/test-tools'
import { executeTool } from '@/tools/index'

const permissionMocks = vi.hoisted(() => ({
  checkWorkspaceAccess: vi.fn(),
}))

const dbMocks = vi.hoisted(() => {
  let rows: unknown[] = []
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

// The serializer/executor read block configs through `getBlock`; the full registry is
// not resolvable under vitest, so expose the real Kronos block (same approach as
// blocks/blocks/historical_data_contracts.test.ts).
vi.mock('@/blocks', async () => {
  const actual = await vi.importActual<typeof import('@/blocks/blocks/kronos_forecast')>(
    '@/blocks/blocks/kronos_forecast'
  )
  return {
    getBlock: (type: string) =>
      type === 'kronos_forecast' ? actual.KronosForecastBlock : undefined,
  }
})

const LISTING = {
  listing_type: 'default',
  listing_id: 'AAPL',
  base_id: '',
  quote_id: '',
}

const MARKET_SERIES = {
  listing: LISTING,
  bars: [{ timestamp: '2024-01-01T00:00:00Z', close: 100 }],
}

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
      captured.push({
        url: String(url),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
        text: () => Promise.resolve('{"success":true}'),
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
 * Runs the real GenericBlockHandler for a stored Kronos block and returns the body the
 * Kronos tool posted to /api/providers/kronos/forecast.
 *
 * `marketSeries` is stored as an unresolved reference token - a non-JSON string - which
 * is exactly what makes the block's own transform throw (`JSON.parse` on a non-JSON
 * string, blocks/blocks/kronos_forecast.ts:111) and sends the executor down the
 * raw-stored-params path that produced the live failure.
 */
const dispatchStoredKronosBlock = async (storedParams: Record<string, unknown>) => {
  const { GenericBlockHandler } = await import('@/executor/handlers/generic/generic-handler')
  const handler = new GenericBlockHandler()

  const block = {
    id: 'kronos-1',
    metadata: { id: 'kronos_forecast', name: 'Kronos Forecast' },
    position: { x: 0, y: 0 },
    config: { tool: 'kronos_forecast', params: { ...storedParams } },
    inputs: {},
    outputs: {},
    enabled: true,
  } as any

  await handler.execute(
    block,
    {
      listing: LISTING,
      marketSeries: '<historical_data_1.output.marketSeries>',
      interval: '5m',
      timezone: 'America/New_York',
      normalizationMode: undefined,
      temperature: undefined,
      ...storedParams,
    },
    createMockExecutionContext()
  )

  return findRequest('/api/providers/kronos/forecast').body
}

describe('block -> tool boundary coerces parameters to the types the tool declares', () => {
  describe('a stored numeric short-input reaches the route as a number', () => {
    it('coerces horizonBars when the block transform could not produce tool params', async () => {
      // Stored value of the "Horizon (bars)" short-input: a string, as the editor saves it.
      const body = await dispatchStoredKronosBlock({ horizonBars: '12' })

      expect(body.horizonBars).toBe(12)
      expect(typeof body.horizonBars).toBe('number')
    })

    it('keeps horizonBars numeric when the block transform does produce tool params', async () => {
      const { GenericBlockHandler } = await import('@/executor/handlers/generic/generic-handler')
      const handler = new GenericBlockHandler()

      const block = {
        id: 'kronos-1',
        metadata: { id: 'kronos_forecast', name: 'Kronos Forecast' },
        position: { x: 0, y: 0 },
        config: { tool: 'kronos_forecast', params: { horizonBars: '12' } },
        inputs: {},
        outputs: {},
        enabled: true,
      } as any

      await handler.execute(
        block,
        {
          listing: LISTING,
          marketSeries: JSON.stringify(MARKET_SERIES),
          interval: '5m',
          timezone: 'America/New_York',
          horizonBars: '12',
        },
        createMockExecutionContext()
      )

      const body = findRequest('/api/providers/kronos/forecast').body
      expect(body.horizonBars).toBe(12)
    })

    it('passes an uncoercible horizonBars through untouched so validation still rejects it', async () => {
      const body = await dispatchStoredKronosBlock({ horizonBars: 'abc' })

      // Not silently defaulted to 0/NaN/null - the route's own schema reports the error
      // shape the live failure shows: expected number, received string.
      expect(body.horizonBars).toBe('abc')
      expect(typeof body.horizonBars).toBe('string')
    })

    it('leaves an absent optional numeric parameter absent', async () => {
      const body = await dispatchStoredKronosBlock({ horizonBars: '12' })

      expect(body.parameters).toBeUndefined()
    })
  })

  describe('numeric parameters on unrelated tools', () => {
    it('coerces a numeric parameter the block never touched (search result count)', async () => {
      await executeTool('serper_search', {
        query: 'market news',
        num: '7',
        apiKey: 'test-key',
      } as any)

      const body = findRequest('google.serper.dev/search').body
      expect(body.num).toBe(7)
      expect(typeof body.num).toBe('number')
    })

    it('coerces two numeric parameters on the same tool (vector search)', async () => {
      await executeTool('supabase_vector_search', {
        projectId: 'abcdefghijklmnopqrst',
        functionName: 'match_documents',
        queryEmbedding: [0.1, 0.2],
        matchThreshold: '0.8',
        matchCount: '5',
        apiKey: 'test-key',
      } as any)

      const body = findRequest('supabase.co/rest/v1/rpc/match_documents').body
      expect(body.match_threshold).toBe(0.8)
      expect(body.match_count).toBe(5)
      expect(typeof body.match_threshold).toBe('number')
      expect(typeof body.match_count).toBe('number')
    })

    it('does not coerce a parameter the tool declares as a string', async () => {
      await executeTool('serper_search', {
        query: '12345',
        gl: '12345',
        num: '7',
        apiKey: 'test-key',
      } as any)

      const body = findRequest('google.serper.dev/search').body
      // Both are declared `type: 'string'` and must stay strings even though they look
      // like numbers.
      expect(body.q).toBe('12345')
      expect(typeof body.q).toBe('string')
      expect(body.gl).toBe('12345')
      expect(typeof body.gl).toBe('string')
    })

    it('leaves a blank optional numeric parameter undefined instead of 0 or NaN', async () => {
      await executeTool('serper_search', {
        query: 'market news',
        num: '',
        apiKey: 'test-key',
      } as any)

      const body = findRequest('google.serper.dev/search').body
      expect(Object.hasOwn(body, 'num')).toBe(false)
      expect(body.num).toBeUndefined()
      expect(body.num).not.toBeNaN()
    })

    it('leaves an absent optional numeric parameter undefined', async () => {
      await executeTool('serper_search', {
        query: 'market news',
        apiKey: 'test-key',
      } as any)

      const body = findRequest('google.serper.dev/search').body
      expect(Object.hasOwn(body, 'num')).toBe(false)
    })
  })
})
