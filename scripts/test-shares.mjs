// Share links, client review and emailed reports — through the real handler,
// with an isolated KV and a mocked Resend transport. No live email is sent here:
// a passing mock is not a claim that an inbox received anything.
import assert from 'node:assert/strict'
import { handle } from '../api/index.js'
import { signToken, saveUser, saveShare } from '../api/_lib.js'
import { readSharedPlan, planShareUrl } from '../src/monetisation/share.js'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

const records = new Map()
const env = {
  AUTH_SECRET: 'isolated-share-test-secret-01234567890123',
  MAPMYCAMS_STORE: {
    async get(k, type) { const v = records.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v },
    async put(k, v) { records.set(k, v) }, async delete(k) { records.delete(k) },
    async list({ prefix = '' } = {}) { return { keys: [...records.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) } },
  },
  APP_URL: 'https://mapmycams.dev',
  // Fake values so the real delivery code runs and the mock transport sees it.
  RESEND_API_KEY: 're_test_mock',
  EMAIL_FROM: 'plans@mapmycams.dev',
}
globalThis.env = env

// Mocked mail transport: records what the app would send and can be told to fail.
const sent = []
let mailFails = false
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const full = String(url)
  if (!full.startsWith('https://api.resend.com/')) throw new Error(`unexpected network call to ${full}`)
  if (mailFails) return new Response(JSON.stringify({ error: 'provider refused' }), { status: 400 })
  sent.push(JSON.parse(init.body))
  return new Response(JSON.stringify({ id: 'mock-message' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

await saveUser({ id: 'owner', email: 'owner@example.test', name: 'Sam Owner', plan: 'premium_monthly', is_admin: false, email_verified: true })
await saveUser({ id: 'reviewer', email: 'reviewer@example.test', name: 'Riley Reviewer', plan: 'free', is_admin: false, email_verified: true })
const ownerToken = await signToken({ id: 'owner', email: 'owner@example.test' })
const reviewerToken = await signToken({ id: 'reviewer', email: 'reviewer@example.test' })

const plan = {
  version: 3, activeFloor: 1,
  floors: [
    { walls: [{ id: 1, closed: true, points: [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 800 }, { x: 0, y: 800 }] }], cameras: [], objects: [], wires: [] },
    { walls: [], cameras: [{ id: 2, x: 100, y: 100 }], objects: [], wires: [] },
  ],
  calibration: { measuredMetres: 4 },
}

async function call(path, { method = 'POST', body, token } = {}) {
  const request = new Request(`https://mapmycams.dev${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const res = await handle(request, env)
  return { status: res.status, data: await res.json().catch(() => null) }
}

console.log('\nPublishing')
check('a Free account cannot publish', (await call('/shares', { token: reviewerToken, body: { name: 'Nope', data: plan } })).status === 402)
check('publishing without a session is refused', (await call('/shares', { body: { name: 'Nope', data: plan } })).status === 401)
check('an oversized plan is refused', (await call('/shares', { token: ownerToken, body: { name: 'Big', data: { ...plan, pad: 'x'.repeat(600000) } } })).status === 413)
check('a blank name is refused', (await call('/shares', { token: ownerToken, body: { name: '   ', data: plan } })).status === 400)
const created = await call('/shares', { token: ownerToken, body: { name: '<b>Sam & Co</b>', data: plan } })
check('a premium owner publishes and gets a capability code', created.status === 200 && /^[A-Za-z0-9_-]{20,}$/.test(created.data?.code || ''), JSON.stringify(created.data))
check('the link expires after 30 days', created.data?.expires - created.data?.created === 30 * 86400000)
const code = created.data.code

console.log('\nViewing, signed out')
const view = await call(`/shares/${code}`, { method: 'GET' })
check('a signed-out recipient opens the published plan', view.status === 200 && view.data?.data?.floors?.length === 2)
check('every floor travels, including the one nobody was looking at', view.data.data.floors[1].cameras.length === 1)
check('calibration survives the publish', view.data.data.calibration.measuredMetres === 4)
check('the viewer is told what they can do', view.data.isOwner === false && view.data.canComment === false)
check('no owner address leaks to a viewer', !JSON.stringify(view.data).includes('owner@example.test'))
check('a viewer is not shown the open count', view.data.opens === undefined)
const ownerView = await call(`/shares/${code}`, { method: 'GET', token: ownerToken })
check('the owner sees how often the link was opened', typeof ownerView.data.opens === 'number' && ownerView.data.opens >= 1 && ownerView.data.isOwner === true)
check('an invalid code fails clearly', (await call('/shares/does-not-exist', { method: 'GET' })).status === 404)
check('a malformed code is not even routed', (await call(`/shares/${'x'.repeat(200)}`, { method: 'GET' })).status === 404)

console.log('\nReview notes')
check('an anonymous visitor cannot comment', (await call(`/shares/${code}/comments`, { body: { text: 'hello', floorIndex: 0, x: 1, y: 1 } })).status === 401)
const okComment = await call(`/shares/${code}/comments`, { token: reviewerToken, body: { text: 'Move this camera left', floorIndex: 1, x: 120, y: 130 } })
check('a signed-in reviewer pins a note', okComment.status === 200 && okComment.data?.id, JSON.stringify(okComment.data))
check('the note keeps its floor and position', okComment.data?.floorIndex === 1 && okComment.data?.x === 120)
const reread = await call(`/shares/${code}`, { method: 'GET' })
check('the pin survives a reload', reread.data.comments.length === 1 && reread.data.comments[0].text === 'Move this camera left')
check('the reviewer account id is not published with the note', !JSON.stringify(reread.data.comments[0]).includes('"author"'))
for (const bad of [
  { text: '', floorIndex: 0, x: 0, y: 0 },
  { text: 'x'.repeat(2001), floorIndex: 0, x: 0, y: 0 },
  { text: 'ok', floorIndex: 1.5, x: 0, y: 0 },
  { text: 'ok', floorIndex: -1, x: 0, y: 0 },
  { text: 'ok', floorIndex: 0, x: Infinity, y: 0 },
  { text: 'ok', floorIndex: 0, x: 1e9, y: 0 },
]) {
  const rejected = await call(`/shares/${code}/comments`, { token: reviewerToken, body: bad })
  assert.equal(rejected.status, 400, JSON.stringify(bad))
}
check('malformed notes are rejected: empty, too long, bad floor, bad position', true)
// Quota is 10/min per account; the malformed attempts consumed six of them.
let posted = 0
for (let i = 0; i < 10; i++) {
  const res = await call(`/shares/${code}/comments`, { token: reviewerToken, body: { text: `note ${i}`, floorIndex: 0, x: i, y: i } })
  if (res.status === 200) posted++
  else assert.equal(res.status, 429)
}
check('comments are rate limited per account', posted === 3 && (await call(`/shares/${code}/comments`, { token: reviewerToken, body: { text: 'one too many', floorIndex: 0, x: 0, y: 0 } })).status === 429)
check('the plan owner can moderate any note', (await call(`/shares/${code}/comments/${okComment.data.id}`, { method: 'DELETE', token: ownerToken })).status === 200)
check('...and it is gone for everyone', (await call(`/shares/${code}/comments`, { method: 'GET' })).data.length === posted)

console.log('\nEmailing the report')
check('only the owner can email a report', (await call(`/shares/${code}/email`, { token: reviewerToken, body: { email: 'client@example.test' } })).status === 403)
check('an anonymous email request is refused', (await call(`/shares/${code}/email`, { body: { email: 'client@example.test' } })).status === 401)
mailFails = true
const failed = await call(`/shares/${code}/email`, { token: ownerToken, body: { email: 'client2@example.test' } })
check('a provider failure is reported, without leaking credentials', failed.status === 502 && /refused/i.test(failed.data.error) && !JSON.stringify(failed.data).includes('RESEND'))
mailFails = false
check('a malformed recipient is refused', (await call(`/shares/${code}/email`, { token: ownerToken, body: { email: 'not-an-address' } })).status === 400)
check('nothing was sent for a refused request', sent.length === 0)
check('the owner sends the report', (await call(`/shares/${code}/email`, { token: ownerToken, body: { email: 'client@example.test' } })).status === 200)
check('the email carries the trusted app link with the code', sent[0].html.includes('https://mapmycams.dev/?share=') && sent[0].html.includes(code))
check('the plan name is escaped in the email body', !sent[0].html.includes('<b>Sam & Co</b>'))
check('the subject names the plan', sent[0].subject.includes('Sam & Co'))
for (let i = 0; i < 4; i++) await call(`/shares/${code}/email`, { token: ownerToken, body: { email: 'client@example.test' } })
check('report emails are rate limited per owner', (await call(`/shares/${code}/email`, { token: ownerToken, body: { email: 'client@example.test' } })).status === 429)

console.log('\nExpiry and revocation')
await saveShare({ code: 'expired-code', owner: 'owner', name: 'Old plan', data: plan, created: Date.now() - 31 * 86400000, expires: Date.now() - 86400000 })
check('an expired link says so', (await call('/shares/expired-code', { method: 'GET' })).status === 410)
check('an expired link cannot be emailed', (await call('/shares/expired-code/email', { token: ownerToken, body: { email: 'client@example.test' } })).status === 410)
check('a reviewer cannot revoke someone else’s link', (await call(`/shares/${code}`, { method: 'DELETE', token: reviewerToken })).status === 403)
check('the owner revokes the link', (await call(`/shares/${code}`, { method: 'DELETE', token: ownerToken })).status === 200)
check('and it stops working immediately', (await call(`/shares/${code}`, { method: 'GET' })).status === 404)

console.log('\nLegacy self-contained links')
{
  const snapshot = { version: 2, activeFloor: 0, floors: [{ walls: [], cameras: [{ id: 1 }], objects: [], wires: [] }] }
  const hash = planShareUrl(snapshot, 'https://mapmycams.dev/').split('#')[1]
  assert.deepEqual(readSharedPlan(`#${hash}`), snapshot)
  assert.equal(readSharedPlan('#plan=not-json'), null)
  console.log('✓ old #plan= links still open safely')
}

globalThis.fetch = realFetch
console.log(failures ? `\n${failures} share check(s) failed.` : '\nAll share, review and report-email checks passed (email transport mocked).')
process.exit(failures ? 1 : 0)
