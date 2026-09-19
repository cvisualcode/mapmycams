// ─── App shell with monetisation flow ────────────────────────────────────────
// Wraps the floorplan editor with the account system, dashboard, pricing page
// and admin panel. Views: auth → dashboard ⇄ editor / pricing / admin.
// The editor itself lives in src/App.jsx and is mounted as <EditorApp />.

import { useEffect, useState } from 'react'
import { EntitlementsProvider, useEntitlements } from './monetisation/EntitlementsContext'
import { LoginScreen, VerifyEmailScreen, Dashboard, PricingPage, AdminPanel, UpgradeModal, CheckoutGate } from './monetisation/MonetisationUI'
import LandingPage from './monetisation/LandingPage'
import { visitorRoute } from './monetisation/routing'
import { buildFloorplanSnapshot } from './monetisation/snapshotBridge'
import { readSharedPlan } from './monetisation/share'
import EditorApp from './App.jsx'

function MonetisedApp() {
  const ent = useEntitlements()
  const [view, setView] = useState('dashboard') // dashboard | editor | pricing | admin
  const [loadedPlan, setLoadedPlan] = useState(null)
  // null while the public home page is showing; 'login' / 'signup' once the
  // visitor has chosen a way in. Signed-out visitors land on the home page, not
  // straight on a password form.
  const [authTab, setAuthTab] = useState(null)
  // The public home page, reachable from the dashboard header too.
  const [showHome, setShowHome] = useState(false)
  // A plan opened from a shared #plan=… link, edited as a copy of itself.
  const [sharedPlan, setSharedPlan] = useState(null)

  // Shared links are read once, on the way in. The fragment is cleared straight
  // away so a reload does not silently re-import it over the plan being worked on.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const snapshot = readSharedPlan(window.location.hash)
    if (!snapshot) return
    window.history.replaceState({}, '', window.location.pathname + window.location.search)
    setSharedPlan(snapshot)
    setView('editor')
  }, [])

  if (ent.loading) return <div className="auth-screen"><p>Loading…</p></div>

  // One decision, one place: verify the emailed code, sign in, or read the home
  // page. See monetisation/routing.js.
  const visitor = ent.user ? 'app' : visitorRoute(ent, authTab)
  // Half-registered account: the only reachable screen is the code entry.
  if (visitor === 'verify') {
    return (
      <VerifyEmailScreen
        email={ent.pendingEmail}
        devCode={ent.devCode}
        deliveryError={ent.deliveryError}
        onSubmit={ent.verifyEmail}
        onResend={ent.resendCode}
        onCancel={ent.cancelVerification}
      />
    )
  }
  if (visitor !== 'app') {
    return visitor === 'auth'
      ? <LoginScreen key={authTab} initialTab={authTab} onBack={() => setAuthTab(null)} />
      : <LandingPage onSignIn={() => setAuthTab('login')} onSignUp={() => setAuthTab('signup')} />
  }

  function openPlan(fp) {
    setSharedPlan(null)
    setLoadedPlan(fp)
    setView('editor')
  }

  function newPlan() {
    if (ent.limits.floorplans !== Infinity && ent.floorplans.length >= 1) {
      ent.promptUpgrade('Save more floorplans', 'Free tier stores 1 floorplan. Upgrade to Premium for unlimited layouts.', 'premium_monthly')
      return
    }
    setLoadedPlan(null)
    setSharedPlan(null)
    setView('editor')
  }

  /** Back into the app from the home page, straight into the planner. */
  function openPlanner() {
    setShowHome(false)
    setLoadedPlan(null)
    setView('editor')
  }

  function exitEditor() {
    const snapshot = buildFloorplanSnapshot()
    if (snapshot) {
      ent.saveFloorplan(loadedPlan ? loadedPlan.name : 'My floorplan', snapshot, loadedPlan ? loadedPlan.id : null).catch(() => {})
    }
    setSharedPlan(null)
    setView('dashboard')
  }

  // Both prompts have to be reachable from every view that can start a purchase:
  // the editor's premium tools open the upgrade modal, and every Buy button can
  // land on the account gate — including the one inside the upgrade modal itself.
  const overlays = (
    <>
      <UpgradeModal />
      <CheckoutGate />
    </>
  )

  if (view === 'editor') {
    return (
      <>
        <EditorApp
          // Remounting is what gives the editor new starting state, since the
          // snapshot is only read when it mounts. Without a key, opening a saved
          // plan from the dashboard left the editor empty.
          key={loadedPlan ? `plan-${loadedPlan.id}` : sharedPlan ? 'shared-plan' : 'new-plan'}
          initialSnapshot={sharedPlan || (loadedPlan ? loadedPlan.data : null)}
          onExit={exitEditor}
          showUpgrade={(title, reason, item) => ent.promptUpgrade(title, reason, item || 'premium_monthly')}
        />
        {overlays}
      </>
    )
  }
  // The home page is public: a signed-in customer can read it (and is offered a
  // way back into the planner instead of a sign-up button).
  if (showHome) {
    return <LandingPage signedIn onOpenApp={() => setShowHome(false)} onOpenPlanner={openPlanner} />
  }
  if (view === 'pricing') return <><PricingPage onBack={() => setView('dashboard')} />{overlays}</>
  if (view === 'admin') return <AdminPanel onBack={() => setView('dashboard')} />
  return (
    <>
      <Dashboard
        onOpenPlan={openPlan}
        onNewPlan={newPlan}
        onOpenEditor={openPlanner}
        onPricing={() => setView('pricing')}
        onHome={() => setShowHome(true)}
        onAdmin={() => setView('admin')}
      />
      {overlays}
    </>
  )
}

export default function AppShell() {
  return (
    <EntitlementsProvider>
      <MonetisedApp />
    </EntitlementsProvider>
  )
}
