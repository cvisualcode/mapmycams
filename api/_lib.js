// ─── Serverless backend helpers (framework-agnostic) ─────────────────────────
// Works on Cloudflare Workers or any fetch-based runtime. Storage: Cloudflare KV,
// one key per record. There is no database to provision or migrate, which is why
// this is the store rather than Postgres — see MONETISATION.md, "Where accounts
// live".
//
// Requires two things on the Worker:
//   AUTH_SECRET       (secret)  — signs session tokens and keys password hashes
//   MAPMYCAMS_STORE   (binding) — the KV namespace holding accounts, plans, flags

import { verificationEmail, passwordResetEmail, escapeHtml } from './email-template.js'

const AUTH_SECRET = () => globalThis.env?.AUTH_SECRET
const store = () => globalThis.env?.MAPMYCAMS_STORE
const configured = () => Boolean(AUTH_SECRET() && store())

/** Thrown when the Worker is missing a binding, named so the cause is obvious. */
function requireConfig() {
  if (!AUTH_SECRET()) throw new Error('AUTH_SECRET is not set — run: bunx wrangler secret put AUTH_SECRET')
  if (!store()) throw new Error('MAPMYCAMS_STORE binding is missing — see wrangler.jsonc (kv_namespaces)')
}

export const backendConfigured = configured

// ── JWT (HS256, no external deps) ────────────────────────────────────────────

function b64url(bytesOrStr, decode) {
  if (decode) {
    // base64url arrives unpadded and with -/_ instead of +//; atob needs both undone.
    const s = String(bytesOrStr).replace(/-/g, '+').replace(/_/g, '/')
    return atob(s + '='.repeat((4 - (s.length % 4)) % 4))
  }
  const b = typeof bytesOrStr === 'string' ? new TextEncoder().encode(bytesOrStr) : bytesOrStr
  return btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode base64url into bytes. `b64url(..., true)` returns a string, and
 * `crypto.subtle.verify` needs a buffer — passing the string made every single
 * session token fail verification.
 */
function b64urlBytes(str) {
  const raw = b64url(str, true)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/**
 * Sign a session token. The email travels in the payload alongside the id so a
 * request needs a single key lookup instead of an id→user index that could drift
 * out of step with the record.
 */
export async function signToken(user, days = 30) {
  requireConfig()
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({
    sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + days * 86400,
    // Which password this session was issued against. Changing the password bumps the
    // account's version, which retires every token minted before it — without that, a
    // reset would leave whoever already had the account signed in still signed in.
    // Absent means 0, so tokens issued before this existed keep working.
    pv: user.password_version || 0,
  }))
  const key = await hmacKey(AUTH_SECRET())
  const sig = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`)))
  return `${header}.${payload}.${sig}`
}

/** Verify a session token and return `{ id, email }`, or null. */
export async function verifyToken(token) {
  try {
    requireConfig()
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [h, p, sig] = parts
    const header = JSON.parse(b64url(h, true))
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null
    const key = await hmacKey(AUTH_SECRET())
    const ok = await crypto.subtle.verify('HMAC', key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`))
    if (!ok) return null
    const payload = JSON.parse(b64url(p, true))
    if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= Date.now()) return null
    if (payload.pv != null && (!Number.isInteger(payload.pv) || payload.pv < 0)) return null
    return payload.sub && payload.email
      ? { id: payload.sub, email: payload.email, pv: payload.pv || 0 }
      : null
  } catch { return null }
}

// ── Credentials ──────────────────────────────────────────────────────────────
// The browser stretches the password (PBKDF2-SHA256, 210k iterations, per-account
// salt) and sends only the result, so the raw password never reaches the server
// and the expensive part of the hash runs where there is no CPU budget to blow —
// Cloudflare's free plan allows ~10ms per request, which 210k PBKDF2 does not fit
// in. The server keys that value with AUTH_SECRET, so a leaked record is not a
// usable credential on its own, and a caller cannot quietly send a cheap hash.

const CREDENTIAL_RE = /^pbkdf2\$sha256\$(\d+)\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/
export const MIN_CLIENT_ITERATIONS = 100000

/** Null when the value is an acceptable stretched password, else the reason. */
export function credentialProblem(credential) {
  if (typeof credential !== 'string' || !CREDENTIAL_RE.test(credential)) {
    return 'The password must arrive already hashed by the browser (see wireCredential in src/monetisation/api.js)'
  }
  const iterations = Number(credential.split('$')[2])
  if (!Number.isFinite(iterations) || iterations < MIN_CLIENT_ITERATIONS) {
    return `Password stretching is too weak: ${iterations} iterations, at least ${MIN_CLIENT_ITERATIONS} required`
  }
  return null
}

/** Constant-time string comparison, so equality does not leak through timing. */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Keyed digest of `${label}:${value}` — the server's own layer over the hash. */
async function digest(label, value) {
  requireConfig()
  const key = await hmacKey(AUTH_SECRET())
  const bits = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${label}:${value}`))
  return b64url(bits)
}

export async function hashPassword(credential) { return `hmac-sha256:${await digest('pw', credential)}` }

export async function verifyPassword(credential, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('hmac-sha256:')) return false
  return timingSafeEqual(await digest('pw', credential), stored.slice('hmac-sha256:'.length))
}

// ── Email verification codes ─────────────────────────────────────────────────
// A signup is only usable once the address is proven, so the code is the
// account's gate rather than a nicety. Only its hash is ever stored, it is
// short-lived, and it is attempt-limited.

export const CODE_TTL_MS = 10 * 60 * 1000          // 10 minutes
export const CODE_MAX_ATTEMPTS = 5
const RESEND_COOLDOWN_MS = 60 * 1000               // 1 minute between sends

export const resendCooldownRemaining = (sentAt) => {
  if (!sentAt) return 0
  const elapsed = Date.now() - new Date(sentAt).getTime()
  return elapsed >= RESEND_COOLDOWN_MS ? 0 : Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000)
}

/**
 * A cryptographically random 6-digit code. Rejection sampling keeps every code
 * equally likely — taking a 32-bit value modulo 1,000,000 would favour the low
 * end of the range.
 */
export function generateVerificationCode() {
  const limit = Math.floor(0x100000000 / 1000000) * 1000000
  const buf = new Uint32Array(1)
  let n
  do { crypto.getRandomValues(buf); n = buf[0] } while (n >= limit)
  return String(n % 1000000).padStart(6, '0')
}

/** Codes are keyed like passwords, so a leaked record cannot be replayed. */
export async function hashCode(code) { return `hmac-sha256:${await digest('code', code)}` }

export async function verifyCode(code, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('hmac-sha256:')) return false
  return timingSafeEqual(await digest('code', code), stored.slice('hmac-sha256:'.length))
}

/** True when a transactional email provider is wired up. */
export const emailConfigured = () => Boolean(globalThis.env?.RESEND_API_KEY)

/**
 * Send the 6-digit code with Resend's REST API (no SDK, one POST).
 * Throws when delivery is not configured — callers decide how to degrade.
 */
async function sendCodeEmail(email, template) {
  const apiKey = globalThis.env?.RESEND_API_KEY
  if (!apiKey) throw new Error('Email delivery is not configured (RESEND_API_KEY missing)')
  // No fallback sender on purpose: Resend's onboarding@resend.dev address can
  // only mail the account owner, so silently using it would look like a bug.
  const from = globalThis.env?.EMAIL_FROM
  if (!from) throw new Error('EMAIL_FROM is not set — it must be an address at your verified Resend domain')
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [email], ...template }),
  })
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function sendVerificationEmail(email, code, name = '') {
  return sendCodeEmail(email, verificationEmail(code, name))
}

/** The same delivery, carrying the password-reset wording. */
export async function sendResetEmail(email, code, name = '') {
  return sendCodeEmail(email, passwordResetEmail(code, name))
}

// ── Accounts (Cloudflare KV) ─────────────────────────────────────────────────
// One key per account, keyed by the lowercased email, so signing in is a single
// read. Records keep the field names the routes use (is_admin, email_verified,
// verification_code_hash…) so a row is plain JSON with no mapping layer.

const userKey = (email) => `user:${String(email || '').trim().toLowerCase()}`

export async function getUser(email) {
  requireConfig()
  const row = (await store().get(userKey(email), 'json')) || null
  if (!row) return null
  // Separate, append-only grant keys cannot be overwritten by a password/profile
  // update or another simultaneous purchase. Legacy account add-ons are retained.
  const addons = ['ai_pack', 'pdf_report', 'brands']
  const grants = await Promise.all(addons.map((item) => store().get(`owned:${row.id}:${item}`, 'json')))
  return { ...row, addons: [...new Set([...(row.addons || []), ...addons.filter((_, i) => grants[i])])] }
}

export async function listUsers(limit = 1000) {
  requireConfig()
  const rows = []
  let cursor
  do {
    const page = await store().list({ prefix: 'user:', limit, ...(cursor ? { cursor } : {}) })
    rows.push(...await Promise.all(page.keys.map((k) => store().get(k.name, 'json'))))
    cursor = page.list_complete === false ? page.cursor : null
  } while (cursor)
  return rows.filter(Boolean)
}

/**
 * Insert-or-update an account. Callers pass only what changed, as the Postgres
 * upsert did, so the existing record is read first and merged. A read-modify-write
 * can lose a concurrent write, which for this traffic is the right trade for not
 * needing a transactional store.
 */
export async function saveUser(patch) {
  requireConfig()
  const email = String(patch?.email || '').trim().toLowerCase()
  if (!email) throw new Error('saveUser requires an email address')
  const existing = await getUser(email)
  const row = { ...existing, ...patch, email, updated_at: new Date().toISOString() }
  await store().put(userKey(email), JSON.stringify(row))
  return row
}

// ── Floorplans ───────────────────────────────────────────────────────────────
// Stored under the owner's id, so a plan belongs to the account rather than to
// the browser that drew it.

const planKey = (ownerId, id) => `plan:${ownerId}:${id}`

export async function listFloorplans(ownerId) {
  requireConfig()
  if (!ownerId) return []
  const { keys } = await store().list({ prefix: `plan:${ownerId}:`, limit: 1000 })
  const rows = await Promise.all(keys.map((k) => store().get(k.name, 'json')))
  return rows.filter(Boolean).sort((a, b) => (b.updated || 0) - (a.updated || 0))
}

export async function saveFloorplan(row) {
  requireConfig()
  if (!row?.id || !row?.owner) throw new Error('saveFloorplan requires an id and an owner')
  await store().put(planKey(row.owner, row.id), JSON.stringify(row))
  return row
}

export async function deleteFloorplan(ownerId, id) {
  requireConfig()
  if (!ownerId || !id) return
  await store().delete(planKey(ownerId, id))
}

// ── Shared plan links ─────────────────────────────────────────────────────────
// A share is an immutable snapshot published under a random capability code. It is
// a separate record from the editable plan, so a later edit cannot rewrite what a
// client was shown, and revoking it cannot damage the plan itself.

const shareKey = (code) => `share:${code}`
const shareCommentsKey = (code) => `share-comments:${code}`
const shareOpensKey = (code) => `share-opens:${code}`

/** 128 bits of entropy, url-safe. */
export function shareCode() {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function saveShare(record) {
  requireConfig()
  await store().put(shareKey(record.code), JSON.stringify(record))
  return record
}

export async function getShare(code) {
  requireConfig()
  return (await store().get(shareKey(String(code)), 'json')) || null
}

export async function deleteShare(code) {
  requireConfig()
  await store().delete(shareKey(String(code)))
}

export async function listShares(ownerId) {
  requireConfig()
  const { keys } = await store().list({ prefix: 'share:', limit: 1000 })
  const rows = await Promise.all(keys.map((k) => store().get(k.name, 'json')))
  return rows.filter((row) => row && row.owner === ownerId).sort((a, b) => (b.created || 0) - (a.created || 0))
}

export async function listShareComments(code) {
  requireConfig()
  return (await store().get(shareCommentsKey(String(code)), 'json')) || []
}

export async function saveShareComments(code, comments) {
  requireConfig()
  await store().put(shareCommentsKey(String(code)), JSON.stringify(comments))
  return comments
}

/** Open counts are best effort by design — KV has no atomic counter. */
export async function countShareOpen(code) {
  requireConfig()
  const key = shareOpensKey(String(code))
  const count = Number(await store().get(key)) || 0
  await store().put(key, String(count + 1))
  return count + 1
}

export async function shareOpenCount(code) {
  requireConfig()
  return Number(await store().get(shareOpensKey(String(code)))) || 0
}

/** The printable report email. Same Resend transport as the verification codes. */
export async function sendReportEmail(email, { title, summary, url }) {
  return sendCodeEmail(email, {
    subject: `Security plan report: ${String(title).slice(0, 80)}`,
    html: [
      '<h2 style="font-family:sans-serif">Your security plan report is ready</h2>',
      `<p style="font-family:sans-serif">${escapeHtml(String(summary).slice(0, 600))}</p>`,
      `<p style="font-family:sans-serif"><a href="${escapeHtml(url)}">Open the printable report</a></p>`,
      '<p style="font-family:sans-serif;color:#64748b">The report opens read-only. Use your browser\'s print dialog to save it as a PDF.</p>',
    ].join(''),
    text: `Security plan report: ${url}`,
  })
}

// ── Feature flags ────────────────────────────────────────────────────────────

/**
 * Read and write a plain JSON record.
 *
 * Accounts and floorplans have shapes of their own; the funnel counters and the
 * client-error list do not, and they belong in the same store rather than in a second
 * one. Both are read only by the admin panel.
 */
export async function readJson(key) {
  requireConfig()
  return (await store().get(key, 'json')) || null
}

export async function writeJson(key, value) {
  requireConfig()
  await store().put(key, JSON.stringify(value))
  return value
}

export async function setFlag(key, enabled) {
  requireConfig()
  await store().put(`flag:${key}`, JSON.stringify(Boolean(enabled)))
}

// ── Stripe (REST, no SDK) ────────────────────────────────────────────────────

const STRIPE_SECRET = () => globalThis.env?.STRIPE_SECRET_KEY

/** False until real prices and a secret key exist — billing then runs in demo mode. */
export const stripeConfigured = () => Boolean(STRIPE_SECRET())

const APP_URL = () => globalThis.env?.APP_URL || ''

async function stripeFetch(path, params, method = 'POST') {
  const query = method === 'GET' && params ? `?${new URLSearchParams(params)}` : ''
  const res = await fetch(`https://api.stripe.com/v1/${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: method === 'GET' ? undefined : new URLSearchParams(params || {}).toString(),
  })
  if (!res.ok) throw new Error(`Stripe ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

/**
 * Create a Checkout Session. The browser is sent to Stripe's own page to pay;
 * nothing is granted until a payment completes, which is reported either by the
 * webhook or by the account app asking Stripe about the session on return.
 */
export async function stripeCheckoutSession({ priceId, userId, email, mode, item, customerId }) {
  const params = {
    mode, // 'subscription' | 'payment'
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    client_reference_id: userId,
    ...(customerId ? { customer: customerId } : { customer_email: email }),
    ...(mode === 'payment' && !customerId ? { customer_creation: 'always' } : {}),
    // Stripe fills {CHECKOUT_SESSION_ID} in, so the app can confirm the purchase
    // itself instead of waiting for the webhook to land.
    success_url: `${APP_URL()}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL()}/?checkout=cancelled`,
    'metadata[userId]': userId,
    'metadata[item]': item,
  }
  // A subscription outlives the session that created it, and cancellation comes
  // back as a customer.subscription.* event whose metadata is taken from here —
  // not from the session — so the userId has to be copied onto the subscription
  // too, or nothing would be able to match the cancellation to an account.
  if (mode === 'subscription') params['subscription_data[metadata][userId]'] = userId
  return stripeFetch('checkout/sessions', params)
}

/** Read a session back, so the app can confirm a purchase without the webhook. */
export async function stripeGetSession(sessionId) {
  return stripeFetch(`checkout/sessions/${encodeURIComponent(sessionId)}`, null, 'GET')
}

/** Recent invoices for the billing history panel. */
export async function stripeListInvoices(customerId, limit = 12) {
  const { data } = await stripeFetch('invoices', { customer: customerId, limit: String(limit) }, 'GET')
  return data || []
}

export async function stripePortalSession(customerId) {
  return stripeFetch('billing_portal/sessions', {
    customer: customerId,
    return_url: `${globalThis.env?.APP_URL || ''}/`,
  })
}

/** Verify Stripe webhook signature (t=,v1= scheme). */
export async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!secret || typeof sigHeader !== 'string') return false
  const parts = sigHeader.split(',').map((part) => part.trim().split('='))
  const timestamps = parts.filter(([name]) => name === 't')
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0][1])) return false
  const timestamp = Number(timestamps[0][1])
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false
  const key = await hmacKey(secret)
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`))
  const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return parts.some(([name, value]) => name === 'v1' && /^[a-f0-9]{64}$/.test(value || '') && timingSafeEqual(expected, value))
}

/** Permanent receipt and one-time ownership. No TTL, browser state, or user-row rewrite. */
export async function recordPurchase(account, session) {
  const key = `purchase:${account.id}:${session.id}`
  const existing = await readJson(key)
  const receipt = existing || {
    id: session.id, owner: account.id, item: session.metadata.item,
    kind: session.mode === 'payment' ? 'addon' : 'subscription',
    amount: (session.amount_total || 0) / 100, currency: session.currency || 'gbp',
    customer: session.customer, subscription: session.subscription || null,
    status: 'paid', date: new Date((session.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  }
  if (!existing) await writeJson(key, receipt)
  if (session.mode === 'payment') await writeJson(`owned:${account.id}:${session.metadata.item}`, { purchase: session.id })
  return receipt
}

export async function listPurchases(ownerId) {
  const rows = []
  let cursor
  do {
    const page = await store().list({ prefix: `purchase:${ownerId}:`, limit: 1000, ...(cursor ? { cursor } : {}) })
    rows.push(...await Promise.all(page.keys.map((key) => readJson(key.name))))
    cursor = page.list_complete === false ? page.cursor : null
  } while (cursor)
  return rows.filter(Boolean).sort((a, b) => b.date.localeCompare(a.date))
}

/** CORS headers for all responses. */
export function cors() {
  return {
    'Access-Control-Allow-Origin': globalThis.env?.ALLOWED_ORIGIN || globalThis.env?.APP_URL || 'https://mapmycams.dev',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors() } })
}

/** Naive per-user rate limiting for AI endpoints (in-memory; use KV at scale). */
const rateBuckets = new Map()
export function rateLimit(userId, limit = 10, windowMs = 60000) {
  const now = Date.now()
  const bucket = rateBuckets.get(userId) || []
  const recent = bucket.filter((t) => now - t < windowMs)
  if (recent.length >= limit) return false
  recent.push(now)
  rateBuckets.set(userId, recent)
  return true
}
