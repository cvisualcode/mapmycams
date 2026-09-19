// ─── API endpoints (serverless handler) ──────────────────────────────────────
// Mount as a Cloudflare Worker module or Node serverless catch-all.
// Routes:
//   POST /auth/signup | /auth/verify | /auth/resend | /auth/login | /auth/logout
//   POST /auth/reset-request | /auth/reset-confirm  (forgotten password)
//   POST /auth/send-code  (mailer only — for browsers with no server session)
//   GET  /me
//   GET/POST/DELETE /floorplans(/:id)
//   POST /billing/checkout | /billing/confirm | /billing/portal | /billing/cancel | /billing/invoices
//   POST /webhooks/stripe
//   POST /ai/suggest  (rate-limited, premium only)
//   POST /analytics  (counted per day for the visitor journey)
//   POST /report-error  (uncaught errors from a visitor's browser)
//   GET  /admin/users | /admin/stats | POST /admin/set-plan | /admin/flag
//
// Accounts, floorplans and flags live in Cloudflare KV (api/_lib.js). Passwords
// arrive already stretched by the browser, so this process never sees one.

import {
  signToken, verifyToken, hashPassword, verifyPassword,
  getUser, listUsers, saveUser, listFloorplans, saveFloorplan, deleteFloorplan, setFlag,
  stripeCheckoutSession, stripeGetSession, stripeListInvoices,
  stripePortalSession, verifyStripeSignature, stripeConfigured,
  generateVerificationCode, hashCode, verifyCode, credentialProblem, sendVerificationEmail, sendResetEmail,
  emailConfigured, resendCooldownRemaining, CODE_TTL_MS, CODE_MAX_ATTEMPTS,
  json, cors, rateLimit, readJson, writeJson,
} from './_lib.js'
import { suggestSpotsWithModel, PIXELS_PER_METER } from './ai.js'

// Stripe price IDs come from env: PRICE_PREMIUM_MONTHLY, PRICE_PREMIUM_YEARLY,
// PRICE_AI_PACK, PRICE_PDF_REPORT, PRICE_BRANDS. Family Sharing was dropped: the
// tool never had household seats behind it, so it was not something to sell.
const PRICE_MAP = () => ({
  premium_monthly: { price: globalThis.env.PRICE_PREMIUM_MONTHLY, mode: 'subscription' },
  premium_yearly: { price: globalThis.env.PRICE_PREMIUM_YEARLY, mode: 'subscription' },
  ai_pack: { price: globalThis.env.PRICE_AI_PACK, mode: 'payment' },
  pdf_report: { price: globalThis.env.PRICE_PDF_REPORT, mode: 'payment' },
  brands: { price: globalThis.env.PRICE_BRANDS, mode: 'payment' },
})

/** The one-off add-ons, used when there are no Stripe prices to read a mode from. */
const ADDON_ITEMS = ['ai_pack', 'pdf_report', 'brands']

/** True for a plan key, false for an add-on key. */
const isAddon = (item) => ADDON_ITEMS.includes(item)

/**
 * Apply a completed purchase to an account.
 *
 * Shared by the webhook and by the confirm call the browser makes on its way
 * back from Stripe, so a purchase is recorded the same way whichever gets there
 * first — and applying it twice (both do, normally) is harmless: the plan is
 * overwritten with the same value and add-ons are a set.
 */
async function grantPurchase(account, { item, mode, customerId }) {
  if (!account || !item) return null
  const customer = customerId || account.stripe_customer_id
  if (mode === 'subscription') {
    if (isAddon(item)) return null
    return saveUser({ email: account.email, plan: item, stripe_customer_id: customer })
  }
  if (!isAddon(item)) return null
  return saveUser({ email: account.email, addons: [...new Set([...(account.addons || []), item])], stripe_customer_id: customer })
}

/** The only origins allowed to reach the verification mailer. */
const MAILER_ORIGIN = /^https?:\/\/([a-z0-9-]+\.)?(mapmycams\.dev|mapmycams\.pages\.dev|localhost(:\d+)?)$/i

/**
 * The mailer sends real mail from the verified domain, so only the app itself
 * may call it. A *missing* Origin is rejected too: browsers always send one on
 * POST, and treating "absent" as trusted is exactly what would let a scripted
 * client use this route as a mail relay.
 */
function mailerOriginAllowed(request) {
  const origin = request.headers.get('Origin')
  return Boolean(origin) && MAILER_ORIGIN.test(origin)
}

// ── What visitors do, and what breaks for them ───────────────────────────────
// Both live in the same store as the accounts, keyed so a day of numbers is one
// record and the whole error list is another. Two rules keep them from ever costing
// more than they are worth: the day's counting stops at a ceiling, and one error
// signature is written at most once every few minutes.

/**
 * The events that describe a visitor's journey, and the only ones stored server-side.
 *
 * An event name is free text from an unauthenticated caller, so this is a set rather
 * than a namespace: anything else is acknowledged and dropped.
 */
const FUNNEL_EVENTS = new Set([
  'landing_view', 'landing_cta', 'auth_view', 'signup_started', 'email_verified',
  'login_success', 'login_blocked_unverified', 'password_reset_requested',
  'password_reset_done', 'checkout_started', 'checkout_redirected',
  'checkout_completed', 'upsell_shown', 'subscription_canceled',
  'floorplan_saved', 'ai_suggest',
])

/** A day's counting stops here, so a flood cannot spend the sign-in write budget. */
const FUNNEL_DAY_CEILING = 2000

/** Where the error list lives, how long it may get, and how often it may be written. */
const ERROR_LIST_KEY = 'errors:recent'
const ERROR_LIST_MAX = 40
const ERROR_WRITE_INTERVAL_MS = 5 * 60 * 1000

const utcDay = (offsetDays = 0) => new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10)

/** Add one to today's count for an event. False when the day's ceiling was reached. */
async function countFunnelEvent(event) {
  const key = `stats:${utcDay()}`
  const counts = (await readJson(key)) || {}
  const total = Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0)
  if (total >= FUNNEL_DAY_CEILING) return false
  counts[event] = (counts[event] || 0) + 1
  await writeJson(key, counts)
  return true
}

/**
 * A stable name for an error, so the same crash is one entry and not two hundred.
 *
 * Digits come out first: "Cannot read properties of null (reading 'id') at 47" and the
 * same line at 82 are the same bug, and a counter that says so is worth reading.
 */
async function errorSignature(message) {
  const normalised = message.toLowerCase().replace(/\d+/g, '#')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalised))
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Keep the most recently seen, so an old bug cannot crowd out a new one. */
function pruneErrors(list) {
  const entries = Object.entries(list)
  if (entries.length <= ERROR_LIST_MAX) return list
  return Object.fromEntries(entries
    .sort((a, b) => String(b[1].lastSeen).localeCompare(String(a[1].lastSeen)))
    .slice(0, ERROR_LIST_MAX))
}

/** Record one uncaught error from a browser. False when it was throttled. */
async function recordClientError(report) {
  const message = String(report?.message || '').slice(0, 300)
  if (!message) return false
  const signature = await errorSignature(message)
  const list = (await readJson(ERROR_LIST_KEY)) || {}
  const existing = list[signature]
  const now = Date.now()
  // One write per signature per few minutes: a page that throws on every frame would
  // otherwise spend the store on a single visitor. The count is therefore approximate;
  // the first and last sightings are exact, which is what a bug hunt needs.
  if (existing && now - (existing.lastWrite || 0) < ERROR_WRITE_INTERVAL_MS) return false
  const seen = new Date().toISOString()
  await writeJson(ERROR_LIST_KEY, pruneErrors({
    ...list,
    [signature]: {
      message,
      count: (existing?.count || 0) + 1,
      firstSeen: existing?.firstSeen || seen,
      lastSeen: seen,
      lastWrite: now,
      where: String(report?.path || '').slice(0, 200),
      agent: String(report?.userAgent || '').slice(0, 200),
      stack: String(report?.stack || '').slice(0, 1000),
    },
  }))
  return true
}

/**
 * The signed-in account, or null.
 *
 * A token carries the password version it was issued against, so a session from
 * before a password reset is refused rather than staying valid for its full 30 days.
 */
async function authUser(request) {
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '')
  const claims = token && await verifyToken(token)
  if (!claims) return null
  const user = await getUser(claims.email)
  if (!user || user.id !== claims.id) return null
  return (user.password_version || 0) === (claims.pv || 0) ? user : null
}

/** Look an account up by id as well as email — admin and webhook callers use ids. */
async function findAccount(ref) {
  const value = String(ref || '').trim()
  if (!value) return null
  if (value.includes('@')) return getUser(value)
  return (await listUsers()).find((row) => row.id === value) || null
}

// ── Email verification ───────────────────────────────────────────────────────
// An account is created unverified and gets no session until the code emailed to
// it is entered, so the planner is unusable before the address is proven. Only
// the code's hash is stored server-side.

/** The client-visible shape of an account. */
function publicRow(u) {
  return {
    id: u.id, email: u.email, name: u.name, plan: u.plan,
    addons: u.addons || [], isAdmin: !!u.is_admin, twoFA: !!u.two_fa,
    emailVerified: u.email_verified !== false,
  }
}

/**
 * Send a code. Returns `devCode` only when no provider is configured, so the
 * flow is completable before RESEND_API_KEY is set — never in production.
 */
async function deliverCode(email, code) {
  if (!emailConfigured()) return { sent: false, devCode: code }
  try {
    await sendVerificationEmail(email, code)
    return { sent: true }
  } catch (err) {
    return { sent: false, deliveryError: err.message, devCode: code }
  }
}

/** Send a password-reset code. `devCode` only when no provider is configured. */
async function deliverReset(email, code) {
  if (!emailConfigured()) return { sent: false, devCode: code }
  try {
    await sendResetEmail(email, code)
    return { sent: true }
  } catch (err) {
    return { sent: false, deliveryError: err.message, devCode: code }
  }
}

/** Issue a fresh code for an existing account: store the hash, then email it. */
async function issueCode(user) {
  const code = generateVerificationCode()
  await saveUser({
    email: user.email,
    email_verified: false,
    verification_code_hash: await hashCode(code),
    verification_expires: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    verification_attempts: 0,
    verification_sent_at: new Date().toISOString(),
  })
  return deliverCode(user.email, code)
}

async function handle(request, env) {
  globalThis.env = env
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/$/, '')
  const method = request.method

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() })

  // ── Auth ───────────────────────────────────────────────────────────────────
  if (path === '/auth/signup' && method === 'POST') {
    const { email, credential, name } = await request.json()
    const id = String(email || '').trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(id)) return json({ error: 'Enter a valid email address' }, 400)
    const problem = credentialProblem(credential)
    if (problem) return json({ error: problem }, 400)
    const existing = await getUser(id)
    if (existing?.email_verified) return json({ error: 'An account with that email already exists' }, 409)
    const code = generateVerificationCode()
    const userId = existing?.id || crypto.randomUUID()
    await saveUser({
      id: userId,
      email: id,
      name: name || existing?.name || id.split('@')[0],
      password_hash: await hashPassword(credential),
      plan: existing?.plan || 'free',
      addons: existing?.addons || [],
      is_admin: existing?.is_admin || false,
      created_at: existing?.created_at || new Date().toISOString(),
      email_verified: false,
      verification_code_hash: await hashCode(code),
      verification_expires: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      verification_attempts: 0,
      verification_sent_at: new Date().toISOString(),
    })
    return json({ pendingVerification: true, email: id, ...(await deliverCode(id, code)) })
  }

  // Enter the emailed code — the only way a new account gets a session.
  if (path === '/auth/verify' && method === 'POST') {
    const { email, code } = await request.json()
    const id = String(email || '').trim().toLowerCase()
    const user = await getUser(id)
    if (!user) return json({ error: 'No account is awaiting verification for that address' }, 404)
    if (user.email_verified) {
      // Already proven. A session has to come from the password: answering with a
      // token here would hand an account to anyone who knew the address.
      return json({ error: 'That account is already verified — sign in with your password' }, 400)
    }
    if (!user.verification_code_hash) return json({ error: 'Request a new code' }, 400)
    if (new Date(user.verification_expires).getTime() < Date.now()) return json({ error: 'That code has expired — request a new one' }, 400)
    const attempts = user.verification_attempts || 0
    if (attempts >= CODE_MAX_ATTEMPTS) return json({ error: 'Too many incorrect codes — request a new one' }, 429)
    if (!(await verifyCode(code, user.verification_code_hash))) {
      await saveUser({ email: id, verification_attempts: attempts + 1 })
      return json({ error: `That code is not correct. ${CODE_MAX_ATTEMPTS - attempts - 1} attempt(s) left.` }, 400)
    }
    const verified = await saveUser({
      email: id, email_verified: true, verification_code_hash: null, verification_expires: null, verification_attempts: 0,
    })
    return json({ token: await signToken(verified), user: publicRow(verified) })
  }

  // Mailer-only route: delivers a code the client generated. This is what lets
  // real email work in a browser that has no server session — accounts still live
  // locally there, and only the sending is server-side, which is what keeps
  // RESEND_API_KEY out of the browser. Accounts created here do not use it.
  if (path === '/auth/send-code' && method === 'POST') {
    if (!mailerOriginAllowed(request)) return json({ sent: false, error: 'Origin not allowed' }, 403)
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown'
    if (!rateLimit(`mail:${ip}`, 5)) return json({ sent: false, error: 'Too many codes requested — try again in a minute' }, 429)
    const { email, code, name, kind } = await request.json().catch(() => ({}))
    const to = String(email || '').trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(to)) return json({ sent: false, error: 'A valid email address is required' }, 400)
    if (!/^\d{6}$/.test(String(code || ''))) return json({ sent: false, error: 'A 6-digit code is required' }, 400)
    try {
      // `kind: 'reset'` picks the reset wording, so a browser that keeps its accounts
      // locally gets the same email a server-side account would.
      const send = kind === 'reset' ? sendResetEmail : sendVerificationEmail
      await send(to, String(code), name)
      return json({ sent: true })
    } catch (err) {
      return json({ sent: false, error: err.message }, 502)
    }
  }

  // Send a replacement code (rate-limited so it can't be used to spam an inbox).
  if (path === '/auth/resend' && method === 'POST') {
    const { email } = await request.json()
    const id = String(email || '').trim().toLowerCase()
    const user = await getUser(id)
    if (!user) return json({ error: 'No account is awaiting verification for that address' }, 404)
    if (user.email_verified) return json({ error: 'That account is already verified' }, 400)
    const wait = resendCooldownRemaining(user.verification_sent_at)
    if (wait > 0) return json({ error: `Please wait ${wait}s before requesting another code` }, 429)
    return json({ pendingVerification: true, email: id, ...(await issueCode(user)) })
  }

  // ── Forgotten password ─────────────────────────────────────────────────────
  // Asking for a reset answers the same way whether or not there is an account
  // behind the address, so the form cannot be used to find out who is registered.
  // The account is untouched until the emailed code comes back.
  if (path === '/auth/reset-request' && method === 'POST') {
    const body = await request.json().catch(() => ({}))
    const id = String(body.email || '').trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(id)) return json({ error: 'Enter a valid email address' }, 400)
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown'
    if (!rateLimit(`reset:${ip}`, 5)) return json({ error: 'Too many reset requests — try again in a minute' }, 429)
    const user = await getUser(id)
    // Nothing to reset, so say nothing about it: the answer is the one an address with
    // an account gets, down to the fields. Anything else — a missing `sent`, a
    // cooldown, a delivery error — is a way to ask "is this address registered?"
    // one POST at a time.
    if (!user) return json({ ok: true, email: id, sent: true })
    if (resendCooldownRemaining(user.reset_sent_at) > 0) return json({ ok: true, email: id, sent: true })
    const code = generateVerificationCode()
    await saveUser({
      email: id,
      reset_code_hash: await hashCode(code),
      reset_expires: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      reset_attempts: 0,
      reset_sent_at: new Date().toISOString(),
    })
    return json({ ok: true, email: id, ...(await deliverReset(id, code)) })
  }

  // Finish a reset. The code proves the address and the new password is set with it,
  // after which every session issued against the old password stops working.
  if (path === '/auth/reset-confirm' && method === 'POST') {
    const body = await request.json().catch(() => ({}))
    const id = String(body.email || '').trim().toLowerCase()
    const problem = credentialProblem(body.credential)
    if (problem) return json({ error: problem }, 400)
    const user = await getUser(id)
    if (!user) return json({ error: 'That code is not correct' }, 400)
    if (!user.reset_code_hash) return json({ error: 'That code is no longer valid — request a new one' }, 400)
    if (new Date(user.reset_expires).getTime() < Date.now()) return json({ error: 'That code has expired — request a new one' }, 400)
    const attempts = user.reset_attempts || 0
    if (attempts >= CODE_MAX_ATTEMPTS) return json({ error: 'Too many incorrect codes — request a new one' }, 429)
    if (!(await verifyCode(body.code, user.reset_code_hash))) {
      await saveUser({ email: id, reset_attempts: attempts + 1 })
      return json({ error: `That code is not correct. ${CODE_MAX_ATTEMPTS - attempts - 1} attempt(s) left.` }, 400)
    }
    const updated = await saveUser({
      email: id,
      password_hash: await hashPassword(body.credential),
      password_version: (user.password_version || 0) + 1,
      reset_code_hash: null,
      reset_expires: null,
      reset_attempts: 0,
      reset_sent_at: null,
      // The code arrived at this address, so it is proven either way — which also
      // rescues an account that was created but never finished verifying.
      email_verified: true,
      verification_code_hash: null,
      verification_expires: null,
      verification_attempts: 0,
    })
    return json({ token: await signToken(updated), user: publicRow(updated) })
  }

  if (path === '/auth/login' && method === 'POST') {
    const { identifier, credential } = await request.json()
    const problem = credentialProblem(credential)
    if (problem) return json({ error: problem }, 400)
    const user = await getUser(String(identifier || '').trim().toLowerCase())
    if (!user || !(await verifyPassword(credential, user.password_hash))) {
      return json({ error: 'Invalid email or password' }, 401)
    }
    // An unverified account gets no session — the client switches to the code screen.
    if (!user.email_verified) return json({ pendingVerification: true, email: user.email }, 403)
    return json({ token: await signToken(user), user: publicRow(user) })
  }

  // Tokens are stateless; the client drops its copy. Kept so the client's logout
  // call succeeds instead of looking like a failure.
  if (path === '/auth/logout' && method === 'POST') return json({ ok: true })

  // ── Current user ───────────────────────────────────────────────────────────
  if (path === '/me' && method === 'GET') {
    const user = await authUser(request)
    if (!user) return json({ error: 'Unauthorised' }, 401)
    return json(publicRow(user))
  }

  // ── Floorplans ─────────────────────────────────────────────────────────────
  // Keyed by owner, so a layout belongs to the account rather than to the browser
  // that drew it and follows the user to another device.
  if (path === '/floorplans' && method === 'GET') {
    const user = await authUser(request)
    if (!user) return json({ error: 'Unauthorised' }, 401)
    return json(await listFloorplans(user.id))
  }
  if (path === '/floorplans' && method === 'POST') {
    const user = await authUser(request)
    if (!user) return json({ error: 'Unauthorised' }, 401)
    const { id, name, data } = await request.json()
    if (user.plan === 'free' && !id) {
      const existing = await listFloorplans(user.id)
      if (existing.length >= 1) return json({ error: 'Free tier limit: 1 floorplan' }, 402)
    }
    const row = {
      id: id || crypto.randomUUID(), owner: user.id, name, data,
      updated: Date.now(), updated_at: new Date().toISOString(),
    }
    await saveFloorplan(row)
    return json(row)
  }
  if (path.startsWith('/floorplans/') && method === 'DELETE') {
    const user = await authUser(request)
    if (!user) return json({ error: 'Unauthorised' }, 401)
    await deleteFloorplan(user.id, path.split('/')[2])
    return json({ ok: true })
  }

  // ── Billing ────────────────────────────────────────────────────────────────
  if (path === '/billing/checkout' && method === 'POST') {
    const user = await authUser(request)
    if (!user) return json({ error: 'Unauthorised' }, 401)
    const { item } = await request.json()
    const entry = PRICE_MAP()[item]
    if (!entry) return json({ error: 'Unknown plan or add-on' }, 400)

    // With no Stripe secret key there is nothing to charge, so the entitlement is
    // granted here — that keeps the pricing flow demonstrable and switches itself
    // off the moment a real key is set. Once Stripe *is* configured, an item with
    // no price ID cannot be sold, and granting it anyway would hand out Premium
    // for free: that is an error, not a discount.
    if (!stripeConfigured()) {
      const patch = isAddon(item)
        ? { email: user.email, addons: [...new Set([...(user.addons || []), item])] }
        : { email: user.email, plan: item }
      const row = await saveUser(patch)
      return json({ demo: true, user: publicRow(row) })
    }
    if (!entry.price) return json({ error: `Stripe is not set up for ${item} yet`, item }, 503)

    const session = await stripeCheckoutSession({
      priceId: entry.price, userId: user.id, email: user.email, mode: entry.mode, item,
    })
    return json({ url: session.url, id: session.id })
  }
  // The browser lands back here with ?session_id=… and asks the server to apply
  // the purchase, rather than showing a plan that only catches up once the
  // webhook event has been delivered.
  if (path === '/billing/confirm' && method === 'POST') {
    const user = await authUser(request)
    if (!user) return json({ error: 'Unauthorised' }, 401)
    const { sessionId } = await request.json().catch(() => ({}))
    if (!stripeConfigured() || !sessionId) return json({ demo: true })

    let session
    try {
      session = await stripeGetSession(sessionId)
    } catch {
      return json({ error: 'That checkout session could not be read' }, 404)
    }
    // Only the account that started the session may claim it — otherwise a
    // leaked session id would be a way to buy Premium for someone else's account.
    if (session.client_reference_id && session.client_reference_id !== user.id) {
      return json({ error: 'Not your checkout session' }, 403)
    }
    const paid = session.payment_status === 'paid' || session.status === 'complete'
    if (!paid) return json({ pending: true })
    const row = await grantPurchase(user, { item: session.metadata?.item, mode: session.mode, customerId: session.customer })
    return json({ ok: true, user: publicRow(row || user) })
  }
  // Real invoices, straight from Stripe, so the dashboard's billing history is the
  // same record the customer sees in the portal.
  if (path === '/billing/invoices' && method === 'POST') {
    const user = await authUser(request)
    if (!user) return json({ error: 'Unauthorised' }, 401)
    if (!stripeConfigured() || !user.stripe_customer_id) return json({ invoices: [] })
    const rows = await stripeListInvoices(user.stripe_customer_id).catch(() => [])
    return json({
      invoices: rows.map((inv) => ({
        id: inv.id,
        item: inv.lines?.data?.[0]?.description || inv.description || 'MapMyCams',
        kind: inv.subscription ? 'subscription' : 'addon',
        amount: (inv.amount_paid || 0) / 100,
        status: inv.status || 'unknown',
        date: new Date((inv.created || 0) * 1000).toISOString(),
      })),
    })
  }
  if (path === '/billing/portal' && method === 'POST') {
    const user = await authUser(request)
    if (!user) return json({ error: 'Unauthorised' }, 401)
    if (!stripeConfigured() || !user.stripe_customer_id) return json({ demo: true })
    const session = await stripePortalSession(user.stripe_customer_id)
    return json({ url: session.url })
  }
  if (path === '/billing/cancel' && method === 'POST') {
    const user = await authUser(request)
    if (!user) return json({ error: 'Unauthorised' }, 401)
    // A subscription bought through Stripe is cancelled at Stripe. Flipping the
    // account to free here would cut off their access while Stripe carried on
    // charging the card, so the customer is sent to the portal instead.
    if (stripeConfigured() && user.stripe_customer_id) {
      const session = await stripePortalSession(user.stripe_customer_id).catch(() => null)
      return json({ error: 'Cancel in the billing portal so the payments stop too', url: session?.url || null }, 409)
    }
    const row = await saveUser({ email: user.email, plan: 'free' })
    return json({ ok: true, plan: row.plan, user: publicRow(row) })
  }

  // ── Stripe webhook: keep subscription status in sync ───────────────────────
  if (path === '/webhooks/stripe' && method === 'POST') {
    const payload = await request.text()
    const sig = request.headers.get('Stripe-Signature') || ''
    if (!(await verifyStripeSignature(payload, sig, env.STRIPE_WEBHOOK_SECRET))) return json({ error: 'Bad signature' }, 400)
    const event = JSON.parse(payload)
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object
      const account = await findAccount(s.client_reference_id || s.metadata?.userId)
      await grantPurchase(account, { item: s.metadata?.item, mode: s.mode, customerId: s.customer })
    }
    if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.paused') {
      const account = await findAccount(event.data.object.metadata?.userId)
      if (account) await saveUser({ email: account.email, plan: 'free' })
    }
    return json({ received: true })
  }

  // ── AI suggestions (premium, rate-limited) ─────────────────────────────────
  if (path === '/ai/suggest' && method === 'POST') {
    const user = await authUser(request)
    if (!user) return json({ error: 'Unauthorised' }, 401)
    const premium = user.plan?.startsWith('premium') || user.is_admin || (user.addons || []).includes('ai_pack')
    if (!premium) return json({ error: 'Premium feature' }, 402)
    if (!rateLimit(user.id, 10)) return json({ error: 'Rate limit exceeded, try again in a minute' }, 429)
    const { walls, cameras, objects } = await request.json()

    // The model answers with positions inside the rooms it was shown; every one of
    // them is validated and rebuilt as a camera in api/ai.js. When it cannot be
    // used — no GOOGLE_API_KEY, a quota error, a retired model, a reply with
    // nothing placeable — this falls back to the geometry solver rather than
    // failing, and says which one answered so the app can show it.
    const ai = await suggestSpotsWithModel(env, { walls: walls || [], cameras: cameras || [], objects: objects || [] })
    if (ai) return json({ ...ai, source: 'model' })
    return json({ spots: suggestSpots(walls || [], cameras || []), source: 'solver' })
  }

  // ── Analytics ──────────────────────────────────────────────────────────────
  // The browser keeps its own event log for the admin panel; counting the journey
  // events here is what makes the numbers cover *every* visitor instead of the one
  // person looking at the panel. Only the allow-listed names are counted, and always
  // as a per-day total, so a caller cannot turn this into a write amplifier.
  if (path === '/analytics' && method === 'POST') {
    const { event } = await request.json().catch(() => ({}))
    if (typeof event !== 'string' || !event) return json({ error: 'An event name is required' }, 400)
    const counted = FUNNEL_EVENTS.has(event) ? await countFunnelEvent(event).catch(() => false) : false
    return json({ ok: true, counted })
  }

  // ── Client errors ──────────────────────────────────────────────────────────
  // An uncaught error in a visitor's browser is otherwise invisible: it reaches the
  // console of somebody you will never hear from. Unauthenticated on purpose — the
  // errors that matter happen on the sign-in screen too — so it is rate limited by
  // address, and one signature is written at most every few minutes.
  if (path === '/report-error' && method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown'
    if (!rateLimit(`err:${ip}`, 20)) return json({ ok: false }, 429)
    const body = await request.json().catch(() => ({}))
    // The server's own log comes first, so a report is visible in `wrangler tail`
    // and the dashboard even if the store is unreachable.
    console.error('[client-error]', JSON.stringify({ message: body?.message, where: body?.path }).slice(0, 600))
    const stored = await recordClientError(body).catch(() => false)
    return json({ ok: true, stored })
  }

  // ── Admin ──────────────────────────────────────────────────────────────────
  if (path === '/admin/users' && method === 'GET') {
    const user = await authUser(request)
    if (!user?.is_admin) return json({ error: 'Forbidden' }, 403)
    const rows = await listUsers()
    return json(rows.map((row) => ({
      id: row.id, email: row.email, name: row.name, plan: row.plan,
      addons: row.addons || [], isAdmin: !!row.is_admin, createdAt: row.created_at,
    })))
  }
  // What every visitor did, and what broke for them. The admin panel is the only
  // reader; there is no public route to either number.
  if (path === '/admin/stats' && method === 'GET') {
    const admin = await authUser(request)
    if (!admin) return json({ error: 'Unauthorised' }, 401)
    if (!admin.is_admin) return json({ error: 'Forbidden' }, 403)
    const funnel = {}
    for (let i = 0; i < 7; i++) {
      const day = utcDay(i)
      const counts = await readJson(`stats:${day}`)
      if (counts) funnel[day] = counts
    }
    const errors = Object.values((await readJson(ERROR_LIST_KEY)) || {})
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
    return json({ funnel, errors, ceiling: FUNNEL_DAY_CEILING })
  }
  if (path === '/admin/set-plan' && method === 'POST') {
    const admin = await authUser(request)
    if (!admin?.is_admin) return json({ error: 'Forbidden' }, 403)
    const { userId, plan } = await request.json()
    const account = await findAccount(userId)
    if (!account) return json({ error: 'No such account' }, 404)
    const row = await saveUser({ email: account.email, plan })
    return json(publicRow(row))
  }
  if (path === '/admin/flag' && method === 'POST') {
    const admin = await authUser(request)
    if (!admin?.is_admin) return json({ error: 'Forbidden' }, 403)
    const { flag, enabled } = await request.json()
    await setFlag(flag, enabled)
    return json({ ok: true, flag, enabled: Boolean(enabled) })
  }

  return json({ error: 'Not found' }, 404)
}

/** Any unhandled failure answers with its message rather than an opaque 500. */
async function dispatch(request, env) {
  try {
    return await handle(request, env)
  } catch (err) {
    globalThis.env = globalThis.env || env
    return json({ error: err?.message || 'Server error' }, 500)
  }
}

// Last-resort geometry, used only when no model could answer: opposite corners of each
// room, aiming at its middle. Distances are given in metres and converted, so this
// stays correct at whatever scale the editor draws at (see api/ai.js).
function suggestSpots(walls, cameras) {
  const spots = []
  const inset = 0.2 * PIXELS_PER_METER
  const minApart = 3 * PIXELS_PER_METER
  for (const wall of walls.filter((w) => w.closed !== false && w.points.length >= 3)) {
    const xs = wall.points.map((p) => p.x), ys = wall.points.map((p) => p.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
    for (const [x, y] of [[minX + inset, minY + inset], [maxX - inset, maxY - inset]]) {
      if ([...cameras, ...spots].some((c) => Math.hypot(c.x - x, c.y - y) < minApart)) continue
      const diagonal = Math.hypot(maxX - minX, maxY - minY)
      spots.push({
        id: `ai_${crypto.randomUUID().slice(0, 8)}`,
        x, y,
        rotation: Math.round((Math.atan2((minY + maxY) / 2 - y, (minX + maxX) / 2 - x) * 180) / Math.PI),
        hFov: 120,
        distance: Math.min(40, Math.max(2, Math.round(diagonal / 2 / PIXELS_PER_METER + 1))),
        color: '#38bdf8',
        label: `AI Cam ${spots.length + 1}`,
      })
    }
  }
  return spots
}

export default { fetch: dispatch }
export { dispatch as handle }
