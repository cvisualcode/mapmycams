// ─── POST /auth/send-code (Cloudflare Pages Function) ────────────────────────
// Cloudflare Pages routes this by file path: functions/auth/send-code.js is
// served at https://mapmycams.dev/auth/send-code. Functions take precedence over
// static assets, so the SPA catch-all cannot swallow it.
//
// It emails the verification code the client generated. It needs NO database,
// which is what lets real email work while accounts are still stored locally —
// and keeping it here is what keeps RESEND_API_KEY out of the browser.
//
// Requires, in the Pages project (Settings → Variables and Secrets, Production):
//   RESEND_API_KEY   (secret)  — resend.com/api-keys
//   EMAIL_FROM       (text)    — e.g. MapMyCams <noreply@send.mapmycams.dev>
//
// The matching Worker route lives in api/index.js, so this works whether the
// domain is served by a Pages project or by a Worker with static assets.

import { verificationEmail } from '../../api/email-template.js'

const CORS = { 'Access-Control-Allow-Origin': '*' }

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } })

/** Reject calls from other sites, so this can't casually be used as a relay. */
function originAllowed(origin) {
  if (!origin) return true // same-origin fetches may omit it
  return /^https?:\/\/([a-z0-9-]+\.)?(mapmycams\.dev|mapmycams\.pages\.dev|localhost(:\d+)?)$/i.test(origin)
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: { ...CORS, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' },
  })
}

export async function onRequestPost({ request, env }) {
  if (!originAllowed(request.headers.get('Origin'))) {
    return json({ sent: false, error: 'Origin not allowed' }, 403)
  }

  const { email, code, name } = await request.json().catch(() => ({}))
  const to = String(email || '').trim().toLowerCase()
  if (!/^\S+@\S+\.\S+$/.test(to)) return json({ sent: false, error: 'A valid email address is required' }, 400)
  if (!/^\d{6}$/.test(String(code || ''))) return json({ sent: false, error: 'A 6-digit code is required' }, 400)

  // Name the missing variable explicitly — a generic failure here is the most
  // common reason email "doesn't work" and is invisible from the browser.
  if (!env.RESEND_API_KEY) return json({ sent: false, error: 'RESEND_API_KEY is not set on the Pages project' }, 502)
  if (!env.EMAIL_FROM) return json({ sent: false, error: 'EMAIL_FROM is not set on the Pages project' }, 502)

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], ...verificationEmail(code, name) }),
  })

  if (!res.ok) {
    return json({ sent: false, error: `Resend ${res.status}: ${await res.text()}` }, 502)
  }
  return json({ sent: true })
}
