// ─── Public home page ────────────────────────────────────────────────────────
// What a visitor sees before they have an account: what the tool does, what the
// plans cost, and the two ways in (create an account, or sign in). The plan and
// add-on lists are read from the same catalogue the pricing page uses, so this
// page can never drift from what the tool actually unlocks.

import { useEffect } from 'react'
import { PLANS, ADDONS, formatPrice, limitsFor } from './plans'
import { track } from './api'

// The hero shot is served from /h.png rather than imported, so the same file can
// also be the social-preview image in index.html — a bundled URL is content-hashed
// and therefore no use to a crawler.

// A camera pointing at a room — used as the mark next to the wordmark and as the
// pattern for the feature cards.
function CamMark({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7.5 15.5 4l1.6 5.6L4.6 13.1 3 7.5Z" />
      <path d="M5.2 12.4 6 15.5" />
      <path d="M17.1 9.6 21 8.5" />
      <path d="M9 15.5h8m-8 0v4.2h8V15.5" />
    </svg>
  )
}

const FEATURES = [
  {
    title: 'Draw the plan in minutes',
    body: 'Drag out walls, close a room, drop in doors and windows. Every line is a real wall, so distances and coverage stay honest.',
    tier: 'Free',
    icon: <path d="M3 20V4h18v16H3Zm0-8h18M9 4v16" />,
  },
  {
    title: 'Real field-of-view cones',
    body: 'Cameras are placed from a catalogue with their actual lens and FOV, so what you see on screen is what the camera will see.',
    tier: 'Free',
    icon: <path d="M12 3 3 20h18L12 3Zm0 8v5" />,
  },
  {
    title: 'Blind spots, not guesswork',
    body: 'Unexposed floor is shaded as you build, so a gap behind the stairs is obvious before anything is ordered.',
    tier: 'Premium',
    icon: <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Zm10 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />,
  },
  {
    title: 'AI placement suggestions',
    body: 'Ask where the cameras should go and the planner proposes positions by room and entry point for you to accept or nudge.',
    tier: 'Premium',
    icon: <path d="M12 2v4m0 12v4M4.9 4.9l2.8 2.8m8.6 8.6 2.8 2.8M2 12h4m12 0h4M4.9 19.1l2.8-2.8m8.6-8.6 2.8-2.8" />,
  },
  {
    title: 'A security score with fixes',
    body: 'Coverage, entries, power and overlap are scored out of 100, and each one names the change that would improve it.',
    tier: 'Premium',
    icon: <path d="M4 20V10m5 10V5m5 15v-7m5 7V8" />,
  },
  {
    title: 'Exports you can hand over',
    body: 'Watermark-free PNG plans, a branded PDF report, cable routes back to a power point, and share links for the household.',
    tier: 'Premium',
    icon: <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" />,
  },
]

const STEPS = [
  { n: '1', title: 'Trace the house', body: 'Draw each room, or work floor by floor — ground, first, roof.' },
  { n: '2', title: 'Place your cameras', body: 'Pick models from the catalogue, or let AI suggest a layout.' },
  { n: '3', title: 'Check the coverage', body: 'Fix the blind spots and the score, then export the plan.' },
]

// `signedIn` swaps the way in for a way back: an existing customer browsing the
// home page should never be offered "create an account" again.
export default function LandingPage({ onSignIn, onSignUp, signedIn = false, onOpenApp, onOpenPlanner }) {
  // Signed in, the headline action opens the planner itself; the secondary one
  // goes back to the dashboard, so the two buttons are not the same journey.
  const start = signedIn ? onOpenPlanner : onSignUp
  // Read the catalogue rather than repeating its numbers in prose.
  const free = limitsFor('free')
  const monthly = PLANS.find((p) => p.key === 'premium_monthly') || PLANS.find((p) => p.price > 0)

  // Funnel: how many visitors reach the page, and which button they take out of
  // it. Recorded with the app's own event log (see api.track), which is what the
  // admin panel reads. Anonymous events are not stored server-side by design.
  useEffect(() => { track('landing_view', { signedIn }) }, [signedIn])
  function fire(target, section) {
    track('landing_cta', { target, section })
  }

  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-brand">
          <span className="landing-brand-mark"><CamMark size={20} /></span>
          <span>MapMyCams</span>
        </div>
        <nav className="landing-nav-links">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#pricing">Pricing</a>
        </nav>
        <div className="landing-nav-actions">
          {signedIn ? (
            <button className="landing-cta small" onClick={() => { fire('planner', 'nav'); start() }}>Open the planner</button>
          ) : (
            <>
              <button className="landing-link-btn" onClick={() => { fire('signin', 'nav'); onSignIn() }}>Sign in</button>
              <button className="landing-cta small" onClick={() => { fire('signup', 'nav'); onSignUp() }}>Start free</button>
            </>
          )}
        </div>
      </header>

      <section className="landing-hero">
        <div className="landing-hero-copy">
          <span className="landing-eyebrow">Security camera floor planner</span>
          <h1>Know what your cameras cover <em>before</em> you fit them.</h1>
          <p>
            MapMyCams turns a floorplan into a coverage plan. Draw your rooms, place the cameras you
            are actually considering, and see the field-of-view cones, the blind spots and the score
            they add up to — on screen, not on a ladder.
          </p>
          <div className="landing-hero-actions">
            <button className="landing-cta" onClick={() => { fire(signedIn ? 'planner' : 'signup', 'hero'); start() }}>{signedIn ? 'Open the planner' : 'Create a free account'}</button>
            {signedIn
              ? <button className="landing-cta ghost" onClick={() => { fire('dashboard', 'hero'); onOpenApp() }}>Back to dashboard</button>
              : <button className="landing-cta ghost" onClick={() => { fire('signin', 'hero'); onSignIn() }}>I already have one</button>}
          </div>
          <ul className="landing-trust">
            <li>
              Free tier: {free.floorplans} floorplan{free.floorplans === 1 ? '' : 's'}, up to {free.cameras} cameras
            </li>
            <li>No card needed to start</li>
            {monthly && <li>Premium from {formatPrice(monthly.price)}/month</li>}
          </ul>
        </div>

        <figure className="landing-shot">
          <div className="landing-shot-bar">
            <span /><span /><span />
            <em>mapmycams.dev — planner</em>
          </div>
          <img src="/h.png" alt="The MapMyCams planner showing a floorplan with camera coverage cones" />
          <figcaption>
            <span className="landing-chip">Coverage cones</span>
            <span className="landing-chip warn">Blind spots shaded</span>
            <span className="landing-chip ok">Score out of 100</span>
          </figcaption>
        </figure>
      </section>

      <section className="landing-features" id="features">
        <h2>Everything you need to plan a system you won&apos;t regret</h2>
        <p className="landing-sub">
          Built for the bit that usually goes wrong: choosing where cameras go and finding out
          afterwards that the driveway was never covered.
        </p>
        <p className="landing-note">
          Free includes {free.floorplans} floorplan{free.floorplans === 1 ? '' : 's'} and up to {free.cameras} cameras.
          {' '}Everything marked Premium needs Premium — or, for the AI tools and the report, a one-off add-on.
        </p>
        <div className="landing-grid">
          {FEATURES.map((f) => (
            <article className="landing-card" key={f.title}>
              <div className="landing-card-top">
                <span className="landing-card-icon">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {f.icon}
                  </svg>
                </span>
                <span className={`landing-tier${f.tier === 'Premium' ? ' premium' : ''}`}>{f.tier}</span>
              </div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-how" id="how">
        <h2>Three steps, one afternoon</h2>
        <div className="landing-steps">
          {STEPS.map((s) => (
            <div className="landing-step" key={s.n}>
              <span className="landing-step-n">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-pricing" id="pricing">
        <h2>Plans</h2>
        <p className="landing-sub">
          Start on Free. Upgrade when you want the AI placement, the score, the exports and
          unlimited plans. Billed securely by Stripe — cancel any time.
        </p>
        <div className="landing-price-grid">
          {PLANS.map((p) => (
            <article className={`landing-price ${p.highlight ? 'featured' : ''}`} key={p.key}>
              {p.highlight && <span className="landing-price-flag">Most popular</span>}
              <h3>{p.name}</h3>
              <p className="landing-price-big">
                {p.price === 0 ? 'Free' : formatPrice(p.price)}
                {p.price > 0 && <span>/{p.period === 'month' ? 'mo' : 'yr'}</span>}
              </p>
              <p className="landing-price-blurb">{p.blurb}</p>
              <ul>
                {p.features.map((f) => <li key={f}>{f}</li>)}
              </ul>
              {p.key === 'free'
                ? <button className="landing-cta ghost full" onClick={() => { fire(signedIn ? 'planner' : 'signup', `pricing_${p.key}`); start() }}>{signedIn ? 'Open the planner' : 'Start free'}</button>
                : <button className="landing-cta full" onClick={() => { fire(signedIn ? 'planner' : 'signup', `pricing_${p.key}`); start() }}>{signedIn ? 'Open the planner' : `Choose ${p.name}`}</button>}
            </article>
          ))}
        </div>

        <h3 className="landing-addon-head">One-off add-ons on the Free tier</h3>
        <div className="landing-addons">
          {ADDONS.map((a) => (
            <div className="landing-addon" key={a.key}>
              <strong>{a.name}</strong>
              <span>{formatPrice(a.price)} once</span>
              <p>{a.blurb}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-final">
        <h2>Plan it properly, once.</h2>
        <p>{signedIn ? 'Back to the planner, or read on for what the paid plans add.' : 'Create a free account and draw your first floorplan in a few minutes.'}</p>
        <button className="landing-cta" onClick={() => { fire(signedIn ? 'planner' : 'signup', 'final'); start() }}>{signedIn ? 'Open the planner' : 'Create a free account'}</button>
        {!signedIn && <button className="landing-link-btn" onClick={() => { fire('signin', 'final'); onSignIn() }}>or sign in</button>}
      </section>

      <footer className="landing-footer">
        <div className="landing-brand"><span className="landing-brand-mark"><CamMark size={18} /></span><span>MapMyCams</span></div>
        <p>
          Your floorplans are stored against your account and encrypted at rest. Payments and
          invoices are handled by Stripe; card details never reach this app.
        </p>
      </footer>
    </div>
  )
}
