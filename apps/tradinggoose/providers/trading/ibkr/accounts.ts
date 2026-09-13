import { buildIbkrAuthHeaders } from '@/providers/trading/ibkr/auth'
import { buildIbkrApiUrl } from '@/providers/trading/ibkr/client'
import { ensureIbkrSession } from '@/providers/trading/ibkr/session'
import type { PortfolioIdentity } from '@/providers/trading/portfolio-identity'
import { fetchBrokerJson, toFiniteNumber } from '@/providers/trading/portfolio-utils'
import type {
  TradingPortfolioBaseContext,
  UnifiedTradingAccountStatus,
  UnifiedTradingAccountType,
} from '@/providers/trading/types'

export const mapIbkrAccountStatus = (value: unknown): UnifiedTradingAccountStatus => {
  if (typeof value !== 'string') return 'unknown'

  switch (value.trim().toUpperCase()) {
    case 'ACTIVE':
    case 'PASSED':
      return 'active'
    case 'CLOSED':
    case 'PENDING_CLOSE':
      return 'closed'
    case 'NEW':
    case 'PENDING':
    case 'VERIFICATION_REQUIRED':
    case 'DISABLED':
    case 'INACTIVE':
    case 'RESTRICTED':
      return 'restricted'
    default:
      return 'unknown'
  }
}

/**
 * /portfolio/accounts `clearingStatus`: O open, P pending, N new, A abandoned,
 * C closed, R rejected.
 */
export const mapIbkrClearingStatus = (value: unknown): UnifiedTradingAccountStatus | null => {
  if (typeof value !== 'string') return null

  switch (value.trim().toUpperCase()) {
    case 'O':
      return 'active'
    case 'P':
    case 'N':
      return 'restricted'
    case 'A':
    case 'C':
    case 'R':
      return 'closed'
    default:
      return null
  }
}

export const mapIbkrAccountType = (value: unknown): UnifiedTradingAccountType => {
  if (typeof value !== 'string') return 'unknown'

  switch (value.trim().toLowerCase()) {
    case 'cash':
      return 'cash'
    case 'margin':
      return 'margin'
    case 'portfolio':
      return 'portfolio'
    case 'individual':
    case 'joint':
    case 'ira':
    case 'trust':
    case 'llc':
      return 'margin'
    case 'advisor':
      return 'portfolio'
    default:
      return 'unknown'
  }
}

const readText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

export const normalizeIbkrTradingAccount = (
  account: any,
  context: Pick<TradingPortfolioBaseContext, 'credentialId' | 'serviceId' | 'providerId'>
): PortfolioIdentity => {
  const id = readText(account?.id) || readText(account?.accountId)
  if (!id) {
    throw new Error('IBKR accounts response missing account id')
  }

  const rawType = readText(account?.acctCustType) || readText(account?.accountType)
  const accountType = mapIbkrAccountType(rawType)
  const leverage = toFiniteNumber(account?.leverage)
  const type = typeof leverage === 'number' && leverage > 1 ? 'margin' : accountType

  return {
    providerId: context.providerId,
    credentialId: context.credentialId,
    serviceId: context.serviceId,
    accountId: id,
    providerName: 'IBKR',
    accountName:
      readText(account?.accountTitle) || readText(account?.accountAlias) || `IBKR (${id})`,
    accountType: type,
    baseCurrency: readText(account?.currency)?.toUpperCase() ?? 'USD',
    accountStatus:
      mapIbkrClearingStatus(account?.clearingStatus) ??
      mapIbkrAccountStatus(readText(account?.status)),
  }
}

/**
 * Lists accounts from /portfolio/accounts. /iserver/accounts only lists bare
 * account id strings, which this normalizer rejected, so no IBKR account ever
 * resolved; /portfolio/accounts returns the account objects, and IBKR requires it
 * to be read before any /portfolio/{accountId}/* endpoint anyway.
 */
export async function getIbkrTradingAccounts(
  context: TradingPortfolioBaseContext
): Promise<PortfolioIdentity[]> {
  await ensureIbkrSession({ accessToken: context.accessToken })

  const response = await fetchBrokerJson<unknown>({
    providerId: context.providerId,
    url: buildIbkrApiUrl('/portfolio/accounts'),
    init: {
      method: 'GET',
      headers: buildIbkrAuthHeaders({ accessToken: context.accessToken }),
    },
  })

  const accounts = Array.isArray(response) ? response : []
  const identities = accounts.map((account) => normalizeIbkrTradingAccount(account, context))
  if (identities.length === 0) {
    throw new Error('No IBKR accounts returned for the connected session')
  }
  return identities
}
