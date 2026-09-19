// ─── Browser error reporting ─────────────────────────────────────────────────
// An uncaught error used to be invisible: it reached the console of a visitor who
// then either told you or, far more often, did not. This sends them to
// POST /report-error, which logs them and keeps a counted list for the admin panel.
//
// Three rules, because a reporter that misbehaves is worse than none at all:
//
//  * It never throws, never blocks and never reports into a loop. Anything that goes
//    wrong while reporting is swallowed.
//  * It sends at most a handful per page load, and each distinct message once, so a
//    render that fails on every frame cannot become a hundred requests.
//  * It is silent to the visitor. Nobody should see an error reporter.
//
// The same code is what the editor and the lander both use, since the errors that
// matter can happen anywhere — including on the sign-in screen, before any session
// exists.

/**
 * Where the API is. Relative by default, because the Worker serves both the app and the
 * API from one origin; a static host (the Pages build) has no API of its own, so it
 * bakes VITE_API_URL in and points here at the Worker instead — the same setting
 * api.js reads for every other call. Without this, a report from the Pages host would
 * be posted to a route that host does not serve and thrown away.
 */
const API_BASE = ((typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) || '').replace(/\/+$/, '')
const REPORT_URL = `${API_BASE}/report-error`

/** Per page load: never more than this many reports, and never the same one twice. */
const MAX_REPORTS = 6

/** Long messages are truncated server-side too; this keeps the request small. */
const MAX_MESSAGE = 300

let installed = false
const reported = new Set()
let sent = 0

function report(payload) {
  if (sent >= MAX_REPORTS) return
  const message = String(payload?.message || '').trim().slice(0, MAX_MESSAGE)
  if (!message) return
  // A message with digits stripped is the same bug at a different line: report it once.
  const signature = message.toLowerCase().replace(/\d+/g, '#')
  if (reported.has(signature)) return
  reported.add(signature)
  sent += 1
  try {
    fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        stack: String(payload?.stack || '').slice(0, 1000),
        path: typeof window !== 'undefined' ? window.location?.pathname || '' : '',
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      }),
      // The report must not keep the page alive or block a navigation.
      keepalive: true,
    }).catch(() => {})
  } catch { /* a reporter that breaks the app is worse than no reporter */ }
}

/**
 * Start listening. Safe to call more than once, and safe to call with no window at
 * all (a prerender, a test), in which case it does nothing.
 */
export function installErrorReporting() {
  if (installed || typeof window === 'undefined') return false
  installed = true
  window.addEventListener('error', (event) => {
    // A resource that failed to load arrives here too, without a message and with a
    // target instead. Those are usually a missing image rather than a broken app, and
    // they would drown the real ones.
    if (!event?.message) return
    report({ message: event.message, stack: event.error?.stack })
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason
    report({
      message: reason?.message || String(reason || 'Unhandled promise rejection'),
      stack: reason?.stack,
    })
  })
  return true
}

/** Exposed for tests: whether a message has already been sent from this page. */
export function reportedCount() {
  return reported.size
}
