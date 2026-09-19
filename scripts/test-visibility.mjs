// ─── Visibility tests ────────────────────────────────────────────────────────
// The funnel counters and the error list exist so that what happens to other people
// is visible at all — the numbers used to live only in the browser of whoever was
// looking, and an error in a stranger's browser was invisible unless they wrote in.
//
//   bun run visibility:test
//
// Checked here: a journey event is counted, an event nobody asked for is not, the
// counting stops at its ceiling, the reporter stores an error and then throttles
// repeats of the same one, an error list cannot grow without bound, and the numbers
// are readable only by an admin.

const store = new Map()
const listeners = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
  },
  location: { pathname: '/', href: 'https://mapmycams.dev/' },
  addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]) },
  removeEventListener() {},
}
globalThis.crypto ??= (await import('node:crypto')).webcrypto
globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary')

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
  AUTH_SECRET: 'visibility-test-secret-0123456789-abcdefgh',
  MAPMYCAMS_STORE: kv,
  APP_URL: 'https://mapmycams.dev',
}

const reports = []
let requestCount = 0
globalThis.fetch = async (url, init = {}) => {
  const full = String(url)
  if (full.startsWith('https://api.resend.com/') || full.startsWith('https://api.stripe.com/')) {
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (full.includes('/report-error')) reports.push(JSON.parse(init.body || '{}'))
  requestCount += 1
  const headers = new Headers(init.headers || {})
  headers.set('CF-Connecting-IP', `198.51.100.${(requestCount % 200) + 1}`)
  return handle(new Request(new URL(full, 'https://mapmycams.dev').toString(), { ...init, headers }), env)
}

const { handle } = await import('../api/index.js')
const { signToken } = await import('../api/_lib.js')
const { installErrorReporting, reportedCount } = await import('../src/monetisation/errors.js')

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

async function call(path, { method = 'POST', body, token, ip } = {}) {
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

const today = new Date().toISOString().slice(0, 10)
const stats = () => JSON.parse(kv.map.get(`stats:${today}`) || '{}')
const errors = () => JSON.parse(kv.map.get('errors:recent') || '{}')

console.log('\nCounting the visitor journey')
{
  const view = await call('/analytics', { body: { event: 'landing_view', props: { section: 'hero' } } })
  check('a home page view is counted', view.status === 200 && view.data.counted === true)
  await call('/analytics', { body: { event: 'landing_view' } })
  await call('/analytics', { body: { event: 'landing_cta' } })
  await call('/analytics', { body: { event: 'checkout_completed' } })
  check('events add up', stats().landing_view === 2 && stats().landing_cta === 1)
  check('a purchase is counted too', stats().checkout_completed === 1)

  const junk = await call('/analytics', { body: { event: 'not_a_real_event' } })
  check('an event nobody asked for is still acknowledged', junk.status === 200 && junk.data.ok === true)
  check('but is not stored', junk.data.counted === false && stats().not_a_real_event === undefined)

  const missing = await call('/analytics', { body: {} })
  check('an event name is required', missing.status === 400)
  const wrongType = await call('/analytics', { body: { event: 42 } })
  check('a non-string name is refused', wrongType.status === 400)
}

console.log('\nThe day\'s counting has a ceiling')
{
  // Fill the day to the ceiling, then check the next event is acknowledged and dropped
  // rather than spending the store.
  const full = { landing_view: 2000 }
  kv.map.set(`stats:${today}`, JSON.stringify(full))
  const past = await call('/analytics', { body: { event: 'landing_view' } })
  check('past the ceiling nothing more is counted', past.data.counted === false && stats().landing_view === 2000)
  kv.map.set(`stats:${today}`, JSON.stringify({ landing_view: 4, landing_cta: 2 }))
}

console.log('\nErrors from a browser')
{
  const first = await call('/report-error', {
    body: { message: 'Cannot read properties of null (reading \'useMemo\')', stack: 'at App (index.js:41:9)', path: '/', userAgent: 'Test/1.0' },
  })
  check('a report is accepted', first.status === 200 && first.data.stored === true)
  const list = errors()
  const entry = Object.values(list)[0]
  check('it is stored with its message', entry.message.startsWith('Cannot read properties'))
  check('with where it happened', entry.where === '/' && entry.agent === 'Test/1.0')
  check('and a stack to work from', /App/.test(entry.stack))
  check('the count starts at one', entry.count === 1)

  const again = await call('/report-error', { body: { message: 'Cannot read properties of null (reading \'useMemo\')' } })
  check('the same error again is accepted', again.status === 200)
  check('but is throttled rather than written', again.data.stored === false)

  const numbered = await call('/report-error', { body: { message: 'Failed to load plan 4711' } })
  const numbered2 = await call('/report-error', { body: { message: 'Failed to load plan 9912' } })
  check('a new message is stored', numbered.data.stored === true)
  // The numbers come out of the signature, so a bug that mentions a different id is the
  // same entry — and, being the same entry, the second report is throttled rather than
  // bought and paid for. That is why the count is described as approximate.
  check('the same bug at a different number is one entry, not two', Object.keys(errors()).length === 2, `${Object.keys(errors()).length} entries`)
  check('and the repeat is throttled rather than stored again', numbered2.data.stored === false)

  const empty = await call('/report-error', { body: {} })
  check('a report with no message is not stored', empty.data.stored === false)
}

console.log('\nThe error list cannot grow without bound')
{
  const list = {}
  for (let i = 0; i < 60; i++) {
    list[`sig${i}`] = { message: `boom ${i}`, count: 1, firstSeen: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`, lastSeen: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`, lastWrite: 0 }
  }
  kv.map.set('errors:recent', JSON.stringify(list))
  await call('/report-error', { body: { message: 'a brand new failure' } })
  const after = errors()
  check('the list is capped', Object.keys(after).length === 40, `${Object.keys(after).length} entries`)
  check('the newest error is kept', Object.values(after).some((e) => e.message === 'a brand new failure'))
  check('the oldest are dropped', !Object.keys(after).includes('sig0') || Object.values(after).every((e) => e.lastSeen >= '2026-01-01T00:00:00'))
}

console.log('\nOnly an admin can read the numbers')
{
  const anon = await call('/admin/stats', { method: 'GET' })
  check('without a session it is refused', anon.status === 401, `status ${anon.status}`)

  await kv.put('user:member@example.com', JSON.stringify({
    id: 'u_member', email: 'member@example.com', plan: 'free', email_verified: true, is_admin: false,
  }))
  const memberToken = await signToken({ id: 'u_member', email: 'member@example.com' })
  const member = await call('/admin/stats', { method: 'GET', token: memberToken })
  check('a signed-in customer is refused', member.status === 403, `status ${member.status}`)

  await kv.put('user:boss@example.com', JSON.stringify({
    id: 'u_boss', email: 'boss@example.com', plan: 'free', email_verified: true, is_admin: true,
  }))
  const adminToken = await signToken({ id: 'u_boss', email: 'boss@example.com' })
  const admin = await call('/admin/stats', { method: 'GET', token: adminToken })
  check('an admin gets the funnel', admin.status === 200 && admin.data.funnel[today]?.landing_view === 4, JSON.stringify(admin.data?.funnel))
  check('and the errors', admin.data.errors.length > 0 && admin.data.errors[0].lastSeen >= admin.data.errors[admin.data.errors.length - 1].lastSeen)
  check('with the ceiling reported', admin.data.ceiling === 2000)
}

console.log('\nThe browser reporter')
{
  // A fresh module state: the real install() runs once per page, so what follows is
  // what a page actually sends.
  installErrorReporting()
  check('it listens for errors and rejections', listeners.has('error') && listeners.has('unhandledrejection'))
  const fire = (type, event) => (listeners.get(type) || []).forEach((fn) => fn(event))

  fire('error', { message: 'Boom from the page', error: { stack: 'at App' } })
  check('an uncaught error is reported', reportedCount() === 1)
  fire('error', { message: 'Boom from the page', error: { stack: 'at App' } })
  check('the same message is not sent twice', reportedCount() === 1)
  fire('error', { message: 'Boom 1234', error: {} })
  fire('error', { message: 'Boom 5678', error: {} })
  check('the same failure with another number counts as one', reportedCount() === 2)
  fire('unhandledrejection', { reason: new Error('A promise gave up') })
  check('a rejected promise is reported', reportedCount() === 3)
  fire('error', { message: undefined, target: { src: '/missing.png' } })
  check('a missing image is not reported as a crash', reportedCount() === 3)

  for (let i = 0; i < 10; i++) fire('error', { message: `distinct failure ${i}`, error: {} })
  check('a page cannot send an unbounded number of reports', reportedCount() <= 6, `${reportedCount()} sent`)
  check('and every report that was sent reached the endpoint', reports.length >= 3)
  check('the report carries where it happened', reports[0].path === '/' && typeof reports[0].userAgent === 'string')
}

console.log(failures === 0 ? '\nAll visibility checks passed.\n' : `\n${failures} visibility check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
