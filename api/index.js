// ─── API endpoints (serverless handler) ──────────────────────────────────────
// Mount as a Cloudflare Worker module or Node serverless catch-all.
// Routes:
//   POST /auth/signup | /auth/verify | /auth/resend | /auth/login | /auth/logout
//   POST /auth/send-code  (mailer only — for browsers with no server session)
//   GET  /me
//   GET/POST/DELETE /floorplans(/:id)
//   POST /billing/checkout | /billing/portal | /billing/cancel
//   POST /webhooks/stripe
//   POST /ai/suggest  (rate-limited, premium only)
//   POST /analytics
//   GET  /admin/users | POST /admin/set-plan | POST /admin/flag
//
// Accounts, floorplans and flags live in Cloudflare KV (api/_lib.js). Passwords
// arrive already stretched by the browser, so this process never sees one.

import {
  signToken, verifyToken, hashPassword, verifyPassword,
  getUser, listUsers, saveUser, listFloorplans, saveFloorplan, deleteFloorplan, setFlag,
  stripeCheckoutSession, stripePortalSession, verifyStripeSignature, stripeConfigured,
  generateVerificationCode, hashCode, verifyCode, credentialProblem, sendVerificationEmail,
  emailConfigured, resendCooldownRemaining, CODE_TTL_MS, CODE_MAX_ATTEMPTS,
  json, cors, rateLimit,
} from './_lib.js'

// Stripe price IDs come from env: PRICE_PREMIUM_MONTHLY, PRICE_PREMIUM_YEARLY,
// PRICE_AI_PACK, PRICE_PDF_REPORT, PRICE_FAMILY, PRICE_BRANDS.
const PRICE_MAP = () => ({
  premium_monthly: { price: globalThis.env.PRICE_PREMIUM_MONTHLY, mode: 'subscription' },
  premium_yearly: { price: globalThis.env.PRICE_PREMIUM_YEARLY, mode: 'subscription' },
  ai_pack: { price: globalThis.env.PRICE_AI_PACK, mode: 'payment' },
  pdf_report: { price: globalThis.env.PRICE_PDF_REPORT, mode: 'payment' },
  family: { price: globalThis.env.PRICE_FAMILY, mode: 'payment' },
  brands: { price: globalThis.env.PRICE_BRANDS, mode: 'payment' },
})

/** The one-off add-ons, used when there are no Stripe prices to read a mode from. */
const ADDON_ITEMS = ['ai_pack', 'pdf_report', 'family', 'brands']

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

/** The signed-in account, or null. */
async function authUser(request) {
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '')
  const claims = token && await verifyToken(token)
  if (!claims) return null
  const user = await getUser(claims.email)
  return user && user.id === claims.id ? user : null
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
    const { email, code, name } = await request.json().catch(() => ({}))
    const to = String(email || '').trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(to)) return json({ sent: false, error: 'A valid email address is required' }, 400)
    if (!/^\d{6}$/.test(String(code || ''))) return json({ sent: false, error: 'A 6-digit code is required' }, 400)
    try {
      await sendVerificationEmail(to, String(code), name)
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

    // Without Stripe keys there is nothing to charge, so grant the entitlement the
    // way the browser-only build does. This keeps the pricing flow demonstrable and
    // switches itself off the moment a real secret key is set.
    if (!stripeConfigured() || !entry.price) {
      const patch = ADDON_ITEMS.includes(item)
        ? { email: user.email, addons: [...new Set([...(user.addons || []), item])] }
        : { email: user.email, plan: item }
      const row = await saveUser(patch)
      return json({ demo: true, user: publicRow(row) })
    }

    const session = await stripeCheckoutSession({ priceId: entry.price, userId: user.id, email: user.email, mode: entry.mode })
    return json({ url: session.url })
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
    // Cancellation happens in the Stripe billing portal; here we just flag it.
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
      if (account) {
        if (s.mode === 'subscription') {
          await saveUser({ email: account.email, plan: s.metadata?.plan || 'premium_monthly', stripe_customer_id: s.customer })
        } else {
          const addons = new Set([...(account.addons || []), s.metadata?.addon].filter(Boolean))
          await saveUser({ email: account.email, addons: [...addons], stripe_customer_id: s.customer })
        }
      }
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
    const { walls, cameras } = await request.json()
    // Server-side mirror of the client heuristic — kept simple on purpose.
    return json({ spots: suggestSpots(walls || [], cameras || []) })
  }

  // ── Analytics ──────────────────────────────────────────────────────────────
  // Accepted and acknowledged but not stored: the browser keeps its own event log
  // for the admin panel, and nothing unauthenticated gets to spend the KV write
  // budget that sign-in needs.
  if (path === '/analytics' && method === 'POST') {
    const { event } = await request.json().catch(() => ({}))
    if (typeof event !== 'string' || !event) return json({ error: 'An event name is required' }, 400)
    return json({ ok: true })
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

function suggestSpots(walls, cameras) {
  const spots = []
  for (const wall of walls.filter((w) => w.closed !== false && w.points.length >= 3)) {
    const xs = wall.points.map((p) => p.x), ys = wall.points.map((p) => p.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
    for (const [x, y] of [[minX + 8, minY + 8], [maxX - 8, maxY - 8]]) {
      if ([...cameras, ...spots].some((c) => Math.hypot(c.x - x, c.y - y) < 120)) continue
      spots.push({ x, y, rotation: (Math.atan2((minY + maxY) / 2 - y, (minX + maxX) / 2 - x) * 180) / Math.PI, hFov: 120, distance: Math.hypot(maxX - minX, maxY - minY) / 2 + 40, label: 'AI Cam' })
    }
  }
  return spots
}

export default { fetch: dispatch }
export { dispatch as handle }
