import { resolveIbkrApiBaseUrl, resolveIbkrApiIp } from '@/providers/trading/ibkr/config'

/**
 * IBKR exposes two different surfaces with incompatible auth:
 *
 *  - Client Portal Gateway (local, the default here): the session is
 *    established by logging in through the browser at the gateway's own URL.
 *    Requests carry that session implicitly; there is NO bearer token, and
 *    sending an Authorization header is simply ignored. Requiring a token here
 *    is what made every market-data call fail before a request was even sent.
 *  - Hosted OAuth API (api.ibkr.com): bearer token, plus the originating `ip`.
 *
 * We pick by base URL rather than by a flag so the two can never disagree.
 */
export const isIbkrHostedApi = (): boolean => /(^|\.)api\.ibkr\.com/i.test(resolveIbkrApiBaseUrl())

export const buildIbkrAuthHeaders = (params: { accessToken?: string } = {}): Record<
  string,
  string
> => {
  if (!isIbkrHostedApi()) {
    // Gateway mode: the session cookie does the work. Nothing to add.
    return { Accept: 'application/json' }
  }

  if (!params.accessToken) {
    throw new Error('IBKR hosted API requires an access token')
  }

  return {
    Accept: 'application/json',
    Authorization: `Bearer ${params.accessToken}`,
    ip: resolveIbkrApiIp(),
  }
}
