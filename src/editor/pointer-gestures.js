// ─── Pointer gestures ────────────────────────────────────────────────────────
// Deciding what a press on the plan means: a tap, a drag, or a two-finger pinch.
//
// This is deliberately separate from the editor. The decisions here are exactly the ones
// that cannot be eyeballed from a build passing — "does a tap still place a camera?",
// "does starting a pinch leave a half-drawn wall behind?", "does a pinch drift when the
// second finger lands off-centre?" — and keeping them in plain functions means
// `bun run gestures:test` can answer all three without a touchscreen.
//
// The module never touches the DOM. The caller converts pointer coordinates into canvas
// space (a pinch is anchored in the canvas, not the page) and applies the actions it is
// handed back.
//
// The shape of it:
//
//   press        → 'mouseDown' (mouse/stylus, immediately) or 'wait' (a finger)
//   move, 1 finger, not yet past the slop → 'none'
//   move, 1 finger, past the slop        → 'pressThenMove'  (the press is replayed, then moves)
//   move, 2 fingers                      → 'pinch'
//   press, 2 fingers                     → 'pinchStart'  (and whatever was in flight is dropped)
//   lift, finger was drawing             → 'mouseUp'
//   lift, finger never travelled         → 'tap'  (a press and a release at one point)
//   cancel                               → 'abandon'

/** How far a finger may travel before it is a drag rather than a tap. */
export const TOUCH_SLOP_PX = 8
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 5

export function createGestureTracker() {
  return { pointers: new Map(), pending: null, pinch: null, swallowUntilLift: false }
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/** Every finger down at the moment, in canvas coordinates. */
export function trackedPoints(tracker, rect = { left: 0, top: 0 }) {
  return [...tracker.pointers.values()].map((point) => ({
    x: point.clientX - rect.left,
    y: point.clientY - rect.top,
  }))
}

export function pointerDown(tracker, event) {
  if (event.pointerType !== 'touch') return { action: 'mouseDown' }
  tracker.pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY })
  if (tracker.pointers.size >= 2) {
    // The second finger decides: it is a pinch, so the first finger's press is dropped
    // before it ever reaches the editor and nothing half-drawn is committed.
    tracker.pending = null
    tracker.swallowUntilLift = true
    return { action: 'pinchStart' }
  }
  tracker.pending = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, pressed: false }
  return { action: 'wait' }
}

/** Remember what a pinch started from. `points` are in canvas space. */
export function beginPinch(tracker, points, zoom, pan) {
  if (!Array.isArray(points) || points.length < 2) return null
  const [a, b] = points
  tracker.pinch = {
    startDistance: Math.max(1, distance(a, b)),
    startZoom: zoom,
    startPan: { x: pan.x, y: pan.y },
    startMid: midpoint(a, b),
  }
  return tracker.pinch
}

/**
 * Where a pinch has got to: zoom about the point between the fingers, and let the same
 * gesture pan the plan by moving that point.
 *
 * Anchoring matters — scaling about the canvas centre instead would slide the plan out
 * from under the fingers.
 */
export function pinchTransform(tracker, points) {
  const pinch = tracker.pinch
  if (!pinch || !Array.isArray(points) || points.length < 2) return null
  const [a, b] = points
  const spread = Math.max(1, distance(a, b))
  const mid = midpoint(a, b)
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.startZoom * (spread / pinch.startDistance)))
  const ratio = zoom / pinch.startZoom
  return {
    zoom,
    pan: {
      x: mid.x - (pinch.startMid.x - pinch.startPan.x) * ratio,
      y: mid.y - (pinch.startMid.y - pinch.startPan.y) * ratio,
    },
  }
}

export function pointerMove(tracker, event) {
  if (event.pointerType !== 'touch') return { action: 'mouseMove' }
  const tracked = tracker.pointers.get(event.pointerId)
  if (tracked) {
    tracked.clientX = event.clientX
    tracked.clientY = event.clientY
  }
  if (tracker.pointers.size >= 2) return { action: 'pinch' }
  if (tracker.swallowUntilLift) return { action: 'none' }
  const pending = tracker.pending
  if (!pending || pending.pointerId !== event.pointerId) return { action: 'none' }
  if (!pending.pressed) {
    // A finger that has not travelled yet is still a candidate for a pinch, so the press
    // waits. Replaying it from where the finger landed is what makes an 8 px drag the
    // same as a tap as far as the plan is concerned.
    if (Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) < TOUCH_SLOP_PX) {
      return { action: 'none' }
    }
    pending.pressed = true
    return { action: 'pressThenMove', point: { clientX: pending.clientX, clientY: pending.clientY } }
  }
  return { action: 'mouseMove' }
}

export function pointerUp(tracker, event) {
  if (event.pointerType !== 'touch') return { action: 'mouseUp' }
  tracker.pointers.delete(event.pointerId)
  if (tracker.pinch) {
    if (tracker.pointers.size < 2) tracker.pinch = null
    if (tracker.pointers.size === 0) tracker.swallowUntilLift = false
    // One finger of the pinch lifting is not a click, however many are left.
    return { action: 'none' }
  }
  if (tracker.swallowUntilLift) {
    if (tracker.pointers.size === 0) tracker.swallowUntilLift = false
    return { action: 'none' }
  }
  const pending = tracker.pending
  tracker.pending = null
  if (!pending) return { action: 'none' }
  if (pending.pressed) return { action: 'mouseUp' }
  return { action: 'tap', point: { clientX: pending.clientX, clientY: pending.clientY } }
}

export function pointerCancel(tracker, event) {
  tracker.pointers.delete(event.pointerId)
  tracker.pending = null
  if (tracker.pinch && tracker.pointers.size < 2) tracker.pinch = null
  if (tracker.pointers.size === 0) tracker.swallowUntilLift = false
  return { action: 'abandon' }
}
