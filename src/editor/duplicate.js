// ─── Duplicating what is selected ────────────────────────────────────────────
// Placing six of the same camera should not mean six trips to the sidebar, and a second
// window on a wall should land beside the first rather than on top of it.
//
// A copy's position depends on what it is: a camera or a free-standing object has an x/y
// of its own, while a door or window mounted on a wall is placed by the fraction of the
// wall it spans (t1/t2) and has no coordinates at all. Both rules live here, away from
// the editor, so `bun run duplicate:test` can check the awkward cases — a copy that runs
// off the end of its wall, a wall too short for two windows, a floor that has been
// dragged to a corner.
//
// Ids are left to the caller: the editor owns the counter that keeps them unique.

import { PIXELS_PER_METER } from './plan-drawing.js'

/** How far a free-standing copy is dropped from the original. */
export const DUPLICATE_OFFSET_METERS = 0.5

/** The offset in plan pixels. */
export function duplicateOffset() {
  return DUPLICATE_OFFSET_METERS * PIXELS_PER_METER
}

/**
 * Where a copy of a wall-mounted item sits, as the span of a wall it occupies.
 *
 * Beside the original if the wall has room, and on the other side if it does not. A wall
 * too short for a second one puts the copy back at the start rather than letting it hang
 * off the end — an item placed outside its wall is worse than one that overlaps.
 */
export function offsetAlongWall(obj, gap = 0.02) {
  const span = Math.max(0, (obj.t2 ?? 0) - (obj.t1 ?? 0))
  const step = span + gap
  let t1 = (obj.t1 ?? 0) + step
  let t2 = (obj.t2 ?? 0) + step
  if (t2 > 1) {
    // No room to the right, so try the left.
    t1 = (obj.t1 ?? 0) - step
    t2 = (obj.t2 ?? 0) - step
  }
  if (t1 < 0) {
    t1 = 0
    t2 = span
  }
  if (t2 > 1) {
    t2 = 1
    t1 = Math.max(0, 1 - span)
  }
  return { t1, t2 }
}

/**
 * A copy of a placed object, without an id.
 *
 * Wall-mounted items keep their wall and segment and move along it; everything else is
 * dropped half a metre to the south-east, keeping its rotation, size and hinge.
 */
export function duplicateObject(obj) {
  if (!obj || typeof obj !== 'object') return null
  if (obj.wallId != null) {
    const { t1, t2 } = offsetAlongWall(obj)
    return { ...obj, t1, t2 }
  }
  const offset = duplicateOffset()
  return { ...obj, x: (obj.x ?? 0) + offset, y: (obj.y ?? 0) + offset }
}

/** A copy of a placed camera, without an id. It keeps its aim, lens and range. */
export function duplicateCamera(camera) {
  if (!camera || typeof camera !== 'object') return null
  const offset = duplicateOffset()
  return { ...camera, x: (camera.x ?? 0) + offset, y: (camera.y ?? 0) + offset }
}
