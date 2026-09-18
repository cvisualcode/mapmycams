// ─── Shareable plan links ────────────────────────────────────────────────────
// A floorplan is a small JSON document, so it travels as a URL fragment: no
// server round-trip, nothing to expire, and the browser never sends a fragment to
// the server. Base64url so the link survives being pasted anywhere.
//
// Both directions work in the browser and in Node, which is what lets
// `bun run share:test` check the encoding without a page.

const PREFIX = '#plan='

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 = globalThis.btoa
    ? globalThis.btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = globalThis.atob
    ? globalThis.atob(padded)
    : Buffer.from(padded, 'base64').toString('binary')
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * The full shareable URL for a snapshot. Any fragment already on the page (a
 * plan someone opened this link from, say) is replaced rather than nested.
 */
export function planShareUrl(snapshot, pageUrl = '') {
  const base = String(pageUrl).split('#')[0]
  return `${base}${PREFIX}${toBase64Url(JSON.stringify(snapshot))}`
}

/**
 * The snapshot carried in a URL fragment, or null when there is none or it cannot
 * be read. A link is untrusted input: anything that is not a usable object is
 * treated as no link at all rather than half-applied to the planner.
 */
export function readSharedPlan(hash = '') {
  const raw = String(hash)
  if (!raw.startsWith(PREFIX)) return null
  try {
    const snapshot = JSON.parse(fromBase64Url(raw.slice(PREFIX.length)))
    return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : null
  } catch {
    return null
  }
}
