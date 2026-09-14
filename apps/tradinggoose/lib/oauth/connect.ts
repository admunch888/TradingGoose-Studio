'use client'

import { toast } from 'sonner'
import { client } from '@/lib/auth-client'
import { normalizeCallbackUrl } from '@/i18n/utils'
import { getTradingProviderOAuthServiceIds } from '@/providers/trading/providers'

interface ConnectOAuthServiceOptions {
  providerId: string
  callbackURL: string
}

/**
 * IBKR connects through the Client Portal Gateway's own login rather than an
 * OAuth redirect: the server checks the gateway session and records the
 * connection. Its refusal (gateway not logged in, user not allowed, paper/live
 * mismatch) is shown to the user, since callers only log a failed connect.
 */
async function connectIbkrGatewayService(serviceId: string) {
  const response = await fetch('/api/providers/trading/ibkr/gateway-connection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceId }),
  })
  if (response.ok) return

  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  const message =
    typeof body?.error === 'string' && body.error
      ? body.error
      : 'Failed to connect the IBKR gateway'
  toast.error(message)
  throw new Error(message)
}

export async function startOAuthConnectFlow({
  providerId,
  callbackURL,
}: ConnectOAuthServiceOptions) {
  const canonicalCallbackURL = normalizeCallbackUrl(callbackURL, window.location.origin)
  if (!canonicalCallbackURL) {
    throw new Error('Expected an internal OAuth callback URL')
  }

  if (providerId === 'trello') {
    window.location.href = `/api/auth/trello/authorize?callbackURL=${encodeURIComponent(canonicalCallbackURL)}`
    return
  }

  if (getTradingProviderOAuthServiceIds('ibkr').includes(providerId)) {
    await connectIbkrGatewayService(providerId)
    // Return to the callback like an OAuth redirect would, so every view reloads
    // its connections.
    window.location.href = canonicalCallbackURL
    return
  }

  await client.oauth2.link({
    providerId,
    callbackURL: canonicalCallbackURL,
    errorCallbackURL: canonicalCallbackURL,
  })
}
