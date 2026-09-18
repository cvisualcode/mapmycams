// ─── Serverless backend helpers (framework-agnostic) ─────────────────────────
// Works on Cloudflare Workers or any fetch-based runtime. Storage: Cloudflare KV,
// one key per record. There is no database to provision or migrate, which is why
// this is the store rather than Postgres — see MONETISATION.md, "Where accounts
// live".
//
// Requires two things on the Worker:
//   AUTH_SECRET       (secret)  — signs session tokens and keys password hashes
//   MAPMYCAMS_STORE   (binding) — the KV namespace holding accounts, plans, flags

import { verificationEmail } from './email-template.js'

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
  }))
  const key = await hmacKey(AUTH_SECRET())
  const sig = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`)))
  return `${header}.${payload}.${sig}`
}

/** Verify a session token and return `{ id, email }`, or null. */
export async function verifyToken(token) {
  try {
    requireConfig()
    const [h, p, sig] = token.split('.')
    const key = await hmacKey(AUTH_SECRET())
    const ok = await crypto.subtle.verify('HMAC', key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`))
    if (!ok) return null
    const payload = JSON.parse(b64url(p, true))
    if (payload.exp * 1000 < Date.now()) return null
    return payload.sub && payload.email ? { id: payload.sub, email: payload.email } : null
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
export async function sendVerificationEmail(email, code, name = '') {
  const apiKey = globalThis.env?.RESEND_API_KEY
  if (!apiKey) throw new Error('Email delivery is not configured (RESEND_API_KEY missing)')
  // No fallback sender on purpose: Resend's onboarding@resend.dev address can
  // only mail the account owner, so silently using it would look like a bug.
  const from = globalThis.env?.EMAIL_FROM
  if (!from) throw new Error('EMAIL_FROM is not set — it must be an address at your verified Resend domain')
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [email], ...verificationEmail(code, name) }),
  })
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`)
  return res.json()
}

// ── Accounts (Cloudflare KV) ─────────────────────────────────────────────────
// One key per account, keyed by the lowercased email, so signing in is a single
// read. Records keep the field names the routes use (is_admin, email_verified,
// verification_code_hash…) so a row is plain JSON with no mapping layer.

const userKey = (email) => `user:${String(email || '').trim().toLowerCase()}`

export async function getUser(email) {
  requireConfig()
  return (await store().get(userKey(email), 'json')) || null
}

export async function listUsers(limit = 1000) {
  requireConfig()
  const { keys } = await store().list({ prefix: 'user:', limit })
  const rows = await Promise.all(keys.map((k) => store().get(k.name, 'json')))
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

// ── Feature flags ────────────────────────────────────────────────────────────

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
export async function stripeCheckoutSession({ priceId, userId, email, mode, item }) {
  const params = {
    mode, // 'subscription' | 'payment'
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    client_reference_id: userId,
    customer_email: email,
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
  const parts = Object.fromEntries(sigHeader.split(',').map((kv) => kv.split('=')))
  const key = await hmacKey(secret)
  const expected = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${payload}`)))
  return expected === parts.v1
}

/** CORS headers for all responses. */
export function cors() {
  return {
    'Access-Control-Allow-Origin': globalThis.env?.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors() } })
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
