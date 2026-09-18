// ─── App shell with monetisation flow ────────────────────────────────────────
// Wraps the floorplan editor with the account system, dashboard, pricing page
// and admin panel. Views: auth → dashboard ⇄ editor / pricing / admin.
// The editor itself lives in src/App.jsx and is mounted as <EditorApp />.

import { useEffect, useState } from 'react'
import { EntitlementsProvider, useEntitlements } from './monetisation/EntitlementsContext'
import { LoginScreen, VerifyEmailScreen, Dashboard, PricingPage, AdminPanel, UpgradeModal, CheckoutGate } from './monetisation/MonetisationUI'
import { buildFloorplanSnapshot } from './monetisation/snapshotBridge'
import { readSharedPlan } from './monetisation/share'
import EditorApp from './App.jsx'

function MonetisedApp() {
  const ent = useEntitlements()
  const [view, setView] = useState('dashboard') // dashboard | editor | pricing | admin
  const [loadedPlan, setLoadedPlan] = useState(null)
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
  // Half-registered account: the only reachable screen is the code entry.
  if (!ent.user && ent.pendingEmail) {
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
  if (!ent.user) return <LoginScreen />

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
  if (view === 'pricing') return <><PricingPage onBack={() => setView('dashboard')} />{overlays}</>
  if (view === 'admin') return <AdminPanel onBack={() => setView('dashboard')} />
  return (
    <>
      <Dashboard
        onOpenPlan={openPlan}
        onNewPlan={newPlan}
        onOpenEditor={() => { setLoadedPlan(null); setView('editor') }}
        onPricing={() => setView('pricing')}
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
