import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { handle } from '../api/index.js'
import { saveUser, signToken, verifyToken, verifyStripeSignature, getUser, listUsers, hashPassword, writeJson } from '../api/_lib.js'
import { verificationEmail } from '../api/email-template.js'
import { onRequestPost } from '../functions/auth/send-code.js'

let checks = 0
function check(label, condition) {
  assert.ok(condition, label)
  checks++
  console.log(`  ✓ ${label}`)
}
const records = new Map(), writes = []
const kv = {
  async get(key, type) { const value = records.get(key); return value == null ? null : type === 'json' ? JSON.parse(value) : value },
  async put(key, value, options) { writes.push({ key, options }); records.set(key, value) },
  async delete(key) { records.delete(key) },
  async list({ prefix = '', cursor = '0' }) {
    // Force pagination; real KV list responses have a 1,000-key page ceiling.
    const names = [...records.keys()].filter((key) => key.startsWith(prefix)).sort()
    const offset = Number(cursor), keys = names.slice(offset, offset + 2).map((name) => ({ name }))
    return { keys, list_complete: offset + 2 >= names.length, cursor: String(offset + 2) }
  },
}
const env = {
  AUTH_SECRET: 'isolated-security-secret-01234567890123456789', MAPMYCAMS_STORE: kv,
  APP_URL: 'https://mapmycams.dev', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake',
  PRICE_AI_PACK: 'price_ai', PRICE_PDF_REPORT: 'price_pdf', PRICE_BRANDS: 'price_brands',
  PRICE_PREMIUM_MONTHLY: 'price_month', PRICE_PREMIUM_YEARLY: 'price_year',
  RESEND_API_KEY: 're_fake', EMAIL_FROM: 'test@mapmycams.dev',
}
globalThis.env = env
const outbox = [], stripeCalls = []
let mailFails = false, returnedSession = null
const realFetch = globalThis.fetch
const transport = async (url, init = {}) => {
  if (String(url) === 'https://api.resend.com/emails') {
    if (mailFails) return Response.json({ error: 'private provider diagnostic' }, { status: 500 })
    outbox.push(JSON.parse(init.body))
    return Response.json({ id: 'mail_test' })
  }
  if (String(url).startsWith('https://api.stripe.com/')) {
    stripeCalls.push({ url: String(url), body: new URLSearchParams(init.body) })
    if (String(url).includes('/checkout/sessions/')) return Response.json(returnedSession)
    if (String(url).endsWith('/checkout/sessions')) return Response.json({ id: 'cs_new', url: 'https://checkout.stripe.com/c/pay/cs_new' })
    if (String(url).includes('/invoices?')) return Response.json({ data: [] })
    throw new Error('Unexpected Stripe request')
  }
  throw new Error(`Unexpected network request: ${url}`)
}
globalThis.fetch = transport
let ip = 0
async function call(path, { method = 'POST', body, token, origin } = {}) {
  const res = await handle(new Request(`https://mapmycams.dev${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `test-${++ip}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env)
  return { status: res.status, data: await res.json(), headers: res.headers }
}
const credential = 'pbkdf2$sha256$210000$c2FsdC0xMjM0NTY3ODk=$$'.replace('$$', '$aGFzaC0xMjM0NTY3ODk=')
async function account(id, email, extra = {}) {
  const row = await saveUser({ id, email, name: id, plan: 'free', addons: [], email_verified: true,
    password_hash: await hashPassword(credential), ...extra })
  return { row, token: await signToken(row) }
}
const alice = await account('alice', 'alice@example.test')
const bob = await account('bob', 'bob@example.test')
const carol = await account('carol', 'carol@example.test')
function session(id, item = 'brands', owner = 'alice', mode = 'payment') {
  return { id, client_reference_id: owner, metadata: { userId: owner, item }, mode,
    status: 'complete', payment_status: 'paid', customer: `cus_${owner}`,
    ...(mode === 'subscription' ? { subscription: `sub_${id}` } : {}), amount_total: 699, currency: 'gbp' }
}
async function confirm(s, token = alice.token) {
  returnedSession = s
  return call('/billing/confirm', { token, body: { sessionId: s.id } })
}
async function webhook(event, timestamp = Math.floor(Date.now() / 1000), signatureExtra = '') {
  const payload = JSON.stringify(event)
  const signature = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest('hex')
  const res = await handle(new Request('https://mapmycams.dev/webhooks/stripe', {
    method: 'POST', body: payload, headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}${signatureExtra}` },
  }), env)
  return { status: res.status, data: await res.json() }
}

try {
  console.log('\nPayment authenticity and account ownership')
  const unpaid = { ...session('cs_unpaid'), payment_status: 'unpaid' }
  check('completed-but-unpaid return does not unlock purchases', (await confirm(unpaid)).data.pending === true)
  check('unpaid webhook does not create a receipt', (await webhook({ type: 'checkout.session.completed', data: { object: unpaid } })).status === 200 && !records.has('purchase:alice:cs_unpaid'))
  check('a missing account reference is rejected', (await confirm({ ...session('cs_missing'), client_reference_id: null })).status === 403)
  check('a conflicting metadata owner is rejected', (await confirm({ ...session('cs_conflict'), metadata: { item: 'brands', userId: 'bob' } })).status === 403)
  check('another account cannot claim a paid session', (await confirm(session('cs_other'), bob.token)).status === 403)
  check('unknown items never become premium plans', (await confirm(session('cs_unknown', 'super_admin', 'alice', 'subscription'))).status === 400)
  check('add-on/subscription mode mismatch is rejected', (await confirm(session('cs_mismatch', 'brands', 'alice', 'subscription'))).status === 400)
  check('old signed webhook requests are rejected', (await webhook({ type: 'ignored' }, Math.floor(Date.now() / 1000) - 301)).status === 400)
  check('future signed webhook requests are rejected', (await webhook({ type: 'ignored' }, Math.floor(Date.now() / 1000) + 600)).status === 400)
  check('multiple v1 signatures support key rotation', (await webhook({ type: 'ignored' }, undefined, ',v1=' + '0'.repeat(64))).status === 200)
  check('a missing webhook secret fails closed', await verifyStripeSignature('{}', 't=1,v1=x', undefined) === false)

  await call('/billing/checkout', { token: bob.token, body: { item: 'brands' } })
  check('first one-time checkout creates a Stripe customer for permanent billing linkage', stripeCalls.at(-1).body.get('customer_creation') === 'always')

  console.log('\nPermanent purchase receipts and concurrent ownership')
  const purchase = session('cs_brands')
  check('paid confirmation grants the add-on', (await confirm(purchase)).data.user.addons.includes('brands'))
  await confirm(purchase)
  await webhook({ type: 'checkout.session.completed', data: { object: purchase } })
  check('return and webhook retries create exactly one receipt', [...records.keys()].filter((key) => key === 'purchase:alice:cs_brands').length === 1)
  const receipt = JSON.parse(records.get('purchase:alice:cs_brands'))
  check('receipt permanently binds the Stripe session to immutable account ID', receipt.owner === 'alice' && receipt.id === 'cs_brands')
  check('purchase and ownership records have no expiration TTL', writes.filter((write) => /^(purchase|owned):/.test(write.key)).every((write) => !write.options))
  await Promise.all(['ai_pack', 'pdf_report'].map((item) => webhook({ type: 'checkout.session.async_payment_succeeded', data: { object: session(`cs_${item}`, item) } })))
  check('simultaneous add-on payments retain all three ownership grants', (await getUser('alice@example.test')).addons.length === 3)
  await saveUser({ email: 'alice@example.test', name: 'Updated profile', addons: [] })
  check('profile writes cannot remove paid ownership', (await getUser('alice@example.test')).addons.length === 3)
  check('billing history paginates all receipts', (await call('/billing/invoices', { token: alice.token })).data.invoices.length === 3)
  check('other accounts cannot read purchase history', (await call('/billing/invoices', { token: bob.token })).data.invoices.length === 0)
  await call('/billing/checkout', { token: alice.token, body: { item: 'ai_pack' } })
  check('subsequent checkout reuses the Stripe customer', stripeCalls.at(-1).body.get('customer') === 'cus_alice' && !stripeCalls.at(-1).body.has('customer_email'))
  check('webhook account lookup handles accounts beyond first KV page', (await webhook({ type: 'checkout.session.completed', data: { object: session('cs_carol', 'brands', 'carol') } })).status === 200 && (await getUser(carol.row.email)).addons.includes('brands'))
  check('all accounts are found across KV pages', (await listUsers()).length === 3)

  console.log('\nSubscription history is permanent; access is not')
  const sub = session('cs_subscription', 'premium_monthly', 'alice', 'subscription')
  await confirm(sub)
  await webhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_old', metadata: { userId: 'alice' } } } })
  check('old subscription cancellation cannot revoke a newer purchase', (await getUser(alice.row.email)).plan === 'premium_monthly')
  await webhook({ type: 'customer.subscription.deleted', data: { object: { id: sub.subscription, metadata: { userId: 'alice' } } } })
  check('active subscription cancellation revokes only subscription access', (await getUser(alice.row.email)).plan === 'free' && (await getUser(alice.row.email)).addons.length === 3)
  await confirm(sub)
  check('replaying an old paid success URL cannot resurrect cancellation', (await getUser(alice.row.email)).plan === 'free')
  check('cancelled subscriptions retain their purchase record', records.has('purchase:alice:cs_subscription'))

  console.log('\nAccount recovery and authorization')
  const legacy = await account('legacy', 'legacy@example.test', { email_verified: undefined })
  check('legacy verified accounts still sign in without recreating identity', (await call('/auth/login', { body: { identifier: legacy.row.email, credential } })).data.user.id === 'legacy')
  check('signup cannot overwrite a legacy verified account', (await call('/auth/signup', { body: { email: legacy.row.email, credential } })).status === 409)
  await writeJson('share:expired_code', { owner: 'alice', expires: Date.now() - 1000 })
  await writeJson('share-comments:expired_code', [{ text: 'Private review' }])
  check('expired share links cannot leak comments via the comments endpoint', (await call('/shares/expired_code/comments', { method: 'GET' })).status === 404)
  await call('/auth/reset-request', { body: { email: alice.row.email } })
  const code = outbox.at(-1).text.match(/\b\d{6}\b/)[0]
  const reset = await call('/auth/reset-confirm', { body: { email: alice.row.email, code, credential } })
  check('password reset retains account ID and every purchase', reset.data.user.id === 'alice' && reset.data.user.addons.length === 3)
  check('pre-reset tokens are invalidated', (await call('/me', { method: 'GET', token: alice.token })).status === 401)
  check('fresh session restores purchases on another browser/device', (await call('/me', { method: 'GET', token: reset.data.token })).data.addons.length === 3)
  delete env.RESEND_API_KEY
  const known = await call('/auth/reset-request', { body: { email: bob.row.email } })
  const unknown = await call('/auth/reset-request', { body: { email: 'unknown@example.test' } })
  check('missing mail configuration exposes no reset code or account existence', !known.data.devCode && !known.data.deliveryError && known.data.sent === unknown.data.sent)
  env.RESEND_API_KEY = 're_fake'; mailFails = true
  await saveUser({ email: bob.row.email, reset_sent_at: null })
  const failedMail = await call('/auth/reset-request', { body: { email: bob.row.email } })
  check('provider failure never returns reset code or private provider errors', !failedMail.data.devCode && !failedMail.data.deliveryError)
  const failedSignup = await call('/auth/signup', { body: { email: 'new@example.test', credential } })
  check('signup email failure does not bypass verification', !failedSignup.data.devCode && failedSignup.data.sent === false)
  check('legacy verified account cannot be overwritten via signup', (await call('/auth/signup', { body: { email: alice.row.email, credential } })).status === 409)
  mailFails = false
  await saveUser({ email: bob.row.email, email_verified: false })
  check('a token for an unverified account has no access', (await call('/me', { method: 'GET', token: bob.token })).status === 401)
  check('non-admin cannot set plans', (await call('/admin/set-plan', { token: reset.data.token, body: { userId: 'bob', plan: 'premium_yearly' } })).status === 403)
  check('obsolete Worker email relay is disabled', (await call('/auth/send-code', { origin: env.APP_URL, body: { email: 'arbitrary@example.test', code: '123456' } })).status === 410)
  check('obsolete Pages email relay is disabled', (await onRequestPost({ request: new Request(env.APP_URL), env })).status === 410)
  check('HTML in email names is escaped', !verificationEmail('123456', '<img src=x onerror=alert(1)>').html.includes('<img'))
  const response = await call('/me', { method: 'GET', token: reset.data.token, origin: 'https://evil.test' })
  check('account responses cannot be cached or read by foreign origins', response.headers.get('Cache-Control') === 'no-store' && !response.headers.has('Access-Control-Allow-Origin'))
  check('Pages frontend is allowed to read the Worker API', (await call('/me', { method: 'GET', token: reset.data.token, origin: 'https://mapmycams.pages.dev' })).headers.get('Access-Control-Allow-Origin') === 'https://mapmycams.pages.dev')
  const malformedPayload = Buffer.from(JSON.stringify({ sub: 'alice', email: alice.row.email })).toString('base64url')
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const signature = createHmac('sha256', env.AUTH_SECRET).update(`${header}.${malformedPayload}`).digest('base64url')
  check('signed JWT without expiry is rejected', await verifyToken(`${header}.${malformedPayload}.${signature}`) === null)
  const valid = await signToken({ ...alice.row, password_version: 1 })
  check('extra JWT segments are rejected', await verifyToken(`${valid}.ignored`) === null)
  const attempts = []
  for (let i = 0; i < 6; i++) attempts.push((await call('/auth/login', { body: { identifier: carol.row.email, credential: credential.replace('aGFzaC', 'aGFzZA') } })).status)
  check('server sign-in brute force is throttled even from changing IPs', attempts[5] === 429)

  console.log('\nBrowser restoration and production fail-closed behavior')
  const storage = new Map([['mmc_token_v1', reset.data.token]])
  globalThis.window = { localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) }, location: { hostname: 'mapmycams.dev', href: env.APP_URL } }
  globalThis.fetch = async (url, init = {}) => String(url).startsWith('https://api.') ? transport(url, init) : handle(new Request(new URL(url, env.APP_URL), init), env)
  const browserApi = await import('../src/monetisation/api.js?security=restore')
  check('browser billing works with only a server session, no local account', (await browserApi.getBilling()).length === 4)
  check('browser session restores permanent add-ons', (await browserApi.getMe()).addons.length === 3)
  storage.delete('mmc_token_v1')
  globalThis.fetch = async () => new Response('<html>API outage</html>', { headers: { 'Content-Type': 'text/html' } })
  const brokenApi = await import('../src/monetisation/api.js?security=production-outage')
  check('production HTML response is not demo permission', await brokenApi.apiProbeResult() === 'unknown' && await brokenApi.demoAdminAllowed() === false)
  await assert.rejects(brokenApi.startCheckout('brands', 'addon'), /unavailable/)
  check('outage checkout grants nothing locally', true)
  await assert.rejects(brokenApi.login('Admin', 'Admin1'), /unavailable/)
  check('production outage cannot log in as demo Admin', true)
  check('production signup outage does not create a local account', await brokenApi.signup('outage@example.test', 'Password1').then(() => false, () => true))
} finally {
  globalThis.fetch = realFetch
}
console.log(`\n${checks} security checks passed.`)
