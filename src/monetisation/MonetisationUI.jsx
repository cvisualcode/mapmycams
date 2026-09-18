// ─── Monetisation UI ─────────────────────────────────────────────────────────
// Login screen, dashboard, pricing page, upgrade modal, padlock chip and the
// admin panel. All styled with the app's existing dark-slate CSS system.

import { useEffect, useState } from 'react'
import { useEntitlements } from './EntitlementsContext'
import { PLANS, ADDONS, formatPrice } from './plans'
import * as api from './api'

/** Small padlock used to mark gated UI. */
export function Padlock() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true" style={{ verticalAlign: '-2px' }}>
      <path d="M4 7V5a4 4 0 0 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5A1.5 1.5 0 0 1 12.5 15h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4Zm2 0h4V5a2 2 0 0 0-4 0v2Z" />
    </svg>
  )
}

// ─── Login screen ────────────────────────────────────────────────────────────

export function LoginScreen() {
  const ent = useEntitlements()
  const [tab, setTab] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  // Empty unless this browser is refusing to store data — see api.storageNotice().
  const storageWarning = api.storageNotice()

  /** Sign in, or create an account, with email + password. */
  async function submit(e) {
    e.preventDefault()
    setError(''); setNotice(''); setBusy(true)
    try {
      const res = tab === 'login'
        ? await ent.login(email, password)
        : await ent.signup(email, password, name)
      api.track('auth_view', { tab })
      setPassword('')
      // Unverified: AppShell swaps in the code screen, so nothing to announce.
      if (res?.pendingVerification) return
      if (tab === 'signup' && res?.name) setNotice(`Account created — welcome, ${res.name}.`)
    } catch (err) {
      setError(err.message || 'Something went wrong')
    } finally { setBusy(false) }
  }

  async function demoAdmin() {
    setError(''); setNotice(''); setBusy(true)
    try { await ent.login('Admin', 'Admin1') } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand"><span className="auth-logo">▲</span> MapMyCams</div>
        <h1>{tab === 'login' ? 'Welcome back' : 'Create your account'}</h1>
        <p className="auth-sub">{tab === 'login' ? 'Sign in to sync your floorplans and manage your subscription.' : 'Start on the Free tier — upgrade any time.'}</p>

        {storageWarning && <div className="auth-warn">⚠ {storageWarning}</div>}

        <form onSubmit={submit}>
          {tab === 'signup' && (
            <input className="auth-input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          )}
          <input className="auth-input" placeholder={tab === 'signup' ? 'Email address' : 'Email or username'} type={tab === 'signup' ? 'email' : 'text'} value={email} onChange={(e) => setEmail(e.target.value)} required />
          <div className="auth-pass">
            <input
              className="auth-input"
              placeholder="Password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
              required
            />
            <button type="button" className="auth-eye" onClick={() => setShowPassword((v) => !v)} title={showPassword ? 'Hide password' : 'Show password'}>
              {showPassword ? '🙈' : '👁'}
            </button>
          </div>
          {tab === 'signup' && <PasswordChecklist password={password} />}
          {error && <div className="auth-error">{error}</div>}
          {notice && <div className="auth-notice">{notice}</div>}
          <button className="auth-btn" disabled={busy}>{busy ? 'Please wait…' : tab === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>

        <button className="auth-admin" onClick={demoAdmin} title="Pre-built full-access admin account — Admin / Admin1">
          ⭐ Sign in as Admin (Admin / Admin1)
        </button>

        <p className="auth-switch">
          {tab === 'login' ? (
            <>New here? <button onClick={() => { setTab('signup'); setError('') }}>Create an account</button></>
          ) : (
            <>Already registered? <button onClick={() => { setTab('login'); setError('') }}>Sign in</button></>
          )}
        </p>
        <p className="auth-legal">
          Passwords are never stored — they are salted and hashed with PBKDF2-SHA256 (210,000 iterations), and your
          session is a short-lived token rather than a stored login. Repeated failed attempts lock the account for
          15 minutes. See the GDPR note in your dashboard.
        </p>
      </div>
    </div>
  )
}

// ─── Signup password requirements ────────────────────────────────────────────

const PASSWORD_RULES = [
  { label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { label: 'Contains a letter', test: (p) => /[A-Za-z]/.test(p) },
  { label: 'Contains a number', test: (p) => /[0-9]/.test(p) },
]

/** Live checklist shown while choosing a password, matching api.passwordProblem(). */
function PasswordChecklist({ password }) {
  return (
    <ul className="auth-rules">
      {PASSWORD_RULES.map((r) => (
        <li key={r.label} className={r.test(password) ? 'met' : ''}>
          {r.test(password) ? '✓' : '•'} {r.label}
        </li>
      ))}
    </ul>
  )
}

// ─── Email verification screen ───────────────────────────────────────────────
// Shown after "Create account", and after signing in with an address that was
// never verified. No session exists yet, so the planner and every other route
// are unreachable from here — the only way forward is the emailed code.

export function VerifyEmailScreen({ email, devCode, deliveryError, onSubmit, onResend, onCancel }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [cooldown, setCooldown] = useState(0)

  // Tick the resend countdown so the button mirrors the server-side cooldown.
  useEffect(() => {
    if (cooldown <= 0) return undefined
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  async function submit(e) {
    e.preventDefault()
    setError(''); setNotice(''); setBusy(true)
    try {
      await onSubmit(code)
    } catch (err) {
      setError(err.message || 'That code is not correct')
      setBusy(false)
    }
  }

  async function resend() {
    setError(''); setNotice(''); setBusy(true)
    try {
      const res = await onResend()
      setCooldown(60)
      setNotice(res?.devCode
        ? 'A new code was generated below.'
        : `A new code is on its way to ${email}.`)
    } catch (err) {
      setError(err.message || 'Could not send another code')
    } finally { setBusy(false) }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand"><span className="auth-logo">▲</span> MapMyCams</div>
        <h1>Verify your email</h1>
        <p className="auth-sub">
          We sent a 6-digit code to <strong>{email}</strong>. Enter it below to finish setting up your account.
        </p>

        <form onSubmit={submit}>
          <input
            className="auth-input auth-code"
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="6-digit verification code"
            autoFocus
          />
          {error && <div className="auth-error">{error}</div>}
          {notice && <div className="auth-notice">{notice}</div>}
          {devCode && (
            <div className="auth-warn">
              ⚠ We couldn’t email the code{deliveryError ? ` (${deliveryError})` : ''}, so here it is instead.
              <strong className="auth-code-inline">{devCode}</strong>
              Set <code>RESEND_API_KEY</code> and <code>EMAIL_FROM</code> on the server to have it sent for real.
            </div>
          )}
          <button className="auth-btn" disabled={busy || code.length !== 6}>
            {busy ? 'Verifying…' : 'Verify and continue'}
          </button>
        </form>

        <button className="auth-admin" onClick={resend} disabled={busy || cooldown > 0}>
          {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend the code'}
        </button>

        <p className="auth-switch">
          Wrong address? <button onClick={onCancel}>Use a different email</button>
        </p>
        <p className="auth-legal">
          The planner stays locked until your email is verified. Codes expire after 10 minutes and stop working after
          5 incorrect attempts.
        </p>
      </div>
    </div>
  )
}

// ─── Upgrade modal ───────────────────────────────────────────────────────────

export function UpgradeModal() {
  const ent = useEntitlements()
  if (!ent.upgrade) return null
  const { title, reason } = ent.upgrade
  const monthly = PLANS.find((p) => p.key === 'premium_monthly')
  return (
    <div className="modal-backdrop" onClick={ent.closeUpgrade}>
      <div className="modal upgrade-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={ent.closeUpgrade}>✕</button>
        <div className="upgrade-padlock"><Padlock /></div>
        <h2>{title}</h2>
        <p className="upgrade-reason">{reason}</p>
        <ul className="upgrade-list">
          {monthly.features.slice(0, 5).map((f) => <li key={f}>{f}</li>)}
        </ul>
        <div className="upgrade-price">{formatPrice(monthly.price)}<span>/{monthly.period}</span></div>
        <button className="btn-primary" onClick={() => ent.startCheckout('premium_monthly', 'plan').then(ent.closeUpgrade)}>Upgrade now</button>
        <button className="btn-ghost" onClick={ent.closeUpgrade}>Maybe later</button>
      </div>
    </div>
  )
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export function Dashboard({ onOpenPlan, onNewPlan, onOpenEditor, onPricing }) {
  const ent = useEntitlements()
  const [billing, setBilling] = useState([])
  const [twoFA, setTwoFA] = useState(false)

  useEffect(() => {
    api.getBilling().then(setBilling).catch(() => setBilling([]))
    if (ent.user?.twoFA) setTwoFA(true)
  }, [ent.user?.plan, ent.user?.addons?.length])

  const planLabel = ent.user?.isAdmin ? 'Admin (full access)' : ent.isPremium ? 'Premium — ' + ent.user.plan.replace('premium_', '') : 'Free'

  return (
    <div className="dashboard">
      <header className="dash-header">
        <div className="auth-brand"><span className="auth-logo">▲</span> MapMyCams</div>
        <nav className="dash-nav">
          <button className="btn-ghost" onClick={onOpenEditor}>Open planner</button>
          <button className="btn-ghost" onClick={onNewPlan}>New floorplan</button>
          <span className="plan-chip">{planLabel}</span>
          <button className="btn-ghost" onClick={ent.logout}>Sign out</button>
        </nav>
      </header>

      <div className="dash-grid">
        {ent.checkoutNotice && (
          <div className={`checkout-notice ${ent.checkoutNotice}`}>
            <span>
              {ent.checkoutNotice === 'success' && '✓ Payment received — your plan is unlocked.'}
              {ent.checkoutNotice === 'pending' && 'Payment received. Stripe is still confirming it, so your plan will update in a moment.'}
              {ent.checkoutNotice === 'cancelled' && 'Checkout cancelled — nothing was charged.'}
              {ent.checkoutNotice === 'error' && 'We could not confirm that checkout. If you were charged, refresh in a moment or open the billing portal.'}
            </span>
            <button className="checkout-notice-close" onClick={ent.dismissCheckoutNotice}>✕</button>
          </div>
        )}
        <section className="dash-card">
          <h3>Your floorplans</h3>
          <p className="spec-hint">{ent.limits.floorplans === Infinity ? 'Unlimited' : `${ent.floorplans.length} of ${ent.limits.floorplans} saved (Free tier)`}</p>
          <div className="fp-list">
            {ent.floorplans.length === 0 && <p className="spec-hint">No saved floorplans yet.</p>}
            {ent.floorplans.map((f) => (
              <div className="fp-row" key={f.id}>
                <span className="fp-name">{f.name || 'Untitled plan'}</span>
                <span className="fp-date">{new Date(f.updated).toLocaleDateString()}</span>
                <button onClick={() => onOpenPlan(f)}>Open</button>
                <button className="danger" onClick={() => ent.deleteFloorplan(f.id)}>Delete</button>
              </div>
            ))}
          </div>
          <button className="btn-primary" onClick={onNewPlan}>+ New floorplan</button>
        </section>

        <section className="dash-card">
          <h3>Subscription</h3>
          <div className="sub-status">{planLabel}</div>
          {ent.isPremium ? (
            <>
              <p className="spec-hint">Manage payment methods, invoices and cancellation in the billing portal.</p>
              <button className="btn-primary" onClick={() => api.openBillingPortal()}>Open billing portal</button>
              <button className="btn-ghost" onClick={async () => {
                // A real subscription is cancelled at Stripe: the portal is the only
                // place that stops the payments as well as the access.
                const portal = await api.openBillingPortal()
                if (portal?.redirecting) return
                await api.cancelSubscription()
                window.location.reload()
              }}>Cancel subscription</button>
            </>
          ) : (
            <>
              <p className="spec-hint">Unlock unlimited floorplans, AI placement, watermark-free exports and more.</p>
              <button className="btn-primary" onClick={onPricing}>See plans</button>
            </>
          )}
          <h3 style={{ marginTop: 20 }}>Billing history</h3>
          {billing.length === 0 && <p className="spec-hint">No invoices yet.</p>}
          {billing.map((b) => (
            <div className="fp-row" key={b.id}>
              <span>{b.item}</span><span>{b.kind}</span><span>{b.status}</span><span>{new Date(b.date).toLocaleDateString()}</span>
            </div>
          ))}
        </section>

        <section className="dash-card">
          <h3>Account &amp; privacy</h3>
          <p className="spec-hint">Signed in as <strong>{ent.user?.identifier}</strong></p>
          <label className="check-row">
            <input type="checkbox" checked={twoFA} onChange={async () => setTwoFA(await api.toggle2FA())} />
            Two-factor authentication (email codes)
          </label>
          <p className="spec-hint">GDPR: your floorplans are stored encrypted at rest. You can request full deletion at any time — deleting a plan removes it permanently.</p>
          <h3 style={{ marginTop: 20 }}>Add-ons</h3>
          {ADDONS.map((a) => {
            const owned = (ent.user?.addons || []).includes(a.key)
            return (
              <div className="fp-row" key={a.key}>
                <span>{a.name}</span><span>{formatPrice(a.price)}</span>
                {owned ? <span className="plan-chip">Owned</span> : <button onClick={() => ent.startCheckout(a.key, 'addon')}>Buy</button>}
              </div>
            )
          })}
        </section>
      </div>
    </div>
  )
}

// ─── Pricing page ────────────────────────────────────────────────────────────

export function PricingPage({ onBack }) {
  const ent = useEntitlements()
  return (
    <div className="pricing-page">
      <header className="dash-header">
        <div className="auth-brand"><span className="auth-logo">▲</span> MapMyCams</div>
        <button className="btn-ghost" onClick={onBack}>← Back</button>
      </header>
      <h1>Plans &amp; pricing</h1>
      <div className="pricing-grid">
        {PLANS.map((p) => (
          <div className={`price-card${p.highlight ? ' highlighted' : ''}`} key={p.key}>
            {p.highlight && <div className="price-flag">Most popular</div>}
            <h2>{p.name}</h2>
            <div className="price-big">{formatPrice(p.price)}<span>/{p.period}</span></div>
            <p className="spec-hint">{p.blurb}</p>
            <ul>{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
            <button
              className="btn-primary"
              onClick={() => ent.startCheckout(p.key, 'plan')}
            >
              {p.price === 0 ? 'Current (Free)' : `Choose ${p.name}`}
            </button>
          </div>
        ))}
      </div>
      <h2 style={{ textAlign: 'center', marginTop: 32 }}>One-time add-ons</h2>
      <div className="addons-grid">
        {ADDONS.map((a) => (
          <div className="price-card addon" key={a.key}>
            <h2>{a.name}</h2>
            <div className="price-big">{formatPrice(a.price)}<span> once</span></div>
            <p className="spec-hint">{a.blurb}</p>
            <button className="btn-primary" onClick={() => ent.startCheckout(a.key, 'addon')}>Buy add-on</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Admin panel ─────────────────────────────────────────────────────────────

export function AdminPanel({ onBack }) {
  const ent = useEntitlements()
  const [users, setUsers] = useState([])
  const [analytics, setAnalytics] = useState(null)
  const [announcement, setAnnouncement] = useState('')
  const [flags, setFlags] = useState(api.getFlags())

  useState(() => {
    api.adminListUsers().then(setUsers).catch(() => {})
    setAnalytics(api.getAnalyticsSnapshot())
  })

  if (!ent.user?.isAdmin) {
    return <div className="dashboard"><p className="spec-hint">Admin access required.</p><button className="btn-ghost" onClick={onBack}>← Back</button></div>
  }

  return (
    <div className="dashboard">
      <header className="dash-header">
        <div className="auth-brand"><span className="auth-logo">▲</span> Admin panel</div>
        <button className="btn-ghost" onClick={onBack}>← Back</button>
      </header>
      <div className="dash-grid">
        <section className="dash-card">
          <h3>Analytics</h3>
          {analytics && (
            <div className="stat-grid">
              <div className="stat"><span>{analytics.conversion}%</span><label>Checkout conversion</label></div>
              <div className="stat"><span>{analytics.triggers}</span><label>Upgrade prompts shown</label></div>
              <div className="stat"><span>{analytics.total}</span><label>Total events</label></div>
            </div>
          )}
          {analytics && (
            <div className="fp-list">
              {Object.entries(analytics.byEvent).slice(0, 8).map(([ev, n]) => (
                <div className="fp-row" key={ev}><span>{ev}</span><span>{n}</span></div>
              ))}
            </div>
          )}
        </section>
        <section className="dash-card">
          <h3>Users</h3>
          {users.map((u) => (
            <div className="fp-row" key={u.id}>
              <span>{u.identifier}{u.isAdmin ? ' ★' : ''}</span>
              <select value={u.plan} onChange={(e) => api.adminSetPlan(u.id, e.target.value).then(() => api.adminListUsers().then(setUsers))}>
                {PLANS.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
              </select>
            </div>
          ))}
        </section>
        <section className="dash-card">
          <h3>Announcements</h3>
          <textarea className="auth-input" rows="3" placeholder="Message shown to users on next load…" value={announcement} onChange={(e) => setAnnouncement(e.target.value)} />
          <button className="btn-primary" onClick={() => { window.localStorage.setItem('mmc_announcement', announcement); alert('Announcement saved') }}>Push announcement</button>
          <h3 style={{ marginTop: 20 }}>Feature flags</h3>
          {['ai', 'shareLinks', 'premiumBrands', 'healthScore'].map((f) => (
            <label className="check-row" key={f}>
              <input type="checkbox" checked={!!flags[f]} onChange={(e) => api.adminSetFlag(f, e.target.checked).then(setFlags)} />
              {f}
            </label>
          ))}
        </section>
      </div>
    </div>
  )
}
