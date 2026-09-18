// ─── Set Stripe up for the plans in src/monetisation/plans.js ────────────────
// Creates the products and prices the app charges for, registers the webhook
// endpoint the API listens on, and (when Cloudflare credentials are present)
// pushes every resulting secret straight onto the deployed Worker.
//
//   1. Add STRIPE_SECRET_KEY in Settings → Environment (sk_test_… while trying it
//      out, sk_live_… when you are ready to take real money).
//   2. bun run stripe:setup
//
// Everything it creates is idempotent: prices are found by lookup key and the
// webhook is matched by URL, so running it again after a change only creates what
// is actually missing. Secret values are never printed — only where they went.

const STRIPE_API = 'https://api.stripe.com/v1'
const WORKER = 'mapmycams'
const APP_URL = (process.env.APP_URL || 'https://mapmycams.dev').replace(/\/+$/, '')

// Mirrors the catalogue in src/monetisation/plans.js — the env var name is what
// api/index.js reads, so a rename here has to match there too.
const CATALOGUE = [
  { item: 'premium_monthly', env: 'PRICE_PREMIUM_MONTHLY', name: 'MapMyCams Premium (Monthly)', amount: 499, interval: 'month' },
  { item: 'premium_yearly', env: 'PRICE_PREMIUM_YEARLY', name: 'MapMyCams Premium (Yearly)', amount: 4900, interval: 'year' },
  { item: 'ai_pack', env: 'PRICE_AI_PACK', name: 'Advanced AI Analysis Pack', amount: 799 },
  { item: 'pdf_report', env: 'PRICE_PDF_REPORT', name: 'Professional PDF Report', amount: 499 },
  { item: 'family', env: 'PRICE_FAMILY', name: 'Family Sharing', amount: 299 },
  { item: 'brands', env: 'PRICE_BRANDS', name: 'Camera Brand Integration Pack', amount: 699 },
]

const EVENTS = ['checkout.session.completed', 'customer.subscription.deleted', 'customer.subscription.paused']

const key = process.env.STRIPE_SECRET_KEY
if (!key) {
  console.error('✗ STRIPE_SECRET_KEY is not set.')
  console.error('  Add it in Settings → Environment (it is a server secret, so no VITE_ prefix):')
  console.error('  https://dashboard.stripe.com/apikeys')
  process.exit(1)
}

const mode = key.startsWith('sk_live_') ? 'live' : key.startsWith('sk_test_') ? 'test' : 'unknown'
if (mode === 'unknown') {
  console.warn('! That key does not look like a Stripe secret key (sk_test_… / sk_live_…) — continuing anyway.')
}

/** One Stripe call. `get` builds a query string, otherwise the body is form-encoded. */
async function stripe(path, params, method = 'POST', { allow404 = false } = {}) {
  const query = method === 'GET' && params ? `?${new URLSearchParams(params)}` : ''
  const res = await fetch(`${STRIPE_API}/${path}${query}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : new URLSearchParams(params || {}).toString(),
  })
  if (!res.ok) {
    const body = await res.text()
    if (allow404 && res.status === 404) return null
    throw new Error(`Stripe ${method} ${path} → ${res.status}: ${body}`)
  }
  return res.json()
}

const money = (amount, currency = 'gbp') =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100)

/** The product for an item, created on first run and matched by metadata after. */
async function ensureProduct(def) {
  const { data } = await stripe('products', { active: 'true', limit: '100' }, 'GET')
  const existing = data.find((p) => p.metadata?.mmc_item === def.item)
  if (existing) return existing
  return stripe('products', {
    name: def.name,
    description: def.interval ? `MapMyCams Premium — billed per ${def.interval}` : 'One-time MapMyCams add-on',
    'metadata[mmc_item]': def.item,
  })
}

/** The price for an item, matched by lookup key so re-runs reuse it. */
async function ensurePrice(def, product) {
  const lookupKey = `mmc_${def.item}`
  const found = await stripe('prices', { 'lookup_keys[]': lookupKey, active: 'true', limit: '1' }, 'GET')
  const current = found.data?.[0]

  if (current && current.unit_amount === def.amount) return current

  // A price is immutable: a changed amount means a new price, and the lookup key
  // has to be released from the old one first (Stripe refuses to move it).
  if (current) {
    console.log(`  · ${def.item}: amount changed ${money(current.unit_amount)} → ${money(def.amount)}, creating a new price`)
    await stripe(`prices/${current.id}`, { lookup_key: '' })
  }

  const params = {
    product: product.id,
    currency: 'gbp',
    unit_amount: String(def.amount),
    lookup_key: lookupKey,
    nickname: def.interval ? `${def.name} — ${money(def.amount)}/${def.interval}` : `${def.name} — ${money(def.amount)} once`,
    'metadata[mmc_item]': def.item,
  }
  if (def.interval) params['recurring[interval]'] = def.interval
  return stripe('prices', params)
}

/** The webhook endpoint the API verifies signatures against. */
async function ensureWebhook() {
  const url = `${APP_URL}/webhooks/stripe`
  const { data } = await stripe('webhook_endpoints', { limit: '100' }, 'GET')
  const existing = data.find((w) => w.url === url)
  if (existing) {
    const missing = EVENTS.filter((e) => !(existing.enabled_events || []).includes(e) && !(existing.enabled_events || []).includes('*'))
    if (!missing.length) return { endpoint: existing, secret: null, created: false }
    const updated = await stripe(`webhook_endpoints/${existing.id}`, {
      'enabled_events[]': EVENTS,
    })
    return { endpoint: updated, secret: null, created: false, updated: true }
  }
  const created = await stripe('webhook_endpoints', {
    url,
    description: 'MapMyCams billing (Worker)',
    'enabled_events[]': EVENTS,
  })
  // The signing secret is returned exactly once, by this call.
  return { endpoint: created, secret: created.secret, created: true }
}

/** Put a secret on the deployed Worker, without it ever reaching this output. */
async function setWorkerSecret(name, value) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!account || !token) return false
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${WORKER}/secrets`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, text: value, type: 'secret_text' }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.success === false) {
    console.warn(`  ! could not set ${name} on the Worker: ${body.errors?.[0]?.message || res.status}`)
    return false
  }
  return true
}

console.log(`Stripe setup for ${APP_URL} (${mode} mode)\n`)

// Prove the key works (and which mode it is in) before creating anything.
const balance = await stripe('balance', null, 'GET')
const currency = balance.available?.[0]?.currency?.toUpperCase() || 'GBP'
console.log(`✓ Key accepted — account can hold ${currency}${mode === 'test' ? ', test mode (no real money)' : ''}\n`)

console.log('Products & prices')
const prices = {}
for (const def of CATALOGUE) {
  const product = await ensureProduct(def)
  const price = await ensurePrice(def, product)
  prices[def.env] = price.id
  console.log(`  ✓ ${def.item.padEnd(16)} ${money(price.unit_amount, price.currency)}${def.interval ? ` / ${def.interval}` : ' once'}  ${price.id}`)
}

console.log('\nWebhook')
const { endpoint, secret, created, updated } = await ensureWebhook()
console.log(`  ✓ ${endpoint.url}${created ? ' (created)' : updated ? ' (events updated)' : ' (already registered)'}`)
if (!created) {
  console.log('    Its signing secret cannot be read back — if it is not already set on the Worker,')
  console.log('    copy it from Stripe → Developers → Webhooks → the endpoint → Signing secret.')
}

console.log('\nWorker secrets')
const values = { ...prices }
if (secret) values.STRIPE_WEBHOOK_SECRET = secret
values.STRIPE_SECRET_KEY = key

const missing = []
for (const [name, value] of Object.entries(values)) {
  const ok = await setWorkerSecret(name, value)
  if (!ok) missing.push(name)
  else console.log(`  ✓ ${name}`)
}

if (missing.length) {
  console.log('\nThese still have to be set on the Worker — Cloudflare → Workers & Pages →')
  console.log('mapmycams → Settings → Variables and Secrets, or `bunx wrangler secret put NAME`:')
  for (const name of missing.filter((n) => prices[n])) console.log(`  ${name}=${prices[name]}`)
  if (missing.includes('STRIPE_WEBHOOK_SECRET')) {
    console.log('  STRIPE_WEBHOOK_SECRET=<whsec_… — Stripe → Developers → Webhooks → the endpoint → Signing secret>')
  }
  if (missing.includes('STRIPE_SECRET_KEY')) {
    console.log('  STRIPE_SECRET_KEY=<the key you added in Settings → Environment>')
  }
}

console.log('\nDone. Redeploy the Worker so the new bindings are live:')
console.log('  bunx wrangler deploy')
console.log(`\nThen buy something on ${APP_URL} — with a test key, card 4242 4242 4242 4242,`)
console.log('any future expiry and any CVC. Test payments appear in Stripe → Payments.')
