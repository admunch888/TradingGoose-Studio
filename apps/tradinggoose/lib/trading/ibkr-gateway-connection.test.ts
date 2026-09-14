/**
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockDb,
  mockEnsureIbkrSession,
  mockFetchBrokerJson,
  mockInsertValues,
  mockSelectLimit,
  mockUpdateSet,
  mockUpdateWhere,
} = vi.hoisted(() => {
  const mockSelectLimit = vi.fn()
  const mockInsertValues = vi.fn()
  const mockUpdateWhere = vi.fn()
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }))
  return {
    mockDb: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: mockSelectLimit })) })),
      })),
      insert: vi.fn(() => ({ values: mockInsertValues })),
      update: vi.fn(() => ({ set: mockUpdateSet })),
    },
    mockEnsureIbkrSession: vi.fn(),
    mockFetchBrokerJson: vi.fn(),
    mockInsertValues,
    mockSelectLimit,
    mockUpdateSet,
    mockUpdateWhere,
  }
})

vi.mock('@tradinggoose/db', () => ({
  account: {
    id: 'id',
    userId: 'userId',
    providerId: 'providerId',
    accessToken: 'accessToken',
  },
  db: mockDb,
}))

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ and: conditions }),
  eq: (field: unknown, value: unknown) => ({ field, value }),
}))

vi.mock('@/lib/logs/console/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}))

vi.mock('@/providers/trading/ibkr/session', () => ({
  ensureIbkrSession: (...args: unknown[]) => mockEnsureIbkrSession(...args),
}))

vi.mock('@/providers/trading/portfolio-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/providers/trading/portfolio-utils')>()
  return { ...actual, fetchBrokerJson: (...args: unknown[]) => mockFetchBrokerJson(...args) }
})

import {
  connectIbkrGateway,
  IBKR_GATEWAY_ACCESS_TOKEN,
  isIbkrGatewayConnectionAllowed,
} from '@/lib/trading/ibkr-gateway-connection'

const paperGateway = { accounts: ['DU123456'], selectedAccount: 'DU123456', isPaper: true }
const liveGateway = { accounts: ['U7654321'], selectedAccount: 'U7654321', isPaper: false }

describe('isIbkrGatewayConnectionAllowed', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is off when IBKR_GATEWAY_ALLOWED_EMAILS is unset or empty', () => {
    expect(isIbkrGatewayConnectionAllowed('trader@example.com')).toBe(false)
    vi.stubEnv('IBKR_GATEWAY_ALLOWED_EMAILS', ' ')
    expect(isIbkrGatewayConnectionAllowed('trader@example.com')).toBe(false)
  })

  it('allows listed emails regardless of case and spacing', () => {
    vi.stubEnv('IBKR_GATEWAY_ALLOWED_EMAILS', 'Owner@Example.com , trader@example.com')
    expect(isIbkrGatewayConnectionAllowed('owner@example.com')).toBe(true)
    expect(isIbkrGatewayConnectionAllowed('TRADER@example.com')).toBe(true)
    expect(isIbkrGatewayConnectionAllowed('someone@example.com')).toBe(false)
    expect(isIbkrGatewayConnectionAllowed(undefined)).toBe(false)
  })

  it('allows every user with *', () => {
    vi.stubEnv('IBKR_GATEWAY_ALLOWED_EMAILS', '*')
    expect(isIbkrGatewayConnectionAllowed('anyone@example.com')).toBe(true)
  })
})

describe('connectIbkrGateway', () => {
  const params = { userId: 'user-1', email: 'trader@example.com', serviceId: 'ibkr-paper' }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('IBKR_GATEWAY_ALLOWED_EMAILS', 'trader@example.com')
    mockEnsureIbkrSession.mockResolvedValue(undefined)
    mockFetchBrokerJson.mockResolvedValue(paperGateway)
    mockSelectLimit.mockResolvedValue([])
    mockInsertValues.mockResolvedValue(undefined)
    mockUpdateWhere.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('records a connection row for the gateway account', async () => {
    const connection = await connectIbkrGateway(params)

    expect(mockEnsureIbkrSession).toHaveBeenCalled()
    expect(mockFetchBrokerJson.mock.calls[0][0].url).toBe(
      'http://127.0.0.1:5000/v1/api/iserver/accounts'
    )
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'ibkr-paper',
        userId: 'user-1',
        accountId: 'DU123456',
        accessToken: IBKR_GATEWAY_ACCESS_TOKEN,
        refreshToken: null,
        accessTokenExpiresAt: null,
        scope: 'read trade',
      })
    )
    expect(connection).toMatchObject({ ibkrAccountId: 'DU123456', environment: 'paper' })
    expect(connection.connectionId).toEqual(mockInsertValues.mock.calls[0][0].id)
  })

  it('refreshes the existing gateway connection instead of adding another', async () => {
    mockSelectLimit.mockResolvedValue([{ id: 'existing-connection' }])

    const connection = await connectIbkrGateway(params)

    expect(mockInsertValues).not.toHaveBeenCalled()
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'DU123456', accessToken: IBKR_GATEWAY_ACCESS_TOKEN })
    )
    expect(mockUpdateWhere).toHaveBeenCalledWith({ field: 'id', value: 'existing-connection' })
    expect(connection.connectionId).toBe('existing-connection')
  })

  it('connects a live gateway to IBKR Live', async () => {
    mockFetchBrokerJson.mockResolvedValue(liveGateway)

    const connection = await connectIbkrGateway({ ...params, serviceId: 'ibkr-live' })

    expect(connection).toMatchObject({ ibkrAccountId: 'U7654321', environment: 'live' })
  })

  it('refuses a live gateway for IBKR Paper so live orders are never placed as paper', async () => {
    mockFetchBrokerJson.mockResolvedValue(liveGateway)

    await expect(connectIbkrGateway(params)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('live account'),
    })
    expect(mockInsertValues).not.toHaveBeenCalled()
  })

  it('refuses a paper gateway for IBKR Live', async () => {
    await expect(connectIbkrGateway({ ...params, serviceId: 'ibkr-live' })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('paper account'),
    })
  })

  it('infers paper from the account id when the gateway omits isPaper', async () => {
    mockFetchBrokerJson.mockResolvedValue({ accounts: ['DU999'] })

    await expect(connectIbkrGateway(params)).resolves.toMatchObject({ ibkrAccountId: 'DU999' })
    await expect(connectIbkrGateway({ ...params, serviceId: 'ibkr-live' })).rejects.toMatchObject({
      status: 409,
    })
  })

  it('refuses users who are not allowed', async () => {
    vi.stubEnv('IBKR_GATEWAY_ALLOWED_EMAILS', '')

    await expect(connectIbkrGateway(params)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('IBKR_GATEWAY_ALLOWED_EMAILS'),
    })
    expect(mockEnsureIbkrSession).not.toHaveBeenCalled()
  })

  it('refuses when the app points at the hosted IBKR API', async () => {
    vi.stubEnv('IBKR_API_BASE_URL', 'https://api.ibkr.com/v1/api')

    await expect(connectIbkrGateway(params)).rejects.toMatchObject({ status: 400 })
    expect(mockEnsureIbkrSession).not.toHaveBeenCalled()
  })

  it('refuses a service that is not an IBKR service', async () => {
    await expect(connectIbkrGateway({ ...params, serviceId: 'alpaca-live' })).rejects.toMatchObject(
      { status: 400 }
    )
  })

  it('reports the gateway session problem when the gateway is not logged in', async () => {
    mockEnsureIbkrSession.mockRejectedValue(
      new Error('IBKR Client Portal Gateway session is not authenticated')
    )

    await expect(connectIbkrGateway(params)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('not authenticated'),
    })
    expect(mockInsertValues).not.toHaveBeenCalled()
  })

  it('refuses a gateway session without trading accounts', async () => {
    mockFetchBrokerJson.mockResolvedValue({ accounts: [] })

    await expect(connectIbkrGateway(params)).rejects.toMatchObject({ status: 502 })
  })
})
