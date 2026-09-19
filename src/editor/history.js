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
