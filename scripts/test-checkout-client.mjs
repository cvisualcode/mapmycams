// ─── Client checkout test ────────────────────────────────────────────────────
// The half of a purchase that lives in the browser: src/monetisation/api.js.
// Two things have to hold for a plan click to reach Stripe, and both have failed
// silently before:
//
//   1. An account the server cannot charge for (one that only exists in this
//      browser) must raise a flagged error the UI can act on — `needsAccount` —
//      rather than a message that never reaches the customer.
//   2. With a server session, the click must actually navigate to the URL Stripe
//      returned, instead of handing it back to a caller that drops it.
//
//   bun run checkout:test
//
// No network and no Stripe account: fetch is stubbed, storage is a Map. The stub
// is shaped like the live site — /me answers JSON (so the API is "there"), while
// the auth and mailer routes answer HTML, which is how an account came to live in
// one browser before the server existed.

// The module reads window.localStorage at import time, so the browser globals
// have to exist before it is imported.
const store = new Map()
const assigned = []
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
  },
  location: { href: 'https://mapmycams.dev/', assign: (url) => { assigned.push(url) } },
}
globalThis.crypto ??= (await import('node:crypto')).webcrypto
globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary')

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
/** A host with no API behind it answers with a page, not JSON. */
const html = (status = 404) =>
  new Response('<html>Not found</html>', { status, headers: { 'Content-Type': 'text/html' } })

let checkoutUrl = null
let seenCheckout = null
let seenAuth = null

globalThis.fetch = async (url, options = {}) => {
  // The app calls relative paths ('/me', '/billing/checkout'): the browser resolves
  // those against the page, so the stub resolves them against the site.
  const path = new URL(url, 'https://mapmycams.dev').pathname
  // An API is reachable on this origin…
  if (path === '/me') return json({ error: 'Unauthorised' }, 401)
  // …but it never had this account, and it is not the mailer either.
  if (path.startsWith('/auth/')) return html()
  if (path === '/billing/checkout') {
    seenCheckout = JSON.parse(options.body || '{}')
    seenAuth = options.headers?.Authorization || null
    return checkoutUrl ? json({ url: checkoutUrl }) : json({ error: 'Stripe is not configured' }, 503)
  }
  return html()
}

const api = await import('../src/monetisation/api.js')

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

// ── An account that lives in this browser only ───────────────────────────────
const signup = await api.signup('crmiles@btinternet.com', 'Password1')
check('signup with no API behind it hands back the code', Boolean(signup.devCode), JSON.stringify(signup))
const user = await api.verifyEmail('crmiles@btinternet.com', signup.devCode)
check('the account is signed in', user?.email === 'crmiles@btinternet.com', JSON.stringify(user))

// ── Clicking a plan on it: the UI must get something it can act on ───────────
const err = await api.startCheckout('premium_monthly', 'plan').then(() => null, (e) => e)
check('a purchase on a browser-only account raises a flagged error', err?.needsAccount === true, String(err?.message))
check('the flag carries the address to prefill', err?.email === 'crmiles@btinternet.com')
check('the customer is told what to do', /confirm your email/i.test(err?.message || ''))
check('nothing was sent to Stripe', seenCheckout === null)

// ── Once the account exists server-side, the same click reaches Stripe ───────
// What the account gate achieves: a server session for that address.
store.set('mmc_token_v1', 'srv_token_test_1234')
checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_gate'
const started = await api.startCheckout('premium_monthly', 'plan')
check('a purchase with a server session starts a redirect', started?.redirecting === true, JSON.stringify(started))
check('the browser was sent to the URL the server returned', assigned.at(-1) === checkoutUrl)
check('the session token travelled with the request', seenAuth === 'Bearer srv_token_test_1234', String(seenAuth))
check('the request named the item and its kind', seenCheckout?.item === 'premium_monthly' && seenCheckout?.kind === 'plan', JSON.stringify(seenCheckout))

const addon = await api.startCheckout('ai_pack', 'addon')
check('an add-on takes the same route', addon?.redirecting === true && seenCheckout?.item === 'ai_pack' && seenCheckout?.kind === 'addon')

// ── A refusal is reported, never swallowed ───────────────────────────────────
checkoutUrl = null // /billing/checkout now answers 503, as it does with no Stripe key
const refused = await api.startCheckout('premium_monthly', 'plan').then(() => null, (e) => e)
check('a refusal from the server surfaces as an error', /not configured/i.test(refused?.message || ''), String(refused?.message))

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll client checkout checks passed.')
process.exit(failures ? 1 : 0)
