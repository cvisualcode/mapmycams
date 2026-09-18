// ─── App shell with monetisation flow ────────────────────────────────────────
// Wraps the floorplan editor with the account system, dashboard, pricing page
// and admin panel. Views: auth → dashboard ⇄ editor / pricing / admin.
// The editor itself lives in src/App.jsx and is mounted as <EditorApp />.

import { useState } from 'react'
import { EntitlementsProvider, useEntitlements } from './monetisation/EntitlementsContext'
import { LoginScreen, VerifyEmailScreen, Dashboard, PricingPage, AdminPanel, UpgradeModal } from './monetisation/MonetisationUI'
import { buildFloorplanSnapshot, applyFloorplanSnapshot } from './monetisation/snapshotBridge'
import EditorApp from './App.jsx'

function MonetisedApp() {
  const ent = useEntitlements()
  const [view, setView] = useState('dashboard') // dashboard | editor | pricing | admin
  const [loadedPlan, setLoadedPlan] = useState(null)

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
    applyFloorplanSnapshot(fp.data)
    setLoadedPlan(fp)
    setView('editor')
  }

  function newPlan() {
    if (ent.limits.floorplans !== Infinity && ent.floorplans.length >= 1) {
      ent.promptUpgrade('Save more floorplans', 'Free tier stores 1 floorplan. Upgrade to Premium for unlimited layouts.', 'premium_monthly')
      return
    }
    applyFloorplanSnapshot(null)
    setLoadedPlan(null)
    setView('editor')
  }

  function exitEditor() {
    const snapshot = buildFloorplanSnapshot()
    if (snapshot) {
      ent.saveFloorplan(loadedPlan ? loadedPlan.name : 'My floorplan', snapshot, loadedPlan ? loadedPlan.id : null).catch(() => {})
    }
    setView('dashboard')
  }

  if (view === 'editor') return <EditorApp onExit={exitEditor} showUpgrade={(t, r) => ent.promptUpgrade(t, r, 'premium_monthly')} />
  if (view === 'pricing') return <PricingPage onBack={() => setView('dashboard')} />
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
      <UpgradeModal />
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
