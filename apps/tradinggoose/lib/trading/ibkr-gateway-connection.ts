import { account, db } from '@tradinggoose/db'
import { and, eq } from 'drizzle-orm'
import { createLogger } from '@/lib/logs/console/logger'
import { TradingServiceError } from '@/lib/trading/errors'
import { buildIbkrAuthHeaders, isIbkrHostedApi } from '@/providers/trading/ibkr/auth'
import { buildIbkrApiUrl } from '@/providers/trading/ibkr/client'
import { ensureIbkrSession } from '@/providers/trading/ibkr/session'
import { fetchBrokerJson } from '@/providers/trading/portfolio-utils'
import {
  getTradingProviderOAuthEnvironment,
  getTradingProviderOAuthServiceIds,
} from '@/providers/trading/providers'
import { safeRandomUUID } from '@/lib/safe-uuid'

const logger = createLogger('IbkrGatewayConnection')

/**
 * Stored as the connection's access token. The Client Portal Gateway
 * authenticates every request with its own browser login and ignores tokens, but
 * the trading context requires a connection row with a token to exist. The value
 * also identifies rows created here rather than by an OAuth grant.
 */
export const IBKR_GATEWAY_ACCESS_TOKEN = 'ibkr-client-portal-gateway'

/** The scopes an IBKR OAuth grant would carry, so scope checks treat both alike. */
const IBKR_GATEWAY_SCOPE = 'read trade'

interface IbkrGatewayAccountsResponse {
  accounts?: unknown
  selectedAccount?: unknown
  isPaper?: unknown
}

export interface IbkrGatewayConnection {
  connectionId: string
  ibkrAccountId: string
  environment: 'paper' | 'live'
}

/**
 * A gateway holds ONE brokerage login, and every user who connects through it
 * trades that account. Connections are therefore off unless
 * IBKR_GATEWAY_ALLOWED_EMAILS names the user (comma-separated) or is "*".
 */
export const isIbkrGatewayConnectionAllowed = (email?: string | null): boolean => {
  const configured = process.env.IBKR_GATEWAY_ALLOWED_EMAILS?.trim()
  if (!configured) return false

  const entries = configured
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  if (entries.includes('*')) return true

  const normalizedEmail = email?.trim().toLowerCase()
  return Boolean(normalizedEmail && entries.includes(normalizedEmail))
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

/**
 * Connects the user's IBKR Paper or Live service to the local Client Portal
 * Gateway session: checks the gateway is logged in, that its account matches the
 * requested environment, and records (or refreshes) the connection row the
 * trading pipeline resolves.
 */
export async function connectIbkrGateway({
  userId,
  email,
  serviceId,
}: {
  userId: string
  email?: string | null
  serviceId: string
}): Promise<IbkrGatewayConnection> {
  const environment = getTradingProviderOAuthServiceIds('ibkr').includes(serviceId)
    ? getTradingProviderOAuthEnvironment('ibkr', serviceId)
    : null
  if (!environment) {
    throw new TradingServiceError(`Unsupported IBKR service: ${serviceId}`, 400)
  }

  if (isIbkrHostedApi()) {
    throw new TradingServiceError(
      'IBKR_API_BASE_URL points at the hosted IBKR API, which needs an OAuth connection. ' +
        'Gateway connections only work with a Client Portal Gateway.',
      400
    )
  }

  if (!isIbkrGatewayConnectionAllowed(email)) {
    throw new TradingServiceError(
      'IBKR gateway connections are not enabled for this user. Add the user to ' +
        'IBKR_GATEWAY_ALLOWED_EMAILS; everyone listed trades through the same gateway login.',
      403
    )
  }

  try {
    await ensureIbkrSession()
  } catch (error) {
    throw new TradingServiceError(errorMessage(error, 'The IBKR gateway is not reachable'), 502)
  }

  let gateway: IbkrGatewayAccountsResponse | null
  try {
    gateway = await fetchBrokerJson<IbkrGatewayAccountsResponse>({
      providerId: 'ibkr',
      url: buildIbkrApiUrl('/iserver/accounts'),
      init: { method: 'GET', headers: buildIbkrAuthHeaders() },
    })
  } catch (error) {
    throw new TradingServiceError(
      `The IBKR gateway did not list its accounts: ${errorMessage(error, 'request failed')}`,
      502
    )
  }

  const accountIds = Array.isArray(gateway?.accounts)
    ? gateway.accounts.filter(
        (value): value is string => typeof value === 'string' && value.trim() !== ''
      )
    : []
  const selectedAccount =
    typeof gateway?.selectedAccount === 'string' ? gateway.selectedAccount.trim() : ''
  const ibkrAccountId = selectedAccount || accountIds[0]?.trim()
  if (!ibkrAccountId) {
    throw new TradingServiceError('The IBKR gateway session has no trading accounts', 502)
  }

  // IBKR paper account ids start with D (DU, DF); `isPaper` is authoritative when sent.
  const gatewayIsPaper =
    typeof gateway?.isPaper === 'boolean' ? gateway.isPaper : /^D/i.test(ibkrAccountId)
  if (gatewayIsPaper !== (environment === 'paper')) {
    throw new TradingServiceError(
      gatewayIsPaper
        ? 'The IBKR gateway is logged in to a paper account. Connect IBKR Paper instead.'
        : 'The IBKR gateway is logged in to a live account. Connect IBKR Live instead.',
      409
    )
  }

  const now = new Date()
  const connectionValues = {
    accountId: ibkrAccountId,
    accessToken: IBKR_GATEWAY_ACCESS_TOKEN,
    scope: IBKR_GATEWAY_SCOPE,
    updatedAt: now,
  }

  const [existing] = await db
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, serviceId),
        eq(account.accessToken, IBKR_GATEWAY_ACCESS_TOKEN)
      )
    )
    .limit(1)

  if (existing) {
    await db.update(account).set(connectionValues).where(eq(account.id, existing.id))
    logger.info('Refreshed IBKR gateway connection', { serviceId, ibkrAccountId })
    return { connectionId: existing.id, ibkrAccountId, environment }
  }

  const connectionId = safeRandomUUID()
  await db.insert(account).values({
    id: connectionId,
    providerId: serviceId,
    userId,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    password: null,
    createdAt: now,
    ...connectionValues,
  })
  logger.info('Created IBKR gateway connection', { serviceId, ibkrAccountId })
  return { connectionId, ibkrAccountId, environment }
}
