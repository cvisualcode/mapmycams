// ─── Billing smoke test ──────────────────────────────────────────────────────
// Drives the real handler in api/index.js through a whole purchase with Stripe
// stubbed out, so checkout, confirm, invoices, cancel and the webhook can all be
// checked without a Stripe account, a network call or a card.
//
//   bun run billing:test
//
// It exercises both modes: the demo grant used when no Stripe key is set, and the
// paid path (redirect + confirm + webhook) once one is. No part of this touches a
// real Stripe account or a deployed Worker.

import { createHmac } from 'node:crypto'
import { handle } from '../api/index.js'

const WEBHOOK_SECRET = 'whsec_smoke_test'
const PRICES = {
  PRICE_PREMIUM_MONTHLY: 'price_monthly_test',
  PRICE_PREMIUM_YEARLY: 'price_yearly_test',
  PRICE_AI_PACK: 'price_ai_test',
  PRICE_PDF_REPORT: 'price_pdf_test',
  PRICE_FAMILY: 'price_family_test',
  PRICE_BRANDS: 'price_brands_test',
}

// ── A stand-in for the KV namespace, so accounts really are written and read ──
function memoryKV() {
  const map = new Map()
  return {
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

// ── Stripe, stubbed: records what the app asked for and answers like Stripe ──
const stripeCalls = []
let nextSession = null
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const full = String(url)
  if (!full.startsWith('https://api.stripe.com/')) throw new Error(`unexpected network call to ${full}`)
  const path = full.replace('https://api.stripe.com/v1/', '').split('?')[0]
  const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null
  stripeCalls.push({ path, method: init.method || 'GET', body })

  let data = {}
  if (path === 'checkout/sessions') data = { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }
  else if (path.startsWith('checkout/sessions/')) data = nextSession || {}
  else if (path === 'billing_portal/sessions') data = { url: 'https://billing.stripe.com/p/session/test_portal' }
  else if (path === 'invoices') {
    data = {
      data: [{
        id: 'in_test_1', subscription: 'sub_test_1', amount_paid: 499, status: 'paid', created: 1758000000,
        lines: { data: [{ description: 'MapMyCams Premium (Monthly)' }] },
      }],
    }
  }
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

const env = {
  AUTH_SECRET: 'smoke-test-secret-0123456789-abcdefghijkl',
  MAPMYCAMS_STORE: memoryKV(),
  APP_URL: 'https://mapmycams.dev',
}

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

/** One request against the deployed handler. */
async function call(path, { method = 'POST', body, token } = {}) {
  const request = new Request(`https://mapmycams.dev${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const res = await handle(request, env)
  return { status: res.status, data: await res.json().catch(() => null) }
}

/** A browser-stretched password, in the shape the API insists on. */
const credential = (seed = 1) => `pbkdf2$sha256$210000$${btoa(`salt-${seed}`)}$${btoa(`hash-${seed}-hash-${seed}`)}`

async function createAccount(email) {
  const signup = await call('/auth/signup', { body: { email, credential: credential(email.length), name: email.split('@')[0] } })
  const verify = await call('/auth/verify', { body: { email, code: signup.data?.devCode } })
  return { signup, verify, token: verify.data?.token }
}

// ── 1 · Demo mode: no Stripe key anywhere ────────────────────────────────────
console.log('\nDemo mode (no STRIPE_SECRET_KEY)')
const alice = await createAccount('alice@example.com')
check('signup asks for the emailed code', alice.signup.data?.pendingVerification === true)
check('verifying issues a session', Boolean(alice.token), JSON.stringify(alice.verify.data))
check('a new account starts on Free', alice.verify.data?.user?.plan === 'free')

const demoPlan = await call('/billing/checkout', { token: alice.token, body: { item: 'premium_monthly', kind: 'plan' } })
check('checkout grants the plan locally', demoPlan.data?.demo === true && demoPlan.data?.user?.plan === 'premium_monthly')

await call('/billing/cancel', { token: alice.token })
const demoAddon = await call('/billing/checkout', { token: alice.token, body: { item: 'ai_pack', kind: 'addon' } })
check('checkout grants an add-on locally', (demoAddon.data?.user?.addons || []).includes('ai_pack'))

const demoInvoices = await call('/billing/invoices', { token: alice.token })
check('no Stripe customer means no invoices', Array.isArray(demoInvoices.data?.invoices) && demoInvoices.data.invoices.length === 0)

const unauth = await call('/billing/checkout', { body: { item: 'premium_monthly' } })
check('checkout without a session is refused', unauth.status === 401)

// ── 2 · Paid mode: a key and price IDs are present ───────────────────────────
console.log('\nPaid mode (Stripe configured)')
Object.assign(env, PRICES, { STRIPE_SECRET_KEY: 'sk_test_smoke', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET })
await call('/billing/cancel', { token: alice.token }) // back to Free, no Stripe customer yet

const paid = await call('/billing/checkout', { token: alice.token, body: { item: 'premium_yearly', kind: 'plan' } })
check('checkout answers with a Stripe URL', String(paid.data?.url || '').startsWith('https://checkout.stripe.com/'), JSON.stringify(paid.data))

const sessionCall = stripeCalls.filter((c) => c.path === 'checkout/sessions').at(-1)
check('the session carries the price id it was sold at', sessionCall?.body['line_items[0][price]'] === PRICES.PRICE_PREMIUM_YEARLY)
check('the session carries the account id', sessionCall?.body.client_reference_id === alice.verify.data?.user?.id)
check('the session carries the item so the plan can be granted', sessionCall?.body['metadata[item]'] === 'premium_yearly')
check('the subscription is tagged too, or cancellation could not find the account', sessionCall?.body['subscription_data[metadata][userId]'] === alice.verify.data?.user?.id)
check('returning from Stripe brings the session id back', String(sessionCall?.body.success_url || '').includes('session_id={CHECKOUT_SESSION_ID}'))
check('a subscription is billed monthly/yearly, never both', sessionCall?.body.mode === 'subscription')

const stillFree = await call('/me', { method: 'GET', token: alice.token })
check('going to Stripe grants nothing on its own', stillFree.data?.plan === 'free', JSON.stringify(stillFree.data))

// The one that matters most: a missing price id must never hand out the thing.
delete env.PRICE_BRANDS
const noPrice = await call('/billing/checkout', { token: alice.token, body: { item: 'brands', kind: 'addon' } })
check('an item with no price id is refused, not granted', noPrice.status === 503, JSON.stringify(noPrice.data))
const afterNoPrice = await call('/me', { method: 'GET', token: alice.token })
check('...and nothing was unlocked by it', !(afterNoPrice.data?.addons || []).includes('brands'))
env.PRICE_BRANDS = PRICES.PRICE_BRANDS

const unknown = await call('/billing/checkout', { token: alice.token, body: { item: 'free_lunch', kind: 'plan' } })
check('an unknown item is refused', unknown.status === 400)

// ── 3 · Confirming the purchase on the way back ──────────────────────────────
console.log('\nConfirming a purchase')
nextSession = { id: 'cs_other', client_reference_id: 'someone-else', payment_status: 'paid', metadata: { item: 'premium_yearly' } }
const notYours = await call('/billing/confirm', { token: alice.token, body: { sessionId: 'cs_other' } })
check("another account's session cannot be claimed", notYours.status === 403)

nextSession = { id: 'cs_unpaid', client_reference_id: alice.verify.data?.user?.id, payment_status: 'unpaid', status: 'open', metadata: { item: 'premium_yearly' } }
const unpaid = await call('/billing/confirm', { token: alice.token, body: { sessionId: 'cs_unpaid' } })
check('an unpaid session grants nothing yet', unpaid.data?.pending === true)

nextSession = { id: 'cs_paid', client_reference_id: alice.verify.data?.user?.id, payment_status: 'paid', status: 'complete', mode: 'subscription', customer: 'cus_test_1', metadata: { item: 'premium_yearly' } }
const confirmed = await call('/billing/confirm', { token: alice.token, body: { sessionId: 'cs_paid' } })
check('a paid subscription confirms the plan', confirmed.data?.user?.plan === 'premium_yearly', JSON.stringify(confirmed.data))
check('the Stripe customer is remembered, so the portal can open', (await env.MAPMYCAMS_STORE.get('user:alice@example.com', 'json'))?.stripe_customer_id === 'cus_test_1')

nextSession = { id: 'cs_addon', client_reference_id: alice.verify.data?.user?.id, payment_status: 'paid', status: 'complete', mode: 'payment', customer: 'cus_test_1', metadata: { item: 'pdf_report' } }
const confirmedAddon = await call('/billing/confirm', { token: alice.token, body: { sessionId: 'cs_addon' } })
check('a paid add-on confirms the add-on', (confirmedAddon.data?.user?.addons || []).includes('pdf_report'), JSON.stringify(confirmedAddon.data))

const paidInvoices = await call('/billing/invoices', { token: alice.token })
check('invoices now come from Stripe', paidInvoices.data?.invoices?.[0]?.item === 'MapMyCams Premium (Monthly)', JSON.stringify(paidInvoices.data))
check('invoice amounts are in pounds', paidInvoices.data?.invoices?.[0]?.amount === 4.99)

const cancelPaid = await call('/billing/cancel', { token: alice.token })
check('cancelling a paid subscription goes through Stripe', cancelPaid.status === 409 && String(cancelPaid.data?.url || '').startsWith('https://billing.stripe.com/'), JSON.stringify(cancelPaid.data))

// ── 4 · The webhook: the same grants, from Stripe's side ─────────────────────
console.log('\nWebhook')
const bob = await createAccount('bob@example.com')
const bobId = bob.verify.data?.user?.id

async function postWebhook(event, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event)
  const t = Math.floor(Date.now() / 1000)
  const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('base64url')
  const request = new Request('https://mapmycams.dev/webhooks/stripe', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${v1}` }, body: payload,
  })
  const res = await handle(request, env)
  return { status: res.status, data: await res.json().catch(() => null) }
}

const forged = await postWebhook({ type: 'checkout.session.completed', data: { object: { client_reference_id: bobId, mode: 'payment', metadata: { item: 'family' } } } }, 'whsec_wrong')
check('a forged signature is rejected', forged.status === 400)

const granted = await postWebhook({ type: 'checkout.session.completed', data: { object: { client_reference_id: bobId, mode: 'payment', customer: 'cus_bob', metadata: { item: 'family' } } } })
check('the webhook is accepted', granted.status === 200 && granted.data?.received === true)
const bobAfter = await call('/me', { method: 'GET', token: bob.token })
check('the webhook grants the add-on', (bobAfter.data?.addons || []).includes('family'), JSON.stringify(bobAfter.data))

await postWebhook({ type: 'checkout.session.completed', data: { object: { client_reference_id: bobId, mode: 'subscription', customer: 'cus_bob', metadata: { item: 'premium_monthly' } } } })
const bobPremium = await call('/me', { method: 'GET', token: bob.token })
check('the webhook grants a subscription plan', bobPremium.data?.plan === 'premium_monthly')

await postWebhook({ type: 'customer.subscription.deleted', data: { object: { metadata: { userId: bobId } } } })
const bobCancelled = await call('/me', { method: 'GET', token: bob.token })
check('a cancelled subscription drops back to Free', bobCancelled.data?.plan === 'free')

globalThis.fetch = realFetch
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll billing checks passed.')
process.exit(failures ? 1 : 0)
