// ─── Serverless backend helpers (framework-agnostic) ─────────────────────────
// Works on Cloudflare Workers, Vercel Node functions, or any fetch-based
// runtime. Database: Supabase (Postgres) via REST — no native driver needed.

import { verificationEmail } from './email-template.js'

const SUPABASE_URL = () => globalThis.env?.SUPABASE_URL
const SUPABASE_KEY = () => globalThis.env?.SUPABASE_SERVICE_KEY
const AUTH_SECRET = () => globalThis.env?.AUTH_SECRET || 'dev-secret-change-me'

// ── JWT (HS256, no external deps) ────────────────────────────────────────────

function b64url(bytesOrStr, decode) {
  if (decode) return atob(String(bytesOrStr).replace(/-/g, '+').replace(/_/g, '/'))
  const b = typeof bytesOrStr === 'string' ? new TextEncoder().encode(bytesOrStr) : bytesOrStr
  return btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/** Sign a JWT for the given user id. */
export async function signToken(userId, days = 30) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + days * 86400 }))
  const key = await hmacKey(AUTH_SECRET())
  const sig = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`)))
  return `${header}.${payload}.${sig}`
}

/** Verify a JWT and return the user id, or null. */
export async function verifyToken(token) {
  try {
    const [h, p, sig] = token.split('.')
    const key = await hmacKey(AUTH_SECRET())
    const ok = await crypto.subtle.verify('HMAC', key, b64url(sig, true).buffer, new TextEncoder().encode(`${h}.${p}`))
    if (!ok) return null
    const payload = JSON.parse(b64url(p, true))
    if (payload.exp * 1000 < Date.now()) return null
    return payload.sub
  } catch { return null }
}

// ── Password hashing (PBKDF2, no external deps) ──────────────────────────────

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256)
  return `pbkdf2:${b64url(salt)}:${b64url(bits)}`
}

export async function verifyPassword(password, stored) {
  try {
    const [, saltB64, bitsB64] = stored.split(':')
    const salt = Uint8Array.from(b64url(saltB64, true), (c) => c.charCodeAt(0))
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256)
    return b64url(bits) === bitsB64
  } catch { return false }
}

// ── Email verification codes ─────────────────────────────────────────────────
// A signup is only usable once the address is proven, so the code is the
// account's gate rather than a nicety. Only its hash is ever stored, so a
// leaked row cannot be replayed, and it is short-lived and attempt-limited.

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

/** Hash a code exactly like a password, so the stored value is not replayable. */
export async function hashCode(code) { return hashPassword(String(code)) }
export async function verifyCode(code, stored) { return verifyPassword(String(code), stored) }

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

// ── Supabase REST ────────────────────────────────────────────────────────────

export async function db(table, opts = {}) {
  const url = new URL(`${SUPABASE_URL()}/rest/v1/${table}`)
  if (opts.select) url.searchParams.set('select', opts.select)
  for (const [k, v] of Object.entries(opts.eq || {})) url.searchParams.set(k, `eq.${v}`)
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY(), Authorization: `Bearer ${SUPABASE_KEY()}`,
      'Content-Type': 'application/json', Prefer: opts.prefer || (opts.representation ? 'return=representation' : ''),
    },
    method: opts.method || 'GET',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  if (!res.ok && res.status !== 404) throw new Error(`DB ${table}: ${res.status}`)
  if (res.status === 404) return []
  return res.json()
}

/** Insert-or-update by primary key (PostgREST merge-duplicates). */
export async function dbUpsert(table, body) {
  return db(table, { method: 'POST', body, prefer: 'resolution=merge-duplicates,return=representation' })
}

// ── Stripe (REST, no SDK) ────────────────────────────────────────────────────

const STRIPE_SECRET = () => globalThis.env?.STRIPE_SECRET_KEY

async function stripeFetch(path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  })
  if (!res.ok) throw new Error(`Stripe ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function stripeCheckoutSession({ priceId, userId, email, mode }) {
  return stripeFetch('checkout/sessions', {
    mode, // 'subscription' | 'payment'
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    client_reference_id: userId,
    customer_email: email,
    success_url: `${globalThis.env?.APP_URL || ''}/?checkout=success`,
    cancel_url: `${globalThis.env?.APP_URL || ''}/?checkout=cancelled`,
    'metadata[userId]': userId,
  })
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

/** Naive per-user rate limiting for AI endpoints (in-memory; use KV/Redis at scale). */
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
