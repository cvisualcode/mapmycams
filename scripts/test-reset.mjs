// ─── Password reset test ─────────────────────────────────────────────────────
// A forgotten password used to be the end of an account — and of anything bought on
// it. This drives the whole flow the way the live site does: the browser module
// (src/monetisation/api.js) talking to the real Worker handler (api/index.js) over a
// stubbed fetch, with accounts in a memory KV and Resend catching the mail so the
// emailed code can be read back out.
//
//   bun run reset:test
//
// It covers the things that would matter if this were wrong: the account must not be
// touched before the code comes back, a wrong code must not work, a code must not be
// usable twice, an address with no account must be answered exactly like one with an
// account, the old password must stop working, and a session issued before the reset
// must be refused afterwards.

// The browser module reads window.localStorage as it is imported, so the globals have
// to exist first.
const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
  },
  location: { href: 'https://mapmycams.dev/' },
}
globalThis.crypto ??= (await import('node:crypto')).webcrypto
globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary')

// ── A stand-in for the KV namespace, so accounts really are written and read ──
function memoryKV() {
  const map = new Map()
  return {
    map,
    async get(key, type) {
      const raw = map.get(key)
      if (raw === undefined) return null
      return type === 'json' ? JSON.parse(raw) : raw
    },
    async put(key, value) { map.set(key, value) },
    async delete(key) { map.delete(key) },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name }))
      return { keys, list_complete: true }
    },
  }
}

const kv = memoryKV()
const env = {
  AUTH_SECRET: 'smoke-test-secret-0123456789-abcdefghijkl',
  MAPMYCAMS_STORE: kv,
  APP_URL: 'https://mapmycams.dev',
  RESEND_API_KEY: 're_test_key',
  EMAIL_FROM: 'MapMyCams <no-reply@mapmycams.dev>',
}

// ── The network: Resend catches the mail, everything else is the real handler ──
// Each request is given its own client address, because the reset route is rate
// limited per IP — the limiter has its own check further down, and this flow should
// not trip over it.
const outbox = []
let requestCount = 0
let fixedIp = null
globalThis.fetch = async (url, init = {}) => {
  const full = String(url)
  if (full.startsWith('https://api.resend.com/')) {
    outbox.push(JSON.parse(init.body || '{}'))
    return new Response(JSON.stringify({ id: `email_${outbox.length}` }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }
  requestCount += 1
  const headers = new Headers(init.headers || {})
  headers.set('CF-Connecting-IP', fixedIp || `10.0.0.${(requestCount % 200) + 1}`)
  const absolute = new URL(full, 'https://mapmycams.dev').toString()
  return handle(new Request(absolute, { ...init, headers }), env)
}

const { handle } = await import('../api/index.js')
const api = await import('../src/monetisation/api.js')

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

/** The 6-digit code out of the most recent email. */
function latestCode() {
  const email = outbox[outbox.length - 1]
  const match = `${email?.text || ''}`.match(/\b(\d{6})\b/)
  return match ? match[1] : null
}

/** The account record as the server has it. */
function stored(email) {
  return JSON.parse(kv.map.get(`user:${email}`))
}

/** Test-only surgery on the record: the cooldown would otherwise block the next send. */
function patch(email, fields) {
  kv.map.set(`user:${email}`, JSON.stringify({ ...stored(email), ...fields }))
}

/** Ask for a reset as though the last one were long enough ago to be allowed again. */
function requestFreshReset(email) {
  patch(email, { reset_sent_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() })
  return api.requestPasswordReset(email)
}

/** One request straight at the handler, as the browser would make it. */
async function call(path, { method = 'GET', body, token, ip } = {}) {
  const res = await handle(new Request(`https://mapmycams.dev${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(ip ? { 'CF-Connecting-IP': ip } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
  return { status: res.status, data: await res.json().catch(() => null) }
}

const ACCOUNT = 'sam@example.com'
const OLD_PASSWORD = 'oldpass123'
const NEW_PASSWORD = 'newpass456'

console.log('\nAn account with a verified address')
await api.signup(ACCOUNT, OLD_PASSWORD, 'Sam')
{
  const signupCode = latestCode()
  check('signing up emails a 6-digit code', /^\d{6}$/.test(signupCode || ''), String(signupCode))
  const user = await api.verifyEmail(ACCOUNT, signupCode)
  check('the code verifies the account', user?.email === ACCOUNT && user.emailVerified === true)
}
await api.logout()
{
  const user = await api.login(ACCOUNT, OLD_PASSWORD)
  check('the original password signs in', user?.email === ACCOUNT)
}
const tokenBeforeReset = store.get('mmc_token_v1')
check('and the session token is kept', typeof tokenBeforeReset === 'string' && tokenBeforeReset.length > 20)

console.log('\nAsking for a reset')
{
  const before = stored(ACCOUNT)
  const res = await api.requestPasswordReset(ACCOUNT)
  check('the request is accepted', res?.ok === true)
  check('the email is a reset, not a verification', /reset/i.test(outbox[outbox.length - 1].subject), outbox[outbox.length - 1].subject)
  check('and carries a 6-digit code', /^\d{6}$/.test(latestCode() || ''))
  const after = stored(ACCOUNT)
  check('the password is untouched until the code comes back', after.password_hash === before.password_hash)
  check('the address in the email is the account', outbox[outbox.length - 1].to[0] === ACCOUNT)
  const login = await call('/auth/login', {
    method: 'POST', body: { identifier: ACCOUNT, credential: await api.wireCredential(ACCOUNT, OLD_PASSWORD) },
  })
  check('the old password still works at this point', login.status === 200, `status ${login.status}`)
}

console.log('\nAn address with no account looks the same')
{
  const known = await api.requestPasswordReset(ACCOUNT)
  const unknown = await api.requestPasswordReset('nobody@example.com')
  check('both are accepted', known?.ok === true && unknown?.ok === true)
  check('the replies have exactly the same fields', JSON.stringify(Object.keys(known).sort()) === JSON.stringify(Object.keys(unknown).sort()), `known=${Object.keys(known).join(',')} unknown=${Object.keys(unknown).join(',')}`)
  check('and say the same thing', known.sent === unknown.sent && known.email !== unknown.email)
  const raw = await call('/auth/reset-request', { method: 'POST', body: { email: 'nobody@example.com' } })
  check('a request for an unknown address is accepted directly too', raw.status === 200 && raw.data?.sent === true)
  check('and no email is sent for it', outbox.filter((m) => m.to?.includes('nobody@example.com')).length === 0)
  const bad = await call('/auth/reset-request', { method: 'POST', body: { email: 'not-an-email' } })
  check('a malformed address is rejected', bad.status === 400)
}

console.log('\nA wrong code')
{
  const wrong = latestCode() === '000000' ? '111111' : '000000'
  const err = await api.confirmPasswordReset(ACCOUNT, wrong, NEW_PASSWORD).then(() => null, (e) => e)
  check('is refused', !!err, 'a wrong code was accepted')
  check('and says how many tries are left', /attempt/.test(err?.message || ''), err?.message)
  const stillOld = await call('/auth/login', {
    method: 'POST', body: { identifier: ACCOUNT, credential: await api.wireCredential(ACCOUNT, OLD_PASSWORD) },
  })
  check('the old password still signs in', stillOld.status === 200)
}

console.log('\nRunning the attempts out')
{
  for (let i = 0; i < 5; i++) await api.confirmPasswordReset(ACCOUNT, '999999', NEW_PASSWORD).catch(() => {})
  const locked = await api.confirmPasswordReset(ACCOUNT, '999999', NEW_PASSWORD).then(() => null, (e) => e)
  check('the code is locked out', /Too many/i.test(locked?.message || ''), locked?.message)
  const realCode = latestCode()
  const whileLocked = await api.confirmPasswordReset(ACCOUNT, realCode, NEW_PASSWORD).then(() => true, () => false)
  check('even the real code will not work while locked', whileLocked === false)
  check('and the old password still stands', stored(ACCOUNT).password_hash !== undefined)
}

console.log('\nThe real code')
{
  const res = await requestFreshReset(ACCOUNT)
  check('a new code can be requested', res?.ok === true)
  const code = latestCode()
  check('the lockout is reset by a new code', stored(ACCOUNT).reset_attempts === 0)
  const user = await api.confirmPasswordReset(ACCOUNT, code, NEW_PASSWORD)
  check('setting the new password signs the account in', user?.email === ACCOUNT)
  check('and the address is proven', user?.emailVerified === true)
  const after = stored(ACCOUNT)
  check('the reset code is cleared, so it cannot be used twice', after.reset_code_hash === null)
  check('the password version was bumped', (after.password_version || 0) === 1)
  const replay = await call('/auth/reset-confirm', {
    method: 'POST', body: { email: ACCOUNT, code, credential: await api.wireCredential(ACCOUNT, 'thirdpass789') },
  })
  check('replaying the same code is refused', replay.status === 400, `status ${replay.status}`)
}

console.log('\nSessions from before the reset')
{
  const before = await call('/me', { token: tokenBeforeReset })
  check('the old session is refused', before.status === 401, `status ${before.status}`)
  const now = await call('/me', { token: store.get('mmc_token_v1') })
  check('the session the reset created works', now.status === 200 && now.data?.email === ACCOUNT, `status ${now.status}`)
}

console.log('\nAfter a reset')
{
  const newLogin = await api.login(ACCOUNT, NEW_PASSWORD)
  check('the new password signs in', newLogin?.email === ACCOUNT)
  const old = await api.login(ACCOUNT, OLD_PASSWORD).then(() => null, (e) => e)
  check('the old password does not', !!old, 'the old password still worked')
}

console.log('\nA half-registered account (signed up, never verified)')
{
  const other = 'notyet@example.com'
  await api.signup(other, 'firstpass1', 'Not Yet')
  const res = await api.requestPasswordReset(other)
  check('a reset can be asked for', res?.ok === true)
  const user = await api.confirmPasswordReset(other, latestCode(), 'secondpass2')
  check('finishing it also proves the address', user?.emailVerified === true)
  const login = await api.login(other, 'secondpass2')
  check('and the account is usable straight away', login?.email === other)
}

console.log('\nCodes expire')
{
  await api.logout()
  await requestFreshReset(ACCOUNT)
  patch(ACCOUNT, { reset_expires: new Date(Date.now() - 1000).toISOString() })
  const err = await api.confirmPasswordReset(ACCOUNT, latestCode(), 'fourthpass4').then(() => null, (e) => e)
  check('an expired code is refused', /expired/i.test(err?.message || ''), err?.message)
}

console.log('\nThe endpoint is rate limited per address')
{
  fixedIp = '203.0.113.9'
  const codes = []
  for (let i = 0; i < 6; i++) {
    codes.push((await call('/auth/reset-request', { method: 'POST', body: { email: `flood${i}@example.com` }, ip: fixedIp })).status)
  }
  fixedIp = null
  check('the first requests get through', codes.slice(0, 5).every((s) => s === 200), codes.join(','))
  check('and the sixth from one address is refused', codes[5] === 429, codes.join(','))
  check('the limiter does not leak whether the address exists', outbox.filter((m) => m.to?.some?.((t) => t.startsWith('flood'))).length === 0)
}

console.log(failures === 0 ? '\nAll password reset checks passed.\n' : `\n${failures} password reset check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
