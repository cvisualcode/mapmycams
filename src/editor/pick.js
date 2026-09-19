// ─── Picking what is already on the plan ─────────────────────────────────────
// Which placed object is under a point?
//
// Two things need that answer: the select tool, and the placement tools, which must
// pick up what is already there rather than stacking another one on top of it. That
// second case is why this exists as its own module — "did that tap land on the safe?"
// is a question a test can answer, and the answer decides whether a second safe lands
// or the first one gets picked up.
//
// Slack is measured in *screen* pixels, not plan pixels, so a small object stays as
// easy to hit when the plan is zoomed out as when it is zoomed in. That matters most
// for the outlet, which is only a fifth of a metre across.
//
//   bun run pick:test

import {
  OBJECT_PRESETS, PIXELS_PER_METER, distanceToSegment, objectCentre,
} from './plan-drawing.js'

/** How far from an object a tap still counts as hitting it, in screen pixels. */
export const PICK_SLACK_PX = 12

/**
 * The distance from a world point to an object, or null when the object has no place on
 * the plan (a wall object whose wall has gone).
 *
 * Zero anywhere inside it, and the gap to its edge outside — so the closest object to
 * the tap is also the one whose distance is smallest.
 */
export function distanceToObject(world, obj, walls) {
  if (!obj) return null
  const preset = OBJECT_PRESETS.find((p) => p.id === obj.presetId)
  if (!preset) return null

  if (obj.wallId != null) {
    const wall = (walls || []).find((w) => w.id === obj.wallId)
    if (!wall || !Array.isArray(wall.points) || wall.points.length < 2) return null
    const index = ((Math.trunc(obj.segmentIndex) || 0) % wall.points.length + wall.points.length) % wall.points.length
    const next = wall.closed === false ? index + 1 : (index + 1) % wall.points.length
    if (next >= wall.points.length) return null
    const p1 = wall.points[index]
    const p2 = wall.points[next]
    const t1 = obj.t1 ?? 0
    const t2 = obj.t2 ?? 1
    const a = { x: p1.x + (p2.x - p1.x) * t1, y: p1.y + (p2.y - p1.y) * t1 }
    const b = { x: p1.x + (p2.x - p1.x) * t2, y: p1.y + (p2.y - p1.y) * t2 }
    return distanceToSegment(world.x, world.y, a.x, a.y, b.x, b.y)
  }

  const centre = objectCentre(obj, walls)
  if (!centre) return null
  const halfW = ((obj.width || preset.width) * PIXELS_PER_METER) / 2
  const halfH = ((obj.height || preset.height) * PIXELS_PER_METER) / 2
  // Straight-line gap to the rectangle, which is zero inside it.
  const gapX = Math.max(Math.abs(world.x - centre.x) - halfW, 0)
  const gapY = Math.max(Math.abs(world.y - centre.y) - halfH, 0)
  return Math.hypot(gapX, gapY)
}

/**
 * The object under a world point, or null when the tap missed everything.
 *
 * The nearest one wins. Two objects on the same spot are therefore resolved by distance
 * rather than by draw order, and a tap between a safe and the wall it sits against
 * picks the safe rather than the wall.
 */
export function findPlacedObjectAt(world, objects, walls, zoom = 1, slackPx = PICK_SLACK_PX) {
  if (!world) return null
  const slack = slackPx / Math.max(zoom, 0.01)
  let best = null
  let bestDistance = Infinity
  for (const obj of objects || []) {
    const distance = distanceToObject(world, obj, walls)
    if (distance === null || distance > slack || distance >= bestDistance) continue
    best = obj
    bestDistance = distance
  }
  return best
}
