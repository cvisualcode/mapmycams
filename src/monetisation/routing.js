// ─── Visitor routing ─────────────────────────────────────────────────────────
// Which screen someone with no session belongs on. Kept as a pure function,
// separate from the shell component, so the rule can be tested without a browser
// and cannot be re-derived (or accidentally inverted) at a second call site.

/**
 * @param {{ pendingEmail?: string|null }} ent entitlements snapshot
 * @param {string|null} authTab 'login' | 'signup' once the visitor has chosen a
 *   way in, null while they are still reading the home page
 * @returns {'verify'|'auth'|'home'}
 *   verify — half-registered account: the emailed code is the only way forward
 *   auth   — the sign-in / sign-up card
 *   home   — the public home page
 */
export function visitorRoute(ent, authTab) {
  // A half-registered account outranks everything: offering the home page or the
  // sign-in form again would just invite a second account.
  if (ent?.pendingEmail) return 'verify'
  return authTab === 'login' || authTab === 'signup' ? 'auth' : 'home'
}
