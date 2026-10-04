// ─── App shell with monetisation flow ────────────────────────────────────────
// Wraps the floorplan editor with the account system, dashboard, pricing page
// and admin panel. Views: auth → dashboard ⇄ editor / pricing / admin.
// The editor itself lives in src/App.jsx and is mounted as <EditorApp />.

import { useEffect, useRef, useState } from 'react'
import * as api from './monetisation/api'
import { createAutosave } from './editor/autosave'
import { EntitlementsProvider, useEntitlements } from './monetisation/EntitlementsContext'
import { LoginScreen, VerifyEmailScreen, Dashboard, PricingPage, AdminPanel, UpgradeModal, CheckoutGate } from './monetisation/MonetisationUI'
import LandingPage from './monetisation/LandingPage'
import { visitorRoute } from './monetisation/routing'
import { buildFloorplanSnapshot } from './monetisation/snapshotBridge'
import { planHasContent } from './editor/history'
import { readSharedPlan } from './monetisation/share'
import EditorApp from './App.jsx'
import EditorMobileMenu from './editor/mobile-menu.jsx'
import ShareViewer from './monetisation/ShareViewer.jsx'

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
  // A plan opened from a short share link (?share=<code>) is shown read-only,
  // before any sign-in gate — a client with the link must be able to view it.
  const [shareCode, setShareCode] = useState(() => (
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('share')
  ))

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

  // Leaving the editor is not the only way out of it: a closed tab, a phone locking, a
  // back-swipe. Those used to take the layout with them, because nothing was written
  // until the Dashboard button was pressed. This writes the same document on the way
  // out — the browser's own copy is written synchronously, so it survives even if the
  // request does not finish. A plan with nothing in it is not saved at all: a row that
  // opens to an empty plan is worse than no row, and on the Free tier it is the one row.
  //
  // Registered here rather than beside the editor's own handlers because this component
  // returns from several places further down, and a hook below those returns is a hook
  // that is called on some renders and not others.
  const saverRef = useRef(null)
  const sessionRef = useRef(null)
  const [saveStatus, setSaveStatus] = useState('')
  const [exiting, setExiting] = useState(false)
  const owner = ent.user?.id
  useEffect(() => {
    if (view !== 'editor' || !owner) return undefined
    const session = sessionRef.current
    if (!session) return undefined
    const saver = createAutosave({
      writeDraft: (data) => {
        if (api.planOwner() !== owner) throw new Error('Your account changed; reopen the plan')
        api.writePlanDraft(session.name, data, session.id)
      },
      save: async (data, options) => {
        if (api.planOwner() !== owner) throw new Error('Your account changed; reopen the plan')
        await api.saveFloorplan(session.name, data, session.id, options)
      },
      onStatus: setSaveStatus,
    })
    saverRef.current = saver
    const capture = () => {
      const snapshot = buildFloorplanSnapshot()
      if (snapshot && (planHasContent(snapshot) || session.existing)) {
        saver.capture(snapshot)
        session.existing = true
      }
    }
    const leave = () => {
      try { capture() } catch (error) { setSaveStatus(`Not saved: ${error.message}`); return }
      saver.flush({ keepalive: true }).catch((error) => setSaveStatus(`Saved in this browser only: ${error.message}`))
    }
    const hidden = () => { if (document.visibilityState === 'hidden') leave() }
    const changed = () => { try { capture() } catch (error) { setSaveStatus(`Not saved: ${error.message}`) } }
    const online = () => leave()
    window.addEventListener('mmc:plan-changed', changed)
    window.addEventListener('pagehide', leave)
    window.addEventListener('online', online)
    document.addEventListener('visibilitychange', hidden)
    changed()
    return () => {
      window.removeEventListener('mmc:plan-changed', changed)
      window.removeEventListener('pagehide', leave)
      window.removeEventListener('online', online)
      document.removeEventListener('visibilitychange', hidden)
      saver.dispose()
      if (saverRef.current === saver) saverRef.current = null
    }
  }, [view, owner])

  if (ent.loading) return <div className="auth-screen"><p>Loading…</p></div>

  // The share viewer wins over everything except the sign-in screen it sends you
  // to when you want to comment — and comes back once the account is in.
  if (shareCode && !(authTab && !ent.user)) {
    return (
      <ShareViewer
        code={shareCode}
        signedIn={!!ent.user}
        onSignIn={() => setAuthTab('login')}
        onMakeCopy={(report) => {
          window.history.replaceState({}, '', window.location.pathname)
          setShareCode(null)
          sessionRef.current = { id: crypto.randomUUID(), name: `${String(report.name || 'Shared plan').slice(0, 100)} (copy)`, existing: false }
          setSharedPlan(report.data)
          setLoadedPlan(null)
          setSaveStatus('')
          setView('editor')
        }}
      />
    )
  }

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
    const draft = api.readLocalPlan(fp.id)
    const chosen = draft?.pendingSync ? draft : fp
    sessionRef.current = { id: chosen.id, name: chosen.name || 'My floorplan', existing: true }
    setLoadedPlan(chosen)
    setSaveStatus('')
    setView('editor')
  }

  function newPlan() {
    if (ent.limits.floorplans !== Infinity && ent.floorplans.length >= 1) {
      ent.promptUpgrade('Save more floorplans', 'Free tier stores 1 floorplan. Upgrade to Premium for unlimited layouts.', 'premium_monthly')
      return
    }
    sessionRef.current = { id: crypto.randomUUID(), name: 'My floorplan', existing: false }
    setLoadedPlan(null)
    setSharedPlan(null)
    setSaveStatus('')
    setView('editor')
  }

  /** Back into the app from the home page, straight into the planner. */
  function openPlanner() {
    setShowHome(false)
    if (ent.floorplans.length) openPlan(ent.floorplans[0])
    else newPlan()
  }

  async function exitEditor() {
    if (exiting) return
    setExiting(true)
    try {
      const snapshot = buildFloorplanSnapshot()
      if (snapshot && (planHasContent(snapshot) || sessionRef.current?.existing)) saverRef.current?.capture(snapshot)
      await saverRef.current?.flush()
      await ent.refreshFloorplans()
      setSharedPlan(null)
      setView('dashboard')
    } catch (error) {
      setSaveStatus(`Could not sync: ${error.message}. Your browser draft is kept. Retry Save or stay here.`)
    } finally { setExiting(false) }
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
        {/* The editor's toolbar collapses into a menu on a phone. See
            src/editor/mobile-menu.jsx for why this lives beside the editor. */}
        <div className="save-status" role="status">{saveStatus || 'Autosave ready'} <button disabled={exiting} onClick={exitEditor}>{exiting ? 'Saving…' : 'Save & Dashboard'}</button></div>
        <EditorMobileMenu>
          <EditorApp
          // Remounting is what gives the editor new starting state, since the
          // snapshot is only read when it mounts. Without a key, opening a saved
          // plan from the dashboard left the editor empty.
          key={loadedPlan ? `plan-${loadedPlan.id}` : sharedPlan ? 'shared-plan' : 'new-plan'}
            initialSnapshot={sharedPlan || (loadedPlan ? loadedPlan.data : null)}
            onExit={exitEditor}
            showUpgrade={(title, reason, item) => ent.promptUpgrade(title, reason, item || 'premium_monthly')}
          />
        </EditorMobileMenu>
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
