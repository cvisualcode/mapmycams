// ─── API client ──────────────────────────────────────────────────────────────
// Runs against the serverless backend in /api when VITE_API_URL is configured,
// and against a local account store otherwise so the product works with no keys.
// Either way credentials are handled the same way: passwords are stretched with
// PBKDF2-SHA256 (210,000 iterations) and a fresh random salt per account, and
// sessions are random 32-byte tokens with an expiry — never a raw user id.

// Where the API lives. Empty (the default) means "this origin", which is where
// the deployed worker serves /auth/*. In the sandbox preview that path belongs
// to the Vite dev server, so server calls there report "no server" and the local
// account store takes over — see apiRaw().
const API_URL = ((typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) || '').replace(/\/+$/, '')
// Where the verification code is actually emailed from. The default is the same
// origin, which is where the deployed worker serves /auth/send-code. Override
// with VITE_MAILER_URL if the API lives on another host.
const MAILER_URL = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_MAILER_URL) || '/auth/send-code'
const DB_KEY = 'mmc_accounts_v1'
const SESSION_KEY = 'mmc_session_v1'
const TOKEN_KEY = 'mmc_token_v1'
const ANALYTICS_KEY = 'mmc_analytics_v1'
const FLOORS_KEY = 'mmc_floorplans_v1'
const PENDING_KEY = 'mmc_pending_verification_v1'
const SESSION_DAYS = 30

// Email-verification policy. Kept in step with api/_lib.js, which enforces the
// same limits server-side when a backend is connected.
const CODE_TTL_MS = 10 * 60 * 1000
const CODE_MAX_ATTEMPTS = 5
const RESEND_COOLDOWN_MS = 60 * 1000

const PBKDF2_ITERATIONS = 210000
const SEED_ADMIN_PASSWORD = 'Admin1'

// ─── Storage backends ────────────────────────────────────────────────────────
// An account has to outlive a page reload, so every backend is probed with a
// real write/read/delete before it is trusted. Browsers refuse storage outright
// in third-party frames and in some private modes — Safari and Chrome both
// throw on `window.localStorage` access there — and silently swallowing that
// failure is exactly how a signup can look successful and then be gone. So we
// use the most durable backend that genuinely round-trips a write, remember
// which one that is, and let the UI say so out loud instead of losing the data.

const memoryStore = new Map()

/** Probe one backend. Returns it only if a write actually reads back. */
function probeBackend(resolve, name, durable) {
  try {
    const store = resolve()
    if (!store) return null
    const probeKey = '__mmc_storage_probe__'
    store.setItem(probeKey, 'ok')
    const echoed = store.getItem(probeKey)
    store.removeItem(probeKey)
    if (echoed !== 'ok') return null
    return {
      name,
      durable,
      getItem: (k) => store.getItem(k),
      setItem: (k, v) => store.setItem(k, String(v)),
      removeItem: (k) => store.removeItem(k),
    }
  } catch { return null }
}

const storage =
  probeBackend(() => window.localStorage, 'local', true) ||
  probeBackend(() => window.sessionStorage, 'session', false) || {
    name: 'memory',
    durable: false,
    getItem: (k) => (memoryStore.has(k) ? memoryStore.get(k) : null),
    setItem: (k, v) => { memoryStore.set(k, String(v)) },
    removeItem: (k) => { memoryStore.delete(k) },
  }

function ls() { return storage }

/** 'persistent' | 'session' | 'memory' — how long account data actually lasts. */
export function storageMode() {
  if (storage.name === 'local') return 'persistent'
  return storage.name === 'session' ? 'session' : 'memory'
}

/** True when an account created now still exists after a reload or a new tab. */
export function storageIsDurable() { return storage.durable }

/**
 * Plain-language explanation of a storage limitation, or '' when there is none.
 * Shown on the sign-in screen so a blocked browser never silently eats a signup.
 */
export function storageNotice() {
  if (storageMode() === 'session') {
    return 'This browser blocks persistent storage here, so an account survives a reload but not closing the tab. Open the preview in its own browser tab to store accounts normally.'
  }
  if (storageMode() === 'memory') {
    return 'This browser blocks all local storage here, so an account created now is lost on reload. Open the preview in its own browser tab to sign up.'
  }
  return ''
}

// ─── Crypto helpers ──────────────────────────────────────────────────────────

function toB64(bytes) {
  let s = ''
  const arr = new Uint8Array(bytes)
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i])
  return btoa(s)
}

function fromB64(b64) {
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function randomBytes(n) {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

/** Legacy DJB2 hash — kept only so pre-existing accounts can be migrated. */
function legacyHash(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0
  return 'h' + h.toString(36)
}

// ─── Fallback: dependency-free SHA-256 / HMAC / PBKDF2 ───────────────────────
// SubtleCrypto only exists in a secure context, and a sandboxed or opaque-origin
// frame has none. Passwords still have to be hashed there, so this
// implementation is carried locally. Its output is byte-identical to the
// WebCrypto path, so a hash made by either can be verified by the other.

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(x, n) { return (x >>> n) | (x << (32 - n)) }

/** SHA-256 of a byte array. */
function sha256(bytes) {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const total = (((bytes.length + 9) >> 6) + 1) << 6
  const msg = new Uint8Array(total)
  msg.set(bytes)
  msg[bytes.length] = 0x80
  const dv = new DataView(msg.buffer)
  dv.setUint32(total - 8, Math.floor((bytes.length * 8) / 4294967296))
  dv.setUint32(total - 4, (bytes.length * 8) >>> 0)

  const w = new Uint32Array(64)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const a15 = w[i - 15]
      const a2 = w[i - 2]
      const s0 = rotr(a15, 7) ^ rotr(a15, 18) ^ (a15 >>> 3)
      const s1 = rotr(a2, 17) ^ rotr(a2, 19) ^ (a2 >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h[0]
    let b = h[1]
    let c = h[2]
    let d = h[3]
    let e = h[4]
    let f = h[5]
    let g = h[6]
    let hh = h[7]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0
  }
  const out = new Uint8Array(32)
  const odv = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i])
  return out
}

/** Concatenate two byte arrays. */
function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** HMAC-SHA256. */
function hmacSha256(key, message) {
  const k = key.length > 64 ? sha256(key) : key
  const ipad = new Uint8Array(64)
  const opad = new Uint8Array(64)
  for (let i = 0; i < 64; i++) {
    const b = i < k.length ? k[i] : 0
    ipad[i] = b ^ 0x36
    opad[i] = b ^ 0x5c
  }
  return sha256(concatBytes(opad, sha256(concatBytes(ipad, message))))
}

/** PBKDF2-HMAC-SHA256. */
function pbkdf2Sha256(password, salt, iterations, keyLen) {
  const blocks = Math.ceil(keyLen / 32)
  const out = new Uint8Array(blocks * 32)
  for (let block = 1; block <= blocks; block++) {
    const counter = new Uint8Array([(block >>> 24) & 0xff, (block >>> 16) & 0xff, (block >>> 8) & 0xff, block & 0xff])
    let u = hmacSha256(password, concatBytes(salt, counter))
    const acc = u.slice()
    for (let i = 1; i < iterations; i++) {
      u = hmacSha256(password, u)
      for (let j = 0; j < 32; j++) acc[j] ^= u[j]
    }
    out.set(acc, (block - 1) * 32)
  }
  return out.slice(0, keyLen)
}

/** Derive a PBKDF2-SHA256 hash of `password` with the given salt/iterations. */
async function derive(password, salt, iterations) {
  const bytes = new TextEncoder().encode(password)
  if (globalThis.crypto?.subtle) {
    const key = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256)
    return new Uint8Array(bits)
  }
  // No SubtleCrypto in this context — hash with the local implementation.
  return pbkdf2Sha256(bytes, salt, iterations, 32)
}

/** Hash a password into the versioned storage format. */
export async function hashPassword(password) {
  const salt = randomBytes(16)
  const bits = await derive(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(bits)}`
}

/** Compare in constant time so we don't leak hash prefixes via timing. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Verify a password against a stored hash.
 * Returns { ok, needsRehash } so callers can transparently upgrade legacy hashes.
 */
export async function verifyPassword(password, stored) {
  if (!stored || !password) return { ok: false, needsRehash: false }
  if (stored.startsWith('pbkdf2$')) {
    const [, , iterStr, saltB64, bitsB64] = stored.split('$')
    const iterations = Number(iterStr) || PBKDF2_ITERATIONS
    try {
      const bits = await derive(password, fromB64(saltB64), iterations)
      return { ok: timingSafeEqual(toB64(bits), bitsB64), needsRehash: iterations !== PBKDF2_ITERATIONS }
    } catch { return { ok: false, needsRehash: false } }
  }
  // Legacy DJB2 hash from earlier builds — verify then flag for upgrade.
  return { ok: timingSafeEqual(legacyHash(password), stored), needsRehash: true }
}

/**
 * The value sent to the server instead of a password: the same PBKDF2 stretch as
 * a local account, but salted by the address, so the same password yields the
 * same value on every device while two accounts never share a hash.
 *
 * The password itself never leaves the browser, and the server adds its own
 * keyed layer (`hashPassword` in api/_lib.js), so a leaked record is not a usable
 * credential. The server requires this shape and at least 100,000 iterations, so
 * it cannot be talked into storing something cheap.
 */
export async function wireCredential(email, password) {
  const salt = sha256(new TextEncoder().encode(String(email || '').trim().toLowerCase()))
  const bits = await derive(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(bits)}`
}

// ─── Storage ─────────────────────────────────────────────────────────────────

/** JSON.parse that never throws — a corrupted store must not brick the app. */
function safeParse(raw, fallback) {
  if (!raw) return fallback
  try { return JSON.parse(raw) } catch { return fallback }
}

function loadAnalytics() { return safeParse(ls().getItem(ANALYTICS_KEY), { events: [] }) }
function saveAnalytics(a) { ls().setItem(ANALYTICS_KEY, JSON.stringify(a)) }

function saveDB(db) { ls().setItem(DB_KEY, JSON.stringify(db)) }

/**
 * Keep every user keyed by its own id and every collection present. Older
 * builds keyed the seeded Admin by its identifier, which made sessions fail to
 * resolve — this repairs any database written by those builds.
 */
function normalize(db) {
  db.users = db.users || {}
  db.floorplans = db.floorplans || {}
  db.billing = db.billing || {}
  db.oauth = db.oauth || {}
  db.analytics = db.analytics || loadAnalytics()
  for (const key of Object.keys(db.users)) {
    const u = db.users[key]
    if (!u) { delete db.users[key]; continue }
    if (!u.id) u.id = key
    if (key !== u.id) { db.users[u.id] = u; delete db.users[key] }
    // The seeded super-user predates the email field in older builds.
    if (u.isAdmin && !u.email) u.email = 'admin@mapmycams.dev'
    // Accounts that predate email verification carry no flag. Treat them as
    // already proven so the upgrade cannot lock anyone out; only new signups
    // (which set the flag explicitly) have to confirm their address.
    if (u.emailVerified === undefined) u.emailVerified = true
  }
  return db
}

function loadDB() {
  const db = safeParse(ls().getItem(DB_KEY), null)
  if (db && db.users) {
    // Repair and persist any database written by an older build.
    const before = JSON.stringify(db)
    normalize(db)
    if (JSON.stringify(db) !== before) saveDB(db)
    return db
  }
  // Seed the Admin super-user (full access to everything) and empty collections.
  // The seed keeps a legacy hash; the first successful sign-in upgrades it to PBKDF2.
  const seeded = normalize({
    users: {
      u_admin: {
        id: 'u_admin', identifier: 'Admin', email: 'admin@mapmycams.dev', name: 'Administrator',
        isAdmin: true, passHash: legacyHash(SEED_ADMIN_PASSWORD),
        plan: 'premium_yearly', addons: ['ai_pack', 'pdf_report', 'family', 'brands'],
        twoFA: false, emailVerified: true, createdAt: new Date().toISOString(),
      },
    },
    floorplans: {}, billing: {}, oauth: {}, analytics: loadAnalytics(),
  })
  saveDB(seeded)
  return seeded
}

/** Find an account by email, username or name (case-insensitive). */
function findUser(db, identifier) {
  const needle = String(identifier || '').trim().toLowerCase()
  if (!needle) return null
  if (db.users[needle]) return db.users[needle]
  return Object.values(db.users).find((u) => (
    String(u.identifier || '').toLowerCase() === needle ||
    String(u.email || '').toLowerCase() === needle ||
    String(u.name || '').toLowerCase() === needle
  )) || null
}

function publicUser(u) {
  if (!u) return null
  // Never hand the password hash or the pending verification code to callers.
  const { passHash, verification, ...rest } = u
  return rest
}

// ─── Sessions (random token + expiry, never a bare user id) ───────────────────

function startSession(userId) {
  const session = { token: toB64(randomBytes(32)), userId, expires: Date.now() + SESSION_DAYS * 86400000 }
  ls().setItem(SESSION_KEY, JSON.stringify(session))
  return session
}

function clearSession() { ls().removeItem(SESSION_KEY) }

// ─── Server session ──────────────────────────────────────────────────────────
// The account service issues a signed token; keeping it beside the local session
// is what keeps a signed-in user signed in across reloads — and, because the
// account lives on the server, on another device too.

function serverToken() { return ls().getItem(TOKEN_KEY) }
function setServerToken(token) { if (token) ls().setItem(TOKEN_KEY, token); else ls().removeItem(TOKEN_KEY) }

function readSession() {
  const raw = ls().getItem(SESSION_KEY)
  if (!raw) return null
  // Legacy sessions stored a plain user id — accept once, then upgrade.
  if (!raw.startsWith('{')) {
    const db = loadDB()
    if (db.users[raw]) { startSession(raw); return { userId: raw } }
    clearSession()
    return null
  }
  try {
    const s = JSON.parse(raw)
    if (!s.userId || !s.expires || s.expires < Date.now()) { clearSession(); return null }
    return s
  } catch { clearSession(); return null }
}

function sessionUser() {
  const s = readSession()
  if (!s) return null
  const db = loadDB()
  const user = db.users[s.userId]
  if (!user) { clearSession(); return null }
  // A surviving session for an unverified account must not unlock the app.
  if (!user.emailVerified) { clearSession(); return null }
  return user
}

// ─── Analytics ───────────────────────────────────────────────────────────────

/** Track a product/monetisation analytics event (conversion, feature use, drop-off). */
export function track(event, props = {}) {
  try {
    const a = loadAnalytics()
    a.events.push({ event, props, t: new Date().toISOString() })
    if (a.events.length > 2000) a.events = a.events.slice(-1000)
    saveAnalytics(a)
  } catch { /* analytics must never break the app */ }
  if (API_URL) {
    fetch(`${API_URL}/analytics`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, props }),
    }).catch(() => {})
  }
}

// ─── Live backend calls (used only when VITE_API_URL is set) ─────────────────

/** Headers for a server call, carrying the session token when there is one. */
function serverHeaders() {
  const token = serverToken()
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

async function api(path, body, method = 'POST') {
  // Only talk to the server once it has issued a session. Before that the local
  // store is authoritative, which is what keeps the app fully usable when it is
  // not deployed anywhere.
  if (!serverToken()) throw new Error('demo')
  const res = await fetch(`${API_URL}${path}`, {
    method, headers: serverHeaders(), body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return res.json()
}

/**
 * POST that returns the parsed body even on 4xx. The auth endpoints answer 403
 * with `pendingVerification`, and api() would flatten that into a plain error.
 *
 * `server` reports whether a JSON API answered at all. A 404 or an HTML reply
 * means nothing is serving the API on this origin — the Vite dev server in the
 * sandbox preview, or any static-only host — which is the signal to use the
 * local account store rather than showing the user an error.
 */
async function apiRaw(path, body) {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST', headers: serverHeaders(), body: body ? JSON.stringify(body) : undefined,
    })
    const type = res.headers.get('content-type') || ''
    if (!type.includes('application/json')) return { server: false, ok: false, status: res.status, data: {} }
    return { server: true, ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) }
  } catch (err) {
    return { server: false, ok: false, status: 0, data: { error: err.message } }
  }
}

// ─── Verification email delivery ─────────────────────────────────────────────

/**
 * Ask the server to email the code. The key stays server-side either way.
 *
 * Never throws and never blocks signup: if the mailer is not deployed or not
 * configured yet, the caller shows the code on screen instead of failing.
 * Returns { sent: true } or { sent: false, deliveryError }.
 */
async function requestVerificationEmail(email, code, name = '') {
  try {
    const res = await fetch(MAILER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, name }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.sent) return { sent: true }
    return { sent: false, deliveryError: data.error || `Mailer responded ${res.status}` }
  } catch (err) {
    return { sent: false, deliveryError: err.message }
  }
}

// ─── Auth (email + password) ─────────────────────────────────────────────────
// Google / Apple / Microsoft sign-in is deliberately disabled for now: it needs
// a Supabase project plus OAuth apps registered with each vendor, neither of
// which can be done from here. The complete implementation is parked in
// docs/oauth-integration.md and nothing below depends on it.
//
// Password storage: a password is never written anywhere. It is stretched with
// PBKDF2-SHA256 (210,000 iterations) and a fresh 16-byte random salt per
// account, stored as pbkdf2$sha256$<iterations>$<saltB64>$<derivedB64>.
// Verification is constant-time and legacy hashes are upgraded on next login.

/** Repeated-failure throttling, so the form can't be brute-forced. */
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000

/** Validate a password for new signups and return a human-readable error. */
function passwordProblem(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters'
  if (!/[A-Za-z]/.test(password)) return 'Password must contain at least one letter'
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number'
  return null
}

/** Minutes left on a lockout for this key, or 0 when not locked. */
function lockoutMinutes(db, key) {
  const rec = db.throttle?.[key]
  if (!rec?.lockedUntil || rec.lockedUntil <= Date.now()) return 0
  return Math.max(1, Math.ceil((rec.lockedUntil - Date.now()) / 60000))
}

function recordFailure(db, key) {
  db.throttle = db.throttle || {}
  const rec = db.throttle[key] || { count: 0, lockedUntil: 0 }
  rec.count += 1
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS
    rec.count = 0
  }
  db.throttle[key] = rec
  saveDB(db)
}

function clearFailures(db, key) {
  if (db.throttle?.[key]) { delete db.throttle[key]; saveDB(db) }
}

/** Sign in with email or username + password. */
export async function login(identifier, password) {
  track('login_attempt', { identifier })
  const id = String(identifier || '').trim().toLowerCase()
  if (!id || !password) throw new Error('Enter your email and password')

  // The server is asked first: an account that lives there works on any device,
  // and its plan and add-ons come from the account rather than this browser.
  const live = await apiRaw('/auth/login', { identifier: id, credential: await wireCredential(id, password) })
  if (live.server) {
    // An unverified account comes back as 403 + pendingVerification.
    if (live.data.pendingVerification) {
      setPending(live.data.email || id)
      return { pendingVerification: true, email: live.data.email || id }
    }
    if (live.ok) {
      setServerToken(live.data.token)
      track('login_success', { identifier: id, server: true })
      return live.data.user
    }
    // The server doesn't know this account — but one created here before the
    // server existed, or on a host that has none, is still valid in this browser.
    // A wrong password fails both ways, so this cannot sign anyone in falsely.
    const local = await loginLocally(id, password).catch(() => null)
    if (local) return local
    throw new Error(live.data.error || 'Invalid email/username or password')
  }

  return loginLocally(id, password)
}

/** Sign in against the accounts stored in this browser (no server involved). */
async function loginLocally(id, password) {
  const db = loadDB()
  const user = findUser(db, id)
  // Throttle by account id when the account exists, so switching between
  // "Admin" and the admin email can't sidestep the counter.
  const key = user ? user.id : 'id:' + id

  const locked = lockoutMinutes(db, key)
  if (locked) throw new Error(`Too many failed attempts. Try again in ${locked} minute${locked === 1 ? '' : 's'}.`)

  // Identical message for "no such account" and "wrong password", so the form
  // never reveals whether an address is registered.
  // Identical message for "no such account" and "wrong password" — unless this
  // browser cannot store anything, in which case say so: the account the user
  // just created was never written and the generic message would be a lie.
  const invalid = new Error(storageIsDurable()
    ? 'Invalid email/username or password'
    : 'Invalid email/username or password. Note: this browser is blocking local storage, so accounts created here are not kept — open the preview in its own browser tab and create the account again.')
  if (!user) { recordFailure(db, key); throw invalid }

  const { ok, needsRehash } = await verifyPassword(password, user.passHash)
  if (!ok) { recordFailure(db, key); throw invalid }

  clearFailures(db, key)
  // Transparently upgrade a hash written by an older build.
  if (needsRehash) {
    user.passHash = await hashPassword(password)
    saveDB(db)
  }
  // Right password, but the address is still unproven: send the caller to the
  // code screen rather than letting them into the planner.
  if (!user.emailVerified) {
    setPending(user.email)
    track('login_blocked_unverified', { identifier: user.identifier })
    return { pendingVerification: true, email: user.email }
  }
  startSession(user.id)
  track('login_success', { identifier: user.identifier })
  return publicUser(user)
}

/**
 * Create an account. This does NOT sign anyone in: the account starts unverified
 * and a 6-digit code is sent to the address. The session is only issued once
 * verifyEmail() accepts that code, so the planner stays locked until then.
 *
 * Returns { pendingVerification: true, email }, plus `devCode` when no email
 * provider is connected (see docs on RESEND_API_KEY).
 */
export async function signup(email, password, name = '') {
  const id = String(email || '').trim().toLowerCase()
  if (!id || !/^\S+@\S+\.\S+$/.test(id)) throw new Error('Enter a valid email address')
  const problem = passwordProblem(password)
  if (problem) throw new Error(problem)

  const live = await apiRaw('/auth/signup', { email: id, credential: await wireCredential(id, password), name })
  if (live.server) {
    if (!live.ok) throw new Error(live.data.error || 'Could not create the account')
    setPending(id)
    track('signup_started', { identifier: id })
    return { ...live.data, email: id }
  }

  const db = loadDB()
  // Re-signing up with an address that is only half-registered replaces that
  // attempt rather than creating a second account for it.
  const existing = Object.values(db.users).find((u) => String(u.email || '').toLowerCase() === id)
  if (existing?.emailVerified) throw new Error('An account with that email already exists')
  const user = existing || {
    id: 'u_' + toB64(randomBytes(9)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12),
    identifier: id,
    email: id,
    name: name || id.split('@')[0],
    isAdmin: false,
    plan: 'free', addons: [], twoFA: false, createdAt: new Date().toISOString(),
  }
  user.passHash = await hashPassword(password)
  if (name) user.name = name
  user.emailVerified = false
  db.users[user.id] = user
  const code = await issueCode(user, db)
  setPending(id)
  track('signup_started', { identifier: id })
  // Hand the code to the mailer. If that isn't available the code comes back so
  // the flow is still completable, with the reason shown on the code screen.
  const delivery = await requestVerificationEmail(id, code, user.name)
  return {
    pendingVerification: true, email: id, sent: delivery.sent,
    deliveryError: delivery.deliveryError,
    devCode: delivery.sent ? undefined : code,
  }
}

// ─── Email verification ──────────────────────────────────────────────────────
// A code is stored only as a PBKDF2 hash (never in the clear), expires after 10
// minutes, and is limited to 5 wrong guesses — the same policy api/_lib.js
// applies server-side.

/** A random 6-digit code; rejection-sampled so every value is equally likely. */
function generateCode() {
  const limit = Math.floor(0x100000000 / 1000000) * 1000000
  const buf = new Uint32Array(1)
  let n
  do { crypto.getRandomValues(buf); n = buf[0] } while (n >= limit)
  return String(n % 1000000).padStart(6, '0')
}

/** Remember which address is mid-verification, so a reload keeps the code screen. */
function setPending(email) { ls().setItem(PENDING_KEY, JSON.stringify({ email, at: Date.now() })) }

/** The address awaiting a code, or null. */
export function pendingVerification() { return safeParse(ls().getItem(PENDING_KEY), null) }

/** Abandon verification ("use a different email"). */
export function cancelPendingVerification() { ls().removeItem(PENDING_KEY) }

/** Store a fresh code hash + expiry on the row. Returns the plaintext code. */
async function issueCode(user, db) {
  const code = generateCode()
  user.emailVerified = false
  user.verification = {
    codeHash: await hashPassword(code),
    expires: Date.now() + CODE_TTL_MS,
    attempts: 0,
    sentAt: Date.now(),
  }
  saveDB(db)
  return code
}

/**
 * Enter the code sent to the address. This is the only thing that turns a new
 * account into a session — until it succeeds the planner cannot be reached.
 */
export async function verifyEmail(email, code) {
  const id = String(email || '').trim().toLowerCase()
  const clean = String(code || '').trim()
  if (!/^\d{6}$/.test(clean)) throw new Error('Enter the 6-digit code from the email')

  const live = await apiRaw('/auth/verify', { email: id, code: clean })
  if (live.server) {
    if (!live.ok) throw new Error(live.data.error || 'That code is not correct')
    setServerToken(live.data.token)
    cancelPendingVerification()
    track('email_verified', { identifier: id })
    return live.data.user
  }

  const db = loadDB()
  const user = findUser(db, id)
  if (!user) throw new Error('No account is awaiting verification for that address')
  if (user.emailVerified) { startSession(user.id); cancelPendingVerification(); return publicUser(user) }

  const v = user.verification
  if (!v) throw new Error('That code is no longer valid — request a new one')
  if (v.expires < Date.now()) throw new Error('That code has expired — request a new one')
  if (v.attempts >= CODE_MAX_ATTEMPTS) throw new Error('Too many incorrect codes — request a new one')

  const { ok } = await verifyPassword(clean, v.codeHash)
  if (!ok) {
    v.attempts += 1
    saveDB(db)
    const left = CODE_MAX_ATTEMPTS - v.attempts
    if (left <= 0) throw new Error('Too many incorrect codes — request a new one')
    throw new Error(`That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`)
  }

  user.emailVerified = true
  delete user.verification
  saveDB(db)
  startSession(user.id)
  cancelPendingVerification()
  track('email_verified', { identifier: user.identifier })
  return publicUser(user)
}

/** Send a replacement code. Rate-limited so it cannot be used to spam an inbox. */
export async function resendCode(email) {
  const id = String(email || '').trim().toLowerCase()

  const live = await apiRaw('/auth/resend', { email: id })
  if (live.server) {
    if (!live.ok) throw new Error(live.data.error || 'Could not send another code')
    setPending(id)
    return { ...live.data, email: id }
  }

  const db = loadDB()
  const user = findUser(db, id)
  if (!user) throw new Error('No account is awaiting verification for that address')
  if (user.emailVerified) throw new Error('That account is already verified')
  const waitMs = RESEND_COOLDOWN_MS - (Date.now() - (user.verification?.sentAt || 0))
  if (waitMs > 0) throw new Error(`Please wait ${Math.ceil(waitMs / 1000)}s before requesting another code`)
  const code = await issueCode(user, db)
  track('verification_resent', { identifier: id })
  const delivery = await requestVerificationEmail(id, code, user.name)
  return {
    pendingVerification: true, email: id, sent: delivery.sent,
    deliveryError: delivery.deliveryError,
    devCode: delivery.sent ? undefined : code,
  }
}

export async function logout() {
  try { await api('/auth/logout', {}) } catch { /* local mode */ }
  setServerToken(null)
  clearSession()
  track('logout', {})
}

export async function getMe() {
  if (serverToken()) {
    try {
      const u = await api('/me', null, 'GET')
      if (u) return u
    } catch (err) {
      // A 401 means the session is over, so drop it. Anything else (offline, a
      // 5xx) leaves the token alone, so a flaky network cannot sign anyone out.
      if (/Unauthorised/i.test(err.message)) setServerToken(null)
      else return null
    }
  }
  return publicUser(sessionUser())
}

// ─── Billing ─────────────────────────────────────────────────────────────────

/**
 * The signed-in user's invoice history. Real invoices come from Stripe when the
 * account has a customer there; otherwise the local demo store answers.
 */
export async function getBilling() {
  const user = sessionUser()
  if (!user) return []
  try {
    const res = await api('/billing/invoices', {})
    if (Array.isArray(res?.invoices)) return res.invoices
  } catch (e) { if (e.message !== 'demo') throw e }
  return loadDB().billing[user.id] || []
}

/**
 * Hand the browser to Stripe's own page (checkout or the billing portal) and
 * prepare for it to come back. Returns true when a navigation was started, so
 * callers know the entitlement has not been granted yet.
 */
function goToStripe(url) {
  if (!url || typeof window === 'undefined') return false
  window.location.assign(url)
  return true
}

/**
 * Is there a JSON API on this origin?
 *
 * The sandbox preview and any static-only host have none, and the answer decides
 * whether a purchase can actually be charged for. Probed once per page load: the
 * request is unauthenticated, so an API answers `401` with JSON and a host with
 * no API answers with HTML (or nothing at all).
 */
let apiProbe = null
export function apiAvailable() {
  if (apiProbe === null) {
    apiProbe = fetch(`${API_URL}/me`, { headers: serverHeaders() })
      .then((res) => (res.headers.get('content-type') || '').includes('application/json'))
      .catch(() => false)
  }
  return apiProbe
}

/** Unlock something in this browser alone — the demo path, when nothing can charge. */
function grantLocally(itemKey, kind) {
  const user = sessionUser()
  if (!user) throw new Error('Sign in first')
  const db = loadDB()
  const u = db.users[user.id]
  db.billing[user.id] = db.billing[user.id] || []
  if (kind === 'addon') {
    u.addons = [...new Set([...(u.addons || []), itemKey])]
    db.billing[user.id].unshift({ id: 'inv_' + Date.now(), item: itemKey, kind: 'addon', amount: itemKey, date: new Date().toISOString(), status: 'paid' })
  } else {
    u.plan = itemKey
    db.billing[user.id].unshift({ id: 'sub_' + Date.now(), item: itemKey, kind: 'subscription', amount: itemKey, date: new Date().toISOString(), status: 'active' })
  }
  saveDB(db)
  track('checkout_completed', { item: itemKey, kind, demo: true })
  return { demo: true, user: publicUser(u) }
}

/**
 * Start a Stripe checkout (subscription plan or one-time add-on).
 *
 * Every outcome is reported back to the caller — redirecting, demo, or a thrown
 * error with something the customer can act on. A button that quietly does
 * nothing is indistinguishable from a broken one, which is exactly how this
 * behaved when a purchase could not be charged for.
 */
export async function startCheckout(itemKey, kind = 'plan') {
  track('checkout_started', { item: itemKey, kind })

  // No server session. Either this host has no API at all (the preview, a static
  // host), or the account is one of this browser's own — signed in locally, with
  // no account on the server for a payment to belong to. Buying is only possible
  // for the second case by verifying the address first, so say so rather than
  // unlocking something the server will never know about.
  if (!serverToken()) {
    if (await apiAvailable()) {
      // The server can charge a card, but only for an account it knows about, and
      // this browser's account predates that. Rather than a dead end, hand the
      // caller something it can act on: the account gate creates and verifies the
      // account, then resumes this exact purchase. `needsAccount` is the flag the
      // UI switches on, so the message can change without breaking the flow.
      const err = new Error('Confirm your email address to pay — the 6-digit code proves the account is yours, and the plan then follows you to any device.')
      err.needsAccount = true
      err.email = sessionUser()?.email || ''
      err.item = itemKey
      err.kind = kind
      throw err
    }
    return grantLocally(itemKey, kind)
  }

  // Real mode: the server creates a Stripe Checkout Session and the browser pays
  // on Stripe's own page. Nothing is unlocked until the payment completes and the
  // app confirms it on the way back (see confirmCheckout).
  const res = await api('/billing/checkout', { item: itemKey, kind })
  if (res?.url) {
    track('checkout_redirected', { item: itemKey, kind, checkout: true })
    return { redirecting: goToStripe(res.url), url: res.url }
  }
  if (res?.demo) {
    // The server is reachable but has no Stripe keys, so it granted the plan
    // itself. Report that rather than leaving the page looking untouched.
    return { demo: true, server: true, user: res.user || await getMe() }
  }
  throw new Error('Stripe did not return a checkout page — please try again')
}

/**
 * Apply a purchase on returning from Stripe. The webhook does this too, but it is
 * asynchronous, so asking about the session we were handed makes the new plan
 * visible immediately instead of a minute later.
 * Returns `{ user }` once applied, `{ pending: true }` while Stripe still calls it
 * unpaid, and `{ demo: true }` when there is no Stripe behind the app.
 */
export async function confirmCheckout(sessionId) {
  try { return await api('/billing/confirm', { sessionId }) } catch (e) { if (e.message !== 'demo') throw e }
  return { demo: true }
}

export async function openBillingPortal() {
  try {
    const res = await api('/billing/portal', {})
    if (res?.url) { goToStripe(res.url); return { redirecting: true } }
    return res
  } catch (e) { if (e.message !== 'demo') throw e }
  track('billing_portal_demo', {})
  return { demo: true }
}

export async function cancelSubscription() {
  try { return await api('/billing/cancel', {}) } catch (e) { if (e.message !== 'demo') throw e }
  const user = sessionUser()
  const db = loadDB()
  db.users[user.id].plan = 'free'
  const b = db.billing[user.id]
  if (b && b[0]) b[0].status = 'canceled'
  saveDB(db)
  track('subscription_canceled', {})
  return publicUser(db.users[user.id])
}

export async function toggle2FA() {
  const user = sessionUser()
  if (!user) return null
  const db = loadDB()
  db.users[user.id].twoFA = !db.users[user.id].twoFA
  saveDB(db)
  return db.users[user.id].twoFA
}

// ─── Floorplans ──────────────────────────────────────────────────────────────
// Written to the browser always, and to the account as well once the server has
// issued a session, so a layout follows the user to another device. Reads merge
// the two lists and de-duplicate by id, which means a plan drawn before signing
// in — or while offline, or on a host with no server — can never disappear.

/** Plans held in this browser, scoped to a local account when one is signed in. */
function localFloorplans() {
  const user = sessionUser()
  const all = safeParse(ls().getItem(FLOORS_KEY), {})
  return Object.values(all).filter((f) => !user || !f.owner || f.owner === user.id)
}

function writeLocalPlan(plan) {
  const all = safeParse(ls().getItem(FLOORS_KEY), {})
  all[plan.id] = plan
  ls().setItem(FLOORS_KEY, JSON.stringify(all))
}

export async function listFloorplans() {
  const local = localFloorplans()
  if (!serverToken()) return local.sort((a, b) => b.updated - a.updated)
  try {
    const remote = await api('/floorplans', null, 'GET')
    const byId = new Map(local.map((f) => [f.id, f]))
    for (const row of remote) byId.set(row.id, row)
    return [...byId.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0))
  } catch { return local }
}

export async function saveFloorplan(name, data, id = null) {
  track('floorplan_saved', { id })
  const user = sessionUser()
  const plan = { id: id || 'fp_' + Date.now(), owner: user ? user.id : null, name, data, updated: Date.now() }
  // The browser copy is written first: a plan is never lost to a failed request.
  writeLocalPlan(plan)
  if (serverToken()) {
    try {
      const row = await api('/floorplans', { id: plan.id, name, data })
      writeLocalPlan({ ...plan, ...row })
      return row
    } catch { /* the local copy already holds it */ }
  }
  return plan
}

export async function deleteFloorplan(id) {
  if (serverToken()) {
    try { await api(`/floorplans/${id}`, null, 'DELETE') } catch { /* not on the server */ }
  }
  const all = safeParse(ls().getItem(FLOORS_KEY), {})
  delete all[id]
  ls().setItem(FLOORS_KEY, JSON.stringify(all))
}

// ─── Admin operations ────────────────────────────────────────────────────────

export async function adminListUsers() {
  try { return await api('/admin/users', null, 'GET') } catch (e) { if (e.message !== 'demo') throw e }
  return Object.values(loadDB().users).map(publicUser)
}

export async function adminSetPlan(userId, plan) {
  try { return await api('/admin/set-plan', { userId, plan }) } catch (e) { if (e.message !== 'demo') throw e }
  const db = loadDB()
  if (db.users[userId]) { db.users[userId].plan = plan; saveDB(db) }
  return publicUser(db.users[userId])
}

export async function adminSetFlag(flag, enabled) {
  try { return await api('/admin/flag', { flag, enabled }) } catch (e) { if (e.message !== 'demo') throw e }
  const flags = JSON.parse(ls().getItem('mmc_flags') || '{}')
  flags[flag] = enabled
  ls().setItem('mmc_flags', JSON.stringify(flags))
  return flags
}

export function getFlags() {
  try { return JSON.parse(ls().getItem('mmc_flags') || '{}') } catch { return {} }
}

export function getAnalyticsSnapshot() {
  const a = loadAnalytics()
  const byEvent = {}
  for (const e of a.events) byEvent[e.event] = (byEvent[e.event] || 0) + 1
  const checkouts = byEvent.checkout_started || 0
  const completions = byEvent.checkout_completed || 0
  return {
    total: a.events.length,
    byEvent,
    conversion: checkouts ? Math.round((completions / checkouts) * 100) : 0,
    triggers: byEvent.upsell_shown || 0,
  }
}
