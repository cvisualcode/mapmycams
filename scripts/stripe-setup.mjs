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

import { spawnSync } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

// Stripe classifies what it is selling, which is what decides the tax applied.
// Every price here is a plan or an add-on in the web app, so: SaaS, personal use.
// This is not optional on a new account — Managed Payments is on by default there,
// and without a tax code on each product Checkout is refused outright.
const TAX_CODE = 'txcd_10103000'

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

/**
 * Stripe encodes arrays as repeated indexed params (`enabled_events[0]=…`), which
 * URLSearchParams will not do on its own: handed an array it stringifies it into a
 * single comma-joined value, and Stripe then rejects the whole request.
 */
function encode(params) {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(params || {})) {
    if (Array.isArray(value)) value.forEach((item, i) => search.append(`${name}[${i}]`, String(item)))
    else if (value !== undefined && value !== null) search.append(name, String(value))
  }
  return search
}

/** One Stripe call. `get` builds a query string, otherwise the body is form-encoded. */
async function stripe(path, params, method = 'POST', { allow404 = false } = {}) {
  const query = method === 'GET' && params ? `?${encode(params)}` : ''
  const res = await fetch(`${STRIPE_API}/${path}${query}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : encode(params).toString(),
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
  if (existing) {
    // Repair a product made before its tax code was set (or set wrongly), which
    // would otherwise let the whole catalogue vanish from Checkout.
    if (existing.tax_code !== TAX_CODE) return stripe(`products/${existing.id}`, { tax_code: TAX_CODE })
    return existing
  }
  return stripe('products', {
    name: def.name,
    description: def.interval ? `MapMyCams Premium — billed per ${def.interval}` : 'One-time MapMyCams add-on',
    tax_code: TAX_CODE,
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

/**
 * The webhook endpoint the API verifies signatures against.
 *
 * Stripe hands back the signing secret exactly once, on create, and there is no
 * way to read or rotate it afterwards. So an endpoint that is already there is
 * replaced rather than reused: that is the only way to end up with a secret the
 * Worker can actually be given. Events for the few seconds in between are retried
 * by Stripe, so nothing is lost.
 */
async function ensureWebhook() {
  const url = `${APP_URL}/webhooks/stripe`
  const { data } = await stripe('webhook_endpoints', { limit: '100' }, 'GET')
  const existing = data.find((w) => w.url === url)
  // Create the replacement first, then drop the old one: an event landing in the
  // gap still reaches the endpoint that is definitely accepting deliveries.
  const created = await stripe('webhook_endpoints', {
    url,
    description: 'MapMyCams billing (Worker)',
    enabled_events: EVENTS,
  })
  if (existing) await stripe(`webhook_endpoints/${existing.id}`, null, 'DELETE')
  return { endpoint: created, secret: created.secret, created: true, replaced: Boolean(existing) }
}

/**
 * Hand the values to wrangler, which is what knows how to turn a set of secrets
 * into a deployed version. They go through a file in the system temp directory
 * rather than the command line, so nothing sensitive is ever printed or left in
 * shell history, and the file is deleted straight after.
 */
function setWorkerSecrets(values) {
  const file = join(tmpdir(), `mapmycams-stripe-secrets-${process.pid}.json`)
  writeFileSync(file, JSON.stringify(values), { mode: 0o600 })

  const attempt = () => {
    const bulk = runWrangler(['secret', 'bulk', file, '--name', WORKER])
    if (bulk && bulk.status === 0) return Object.keys(values)
    // Older wrangler, or one without `secret bulk`: a call per secret.
    const done = []
    for (const [name, value] of Object.entries(values)) {
      const res = runWrangler(['secret', 'put', name, '--name', WORKER], value)
      if (res && res.status === 0) done.push(name)
    }
    return done
  }

  try {
    let done = attempt()
    if (done.length !== Object.keys(values).length) {
      // Cloudflare refuses secret edits while an undeployed version is the latest
      // one; a plain deploy clears that state, after which the same edits apply.
      console.log('  · an undeployed version is in the way — deploying and retrying')
      runWrangler(['deploy'])
      done = attempt()
    }
    return done
  } finally {
    rmSync(file, { force: true })
  }
}

/** Run wrangler, preferring the package manager this project already uses. */
function runWrangler(args, stdin) {
  for (const [cmd, prefix] of [['bunx', []], ['npx', ['--no-install']]]) {
    const res = spawnSync(cmd, [...prefix, 'wrangler', ...args], {
      input: stdin ?? undefined,
      stdio: stdin === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    })
    if (res.error?.code === 'ENOENT') continue
    return res
  }
  return null
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
const { endpoint, secret, created, replaced } = await ensureWebhook()
console.log(`  ✓ ${endpoint.url} ${created ? (replaced ? '(recreated, so the signing secret is valid)' : '(created)') : '(registered)'}`)

console.log('\nWorker secrets')
const values = { ...prices, STRIPE_SECRET_KEY: key }
if (secret) values.STRIPE_WEBHOOK_SECRET = secret

const set = setWorkerSecrets(values)
for (const name of Object.keys(values)) console.log(`  ${set.includes(name) ? '✓' : '!'} ${name}`)
const missing = Object.keys(values).filter((n) => !set.includes(n))

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
