/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBaseUrl, getInternalAppUrl } from '@/lib/urls/utils'

describe('getInternalAppUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses INTERNAL_APP_URL for server-to-app calls while the public URL stays the browser address', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    vi.stubEnv('INTERNAL_APP_URL', 'http://app:3000/')

    expect(getInternalAppUrl()).toBe('http://app:3000')
    expect(getBaseUrl()).toBe('http://localhost:3000')
  })

  it('falls back to the public URL when INTERNAL_APP_URL is unset or invalid', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    expect(getInternalAppUrl()).toBe('http://localhost:3000')

    vi.stubEnv('INTERNAL_APP_URL', 'not a url')
    expect(getInternalAppUrl()).toBe('http://localhost:3000')
  })
})
