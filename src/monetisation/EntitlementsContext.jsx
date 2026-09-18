// ─── Entitlements context ────────────────────────────────────────────────────
// Provides the signed-in user, their plan limits, saved floorplans and the
// upgrade-prompt modal to the whole app. Wrap once, consume everywhere.

import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import * as api from './api'
import { limitsFor } from './plans'

const EntitlementsContext = createContext(null)

export function EntitlementsProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [upgrade, setUpgrade] = useState(null) // { title, reason, item }
  const [floorplans, setFloorplans] = useState([])
  // The address awaiting an emailed code, restored on load so a reload keeps the
  // code screen. `devCode` is only ever set when no email provider is connected.
  const [pendingEmail, setPendingEmail] = useState(() => api.pendingVerification()?.email || null)
  const [devCode, setDevCode] = useState(null)
  const [deliveryError, setDeliveryError] = useState(null)

  // Restore any existing session on load.
  useEffect(() => {
    let cancelled = false
    api.getMe()
      .then((u) => { if (!cancelled) { setUser(u); setLoading(false) } })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const refreshFloorplans = useCallback(async () => {
    if (!user) { setFloorplans([]); return }
    const list = await api.listFloorplans().catch(() => [])
    setFloorplans(list)
  }, [user])

  useEffect(() => { refreshFloorplans() }, [refreshFloorplans])

  const limits = limitsFor(user ? user.plan : 'free')

  const value = {
    user,
    loading,
    limits,
    floorplans,
    refreshFloorplans,
    /** Feature check used by the paywall gate: ent.can('ai') */
    can(feature) {
      if (!user) return false
      if (user.isAdmin) return true
      if (limits[feature]) return true
      // One-time add-ons also unlock the features they cover
      const addons = user.addons || []
      if (feature === 'ai' && addons.includes('ai_pack')) return true
      if (feature === 'pdfReport' && addons.includes('pdf_report')) return true
      if (feature === 'premiumBrands' && addons.includes('brands')) return true
      return false
    },
    isPremium: !!user && (user.isAdmin || user.plan.startsWith('premium')),
    /** Show the upgrade modal and record the upsell trigger for analytics. */
    promptUpgrade(title, reason, item) {
      api.track('upsell_shown', { item, title })
      setUpgrade({ title, reason, item })
    },
    upgrade,
    closeUpgrade: () => setUpgrade(null),
    async login(identifier, password) {
      const u = await api.login(identifier, password)
      // An unverified account returns instead of signing in — the shell shows
      // the code screen rather than the planner.
      if (u?.pendingVerification) {
        setPendingEmail(u.email)
        if (u.devCode) setDevCode(u.devCode)
        return u
      }
      setUser(u)
      return u
    },
    /** Creates an unverified account and sends a code — it does not sign anyone in. */
    async signup(email, password, name) {
      const res = await api.signup(email, password, name)
      if (res?.pendingVerification) {
        setPendingEmail(res.email)
        setDevCode(res.devCode || null)
        setDeliveryError(res.deliveryError || null)
        return res
      }
      setUser(res)
      return res
    },
    pendingEmail,
    devCode,
    deliveryError,
    /** Enter the emailed code. Only on success does a session exist. */
    async verifyEmail(code) {
      const u = await api.verifyEmail(pendingEmail, code)
      setUser(u)
      setPendingEmail(null)
      setDevCode(null)
      setDeliveryError(null)
      return u
    },
    async resendCode() {
      const res = await api.resendCode(pendingEmail)
      if (res?.devCode) setDevCode(res.devCode)
      setDeliveryError(res?.deliveryError || null)
      return res
    },
    /** Abandon verification and return to the sign-in form. */
    cancelVerification() {
      api.cancelPendingVerification()
      setPendingEmail(null)
      setDevCode(null)
      setDeliveryError(null)
    },
    async logout() { await api.logout(); setUser(null); setFloorplans([]) },
    async startCheckout(item, kind) {
      const res = await api.startCheckout(item, kind)
      if (res && res.demo) {
        const me = await api.getMe()
        setUser(me)
      }
      return res
    },
    async saveFloorplan(name, data, id) {
      const saved = await api.saveFloorplan(name, data, id)
      await refreshFloorplans()
      return saved
    },
    async deleteFloorplan(id) { await api.deleteFloorplan(id); await refreshFloorplans() },
  }

  return <EntitlementsContext.Provider value={value}>{children}</EntitlementsContext.Provider>
}

export function useEntitlements() {
  const ctx = useContext(EntitlementsContext)
  if (!ctx) throw new Error('useEntitlements must be used inside EntitlementsProvider')
  return ctx
}
