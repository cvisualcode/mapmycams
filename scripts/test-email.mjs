// ─── Send one real verification email ────────────────────────────────────────
// Proves the Resend key, the verified sending domain and the DNS records
// (SPF/DKIM) actually work, without deploying anything.
//
//   1. Add RESEND_API_KEY and EMAIL_FROM in Settings → Environment
//   2. bun run email:test you@yourdomain.com
//
// Env comes from .env.local / .env, which this workspace loads automatically.

import { verificationEmail } from '../api/email-template.js'

const apiKey = process.env.RESEND_API_KEY
const from = process.env.EMAIL_FROM
const to = process.argv[2] || process.env.TEST_RECIPIENT
const code = String(Math.floor(100000 + Math.random() * 900000))

if (!apiKey) {
  console.error('✗ RESEND_API_KEY is not set.\n  Add it in Settings → Environment (it is a server secret, so no VITE_ prefix).')
  process.exit(1)
}
if (!from) {
  console.error('✗ EMAIL_FROM is not set.\n  It must be an address at the domain you verified in Resend, e.g.\n  EMAIL_FROM=MapMyCams <noreply@yourdomain.com>')
  process.exit(1)
}
if (!to) {
  console.error('✗ No recipient.\n  Usage: bun run email:test you@yourdomain.com')
  process.exit(1)
}

const { subject, text, html } = verificationEmail(code, 'there')

console.log(`Sending to ${to}\nFrom:     ${from}\nSubject:  ${subject}\nCode:     ${code}\n`)

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ from, to: [to], subject, text, html }),
})

const body = await res.json().catch(() => ({}))

if (!res.ok) {
  console.error(`✗ Resend rejected the send (HTTP ${res.status})`)
  console.error(JSON.stringify(body, null, 2))
  if (String(body.message || '').toLowerCase().includes('domain')) {
    console.error('\nThis usually means the sending domain is not verified yet:')
    console.error('  Resend → Domains → is it "Verified" (green)?')
    console.error('  The DNS records must show as verified — SPF and DKIM both.')
    console.error('  A brand-new domain can take up to ~48h to propagate; usually minutes.')
  }
  if (res.status === 401 || res.status === 403) {
    console.error('\nThis usually means the API key is wrong, or is not a sending key.')
  }
  process.exit(1)
}

console.log(`✓ Accepted by Resend (id ${body.id}).`)
console.log('  Check the inbox (and spam) for the code.')
console.log('  Delivery is asynchronous — if nothing arrives, look at Resend → Logs for the reason.')
