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
 * The plan as the page actually holds it, when that is more than the caller passed.
 *
 * The share button hands this module the four collections of the floor on screen, which
 * is a plan with one floor in it — the copy beside the button promises "floor by floor",
 * and a link that quietly drops the first and second floors is a link to somebody else's
 * house. The editor registers the whole plan through the same kind of window hook it
 * uses for saving, and that is preferred here when it is there. In Node, and anywhere
 * without an editor on the page, the caller's own snapshot is what gets encoded.
 */
function wholePlanOr(snapshot) {
  if (typeof window !== 'undefined' && typeof window.__mmcShareSnapshot === 'function') {
    try {
      const whole = window.__mmcShareSnapshot()
      if (whole && Array.isArray(whole.floors) && whole.floors.length) return whole
    } catch { /* a hook that throws is a hook to ignore */ }
  }
  return snapshot
}

/**
 * The full shareable URL for a snapshot. Any fragment already on the page (a
 * plan someone opened this link from, say) is replaced rather than nested.
 */
export function planShareUrl(snapshot, pageUrl = '') {
  const base = String(pageUrl).split('#')[0]
  return `${base}${PREFIX}${toBase64Url(JSON.stringify(wholePlanOr(snapshot)))}`
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
