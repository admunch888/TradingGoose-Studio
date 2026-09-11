import { createLogger } from '@/lib/logs/console/logger'
import { buildIbkrAuthHeaders, isIbkrHostedApi } from '@/providers/trading/ibkr/auth'
import { buildIbkrApiUrl } from '@/providers/trading/ibkr/client'
import { fetchBrokerJson } from '@/providers/trading/portfolio-utils'

const logger = createLogger('IBKR:Session')

/**
 * The Client Portal Gateway drops an idle session after a few minutes, and it
 * will not serve /iserver/* data until /iserver/accounts has been called once
 * for the session. Both are cheap, so we do them on a timer rather than
 * discovering the problem as an opaque 401 halfway through a chart load.
 */
const TICKLE_INTERVAL_MS = 60_000
let lastTickleAt = 0
let accountsPrimed = false

interface IbkrAuthStatus {
  authenticated?: boolean
  connected?: boolean
  competing?: boolean
}

export const resetIbkrSessionState = (): void => {
  lastTickleAt = 0
  accountsPrimed = false
}

export async function ensureIbkrSession(params: { accessToken?: string } = {}): Promise<void> {
  // The hosted OAuth API is stateless; none of this applies.
  if (isIbkrHostedApi()) return

  const headers = buildIbkrAuthHeaders(params)
  const now = Date.now()

  if (now - lastTickleAt > TICKLE_INTERVAL_MS) {
    const status = await fetchBrokerJson<IbkrAuthStatus>({
      providerId: 'ibkr',
      url: buildIbkrApiUrl('/iserver/auth/status'),
      init: { method: 'POST', headers },
    }).catch((error) => {
      logger.warn('IBKR auth status check failed', { error })
      return null
    })

    if (status && status.authenticated === false) {
      throw new Error(
        'IBKR Gateway session is not authenticated. Log in at the gateway URL ' +
          '(default https://localhost:5000) and retry.'
      )
    }

    await fetchBrokerJson<unknown>({
      providerId: 'ibkr',
      url: buildIbkrApiUrl('/tickle'),
      init: { method: 'POST', headers },
    }).catch((error) => logger.warn('IBKR tickle failed', { error }))

    lastTickleAt = now
  }

  if (!accountsPrimed) {
    await fetchBrokerJson<unknown>({
      providerId: 'ibkr',
      url: buildIbkrApiUrl('/iserver/accounts'),
      init: { method: 'GET', headers },
    })
    accountsPrimed = true
  }
}
