// ─── Plan timeline (undo / redo) ─────────────────────────────────────────────
//
// The plan is React state — walls, cameras, objects, wires and the floor on screen —
// and React owns every one of them. There is no single "commit" call to hang history
// off, and the mutations live all over the editor, so this works by *observation*
// instead: whenever the plan settles it is serialized and offered to the timeline,
// which keeps it unless it is identical to what it already holds.
//
// Two consequences are the design, not accidents:
//
//  * One drag is one step. The editor waits for the plan to settle before recording,
//    so the fifty states a camera passes through while it is being dragged collapse
//    into the single state the drag ended on.
//
//  * Restoring cannot create a new entry. Because the timeline compares serialized
//    plans, the state that comes back from an undo *is* the newest entry, so the record
//    call that follows it is a no-op. That is what lets `past` hold the current state as
//    its last element and still support both directions.
//
// Everything here is plain data in and plain strings out, so `bun run history:test`
// checks it without a browser.

export const DEFAULT_HISTORY_LIMIT = 60

/**
 * A plan, as a string. Only the four collections and the floor that is on screen are
 * kept; names, colours and geometry travel inside them.
 *
 * Every floor is included, not just the visible one: undoing a change to the ground
 * floor after switching to the first floor has to put the ground floor back too.
 */
export function serializePlan(plan = {}) {
  const floors = Array.isArray(plan.floors) ? plan.floors : []
  return JSON.stringify({
    v: 1,
    activeFloor: Number.isFinite(plan.activeFloor) ? plan.activeFloor : 0,
    floors: floors.map((floor) => ({
      walls: floor?.walls || [],
      cameras: floor?.cameras || [],
      objects: floor?.objects || [],
      wires: floor?.wires || [],
    })),
  })
}

/** The plan back, with the shapes the editor expects after a JSON round trip. */
export function deserializePlan(serialized) {
  let parsed
  try {
    parsed = JSON.parse(serialized)
  } catch {
    return { activeFloor: 0, floors: [] }
  }
  const floors = Array.isArray(parsed?.floors) ? parsed.floors : []
  return {
    activeFloor: Number.isFinite(parsed?.activeFloor) ? parsed.activeFloor : 0,
    floors: floors.map((floor) => ({
      walls: Array.isArray(floor?.walls) ? floor.walls : [],
      cameras: Array.isArray(floor?.cameras) ? floor.cameras : [],
      objects: Array.isArray(floor?.objects) ? floor.objects : [],
      wires: Array.isArray(floor?.wires) ? floor.wires : [],
    })),
  }
}

/**
 * A plan from anywhere, as the editor's own shape: `{ activeFloor, floors }`.
 *
 * Two shapes have been written into people's accounts. The dashboard saves the four
 * collections on their own — the floor that happened to be on screen and nothing else —
 * while the editor, its share links and its undo timeline all speak `{ floors: [...] }`.
 * A flat plan is read as the ground floor, which is what it was when it was written.
 *
 * Reading it any other way is how a layout comes back empty: a plan drawn on the ground
 * floor and saved while the first floor was on screen *was* saved as an empty plan.
 *
 * A floor keeps only what is an array of things, and a plan with no floors at all is one
 * empty floor rather than none, so every caller can index floor 0 without a guard.
 */
export function normalizePlanData(data, floorCount = 1) {
  const list = (value) => (Array.isArray(value) ? value : [])
  const asFloor = (floor) => ({
    walls: list(floor?.walls),
    cameras: list(floor?.cameras),
    objects: list(floor?.objects),
    wires: list(floor?.wires),
  })
  const floors = Array.isArray(data?.floors) && data.floors.length ? data.floors.map(asFloor) : [asFloor(data)]
  const want = Math.max(1, Math.floor(Number(floorCount)) || 1)
  while (floors.length < want) floors.push(asFloor(null))
  const active = Number(data?.activeFloor)
  return {
    activeFloor: Number.isInteger(active) && active >= 0 && active < floors.length ? active : 0,
    floors,
  }
}

/**
 * The document a saved plan is: every floor, and the one that was on screen.
 *
 * This is what the dashboard stores and what a share link carries, and it is deliberately
 * the same shape `normalizePlanData` reads, so the two ends cannot drift apart again — the
 * round trip through JSON is tested as one thing rather than two halves that each look
 * right on their own.
 */
export function planDocument({ floors = [], activeFloor = 0 } = {}) {
  const list = (value) => (Array.isArray(value) ? value : [])
  const active = Number(activeFloor)
  return {
    version: 2,
    activeFloor: Number.isInteger(active) && active >= 0 ? active : 0,
    floors: (Array.isArray(floors) ? floors : []).map((floor) => ({
      walls: list(floor?.walls),
      cameras: list(floor?.cameras),
      objects: list(floor?.objects),
      wires: list(floor?.wires),
    })),
  }
}

/**
 * Is there anything in this plan at all?
 *
 * Asked before saving on the way out of a tab, so an empty session does not leave a plan
 * behind: a row on the dashboard that opens to nothing is worse than no row, and for a
 * Free account it also uses up the one plan it is allowed.
 */
export function planHasContent(plan) {
  const floors = Array.isArray(plan?.floors) ? plan.floors : []
  return floors.some((floor) => ['walls', 'cameras', 'objects', 'wires'].some((key) => (
    Array.isArray(floor?.[key]) && floor[key].length > 0
  )))
}

/**
 * A timeline of plan snapshots.
 *
 * `past` is chronological with the newest entry last — which, once anything has been
 * recorded, is the plan as it stands. `future` holds what redo will walk back into, and
 * is emptied the moment the plan moves somewhere new.
 */
export function createHistory(limit = DEFAULT_HISTORY_LIMIT) {
  const cap = Math.max(2, Math.floor(limit) || DEFAULT_HISTORY_LIMIT)
  const past = []
  const future = []

  return {
    /** Offer the plan. Returns false when nothing was stored (identical, or not a string). */
    record(serialized) {
      if (typeof serialized !== 'string' || serialized === '') return false
      if (past.length > 0 && past[past.length - 1] === serialized) return false
      past.push(serialized)
      while (past.length > cap) past.shift()
      future.length = 0
      return true
    },

    /** Is there anything behind the current state to step back to? */
    canUndo() {
      return past.length > 1
    },

    canRedo() {
      return future.length > 0
    },

    /** Step back. Null when the plan is already as far back as the timeline goes. */
    undo() {
      if (past.length < 2) return null
      future.push(past.pop())
      return past[past.length - 1]
    },

    /** Step forward, undoing an undo. Null when there is nothing to redo. */
    redo() {
      if (future.length === 0) return null
      const next = future.pop()
      past.push(next)
      while (past.length > cap) past.shift()
      return next
    },

    /** The plan as the timeline last recorded it. */
    current() {
      return past.length > 0 ? past[past.length - 1] : null
    },

    /** How many snapshots are held, and how many undos are waiting. */
    depth() {
      return { past: past.length, future: future.length }
    },
  }
}
