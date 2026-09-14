import { getEnv } from '@/lib/env'

export function getBaseUrl(): string {
  const value = getEnv('NEXT_PUBLIC_APP_URL')?.trim()

  if (!value) {
    throw new Error('NEXT_PUBLIC_APP_URL is required')
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Configured base URL must be a valid URL')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Configured base URL must use http or https')
  }

  return url.origin
}

/**
 * The origin server code uses to call this app's own API routes.
 *
 * NEXT_PUBLIC_APP_URL is the browser's address, and the realtime server must
 * keep it (it is the Socket.IO CORS origin). Inside a container that address is
 * the container itself - `http://localhost:3000` in the realtime container is
 * not the app - so listing lookups from realtime (chart quotes, portfolio
 * positions) failed with "Unable to connect". INTERNAL_APP_URL
 * (e.g. `http://app:3000`) is the container-to-container address; without it
 * the public URL is used, as before.
 */
export function getInternalAppUrl(): string {
  const internal = getEnv('INTERNAL_APP_URL')?.trim()
  if (internal) {
    try {
      const url = new URL(internal)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
    } catch {
      // An invalid value falls back to the public URL below.
    }
  }
  return getBaseUrl()
}

export function getBaseDomain(): string {
  return new URL(getBaseUrl()).host
}

export function getEmailDomain(): string {
  return getBaseDomain().replace(/^www\./, '')
}
