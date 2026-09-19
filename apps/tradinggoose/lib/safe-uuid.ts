/**
 * UUID generation that survives a non-secure browser context.
 *
 * `crypto.randomUUID` is only defined for secure contexts (https://, localhost,
 * 127.0.0.1). On a plain-HTTP origin such as http://100.64.0.8:3000 the property
 * is absent, so a bare `crypto.randomUUID()` throws
 * "TypeError: crypto.randomUUID is not a function".
 *
 * That is not theoretical here: the app is served over a Tailscale IP, and when
 * that happened every widget that mints an id failed at render time inside
 * WidgetRenderBoundary, taking out portfolio_snapshot, heatmap, watchlist and
 * quick_order at once (their header slots render first).
 *
 * `crypto.getRandomValues` is NOT restricted to secure contexts, so it is used
 * to build an RFC 4122 version 4 UUID by hand. If even that is unavailable a
 * counter-based fallback keeps the app callable; it trades absolute uniqueness
 * for not crashing, which is right for the id-generation sites in this codebase.
 */

let counter = 0

const HEX: string[] = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1))

/** Build an RFC 4122 v4 UUID string from 16 random bytes. */
function formatUuidV4(bytes: Uint8Array): string {
  // Set version (4) and variant (10xx) bits per RFC 4122 section 4.4.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  return (
    HEX[bytes[0]] + HEX[bytes[1]] +
    HEX[bytes[2]] + HEX[bytes[3]] + '-' +
    HEX[bytes[4]] + HEX[bytes[5]] + '-' +
    HEX[bytes[6]] + HEX[bytes[7]] + '-' +
    HEX[bytes[8]] + HEX[bytes[9]] + '-' +
    HEX[bytes[10]] + HEX[bytes[11]] +
    HEX[bytes[12]] + HEX[bytes[13]] +
    HEX[bytes[14]] + HEX[bytes[15]]
  )
}

/**
 * Returns a random UUID v4 string.
 *
 * Prefers `crypto.randomUUID` when available, then `crypto.getRandomValues`,
 * then a monotonic counter (only reachable on a non-secure origin with no
 * WebCrypto at all).
 */
export function safeRandomUUID(): string {
  const c = globalThis.crypto as Crypto | undefined

  if (typeof c?.randomUUID === 'function') {
    return c.randomUUID()
  }

  if (typeof c?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    c.getRandomValues(bytes)
    return formatUuidV4(bytes)
  }

  // Last resort: stay callable rather than throwing at render time.
  counter += 1
  const seed = `${Date.now().toString(16)}${counter.toString(16)}`
  const padded = seed.padEnd(32, '0').slice(0, 32)
  return (
    padded.slice(0, 8) + '-' + padded.slice(8, 12) + '-' + padded.slice(12, 16) +
    '-' + padded.slice(16, 20) + '-' + padded.slice(20, 32)
  )
}
