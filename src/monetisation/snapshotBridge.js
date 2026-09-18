// ─── Editor ↔ app shell bridge ───────────────────────────────────────────────
// The floorplan editor exposes its state through two global hooks set in
// App.jsx: window.__mmcGetSnapshot and window.__mmcSetSnapshot. This module
// wraps them in typed helpers so the shell can save/load floorplans.

export function buildFloorplanSnapshot() {
  if (typeof window !== 'undefined' && window.__mmcGetSnapshot) {
    return window.__mmcGetSnapshot()
  }
  return null
}

export function applyFloorplanSnapshot(snapshot) {
  if (typeof window !== 'undefined' && window.__mmcSetSnapshot) {
    window.__mmcSetSnapshot(snapshot)
  }
}
