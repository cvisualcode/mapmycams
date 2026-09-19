// ─── Coverage-driven camera placement ────────────────────────────────────────
// Decides *where* cameras go, so a model never has to. The job is a weighted set
// cover: sample the floor into targets, give the ones that matter (doors, windows,
// stairs, safes, power outlets) a heavier weight, work out which positions can see
// which targets, then repeatedly take the position that covers the most weight that
// is still uncovered — and stop as soon as another camera would only add scraps.
//
// That is what produces "few cameras, most coverage": every camera has to earn its
// place, and a camera that only sees a corner of an already-covered room is never
// placed. An AI suggestion is welcome as a *candidate* (it competes on equal terms
// once a small bonus is applied), but coverage, not opinion, picks the winners.
//
// Pure functions of the plan, like src/editor/plan-drawing.js — no React, no DOM,
// which is what lets `bun run coverage:test` drive it without a browser.

// The extension is explicit so this module can also be imported by plain Node, which
// is what lets the placement tests run without a bundler (Vite accepts both).
import { PIXELS_PER_METER, isPointInPolygon, objectCentre } from './plan-drawing.js'

/** How much a target is worth. A door is the thing you most want watched; an outlet
 *  matters mainly because a camera needs power nearby. */
export const PRIORITY_WEIGHTS = {
  door: 4,
  safe: 3,
  window: 2.5,
  stairs: 2.5,
  power: 1.5,
}
const FLOOR_WEIGHT = 1

const CELL = 60                 // px between sampled floor targets
const FOV_DEGREES = 110         // a wide fixed camera: fewest cameras, most coverage
const RANGE_METRES = 12
const WALL_CLEARANCE = 16       // px a camera is kept away from a wall
const CORNER_INSET = 14         // px into the room from a corner — where cameras go
const PRIORITY_RADIUS_METRES = 1.5
const MAX_CAMERAS = 12
// A camera has to earn its place: at least two weight-units of new coverage, and at
// least this share of everything there is to cover. Without the second rule the
// solver keeps adding a camera for the last dark corner of a room that is already
// 95% watched, which is how a helpful feature becomes an annoying one.
const MIN_GAIN = 2
const MIN_GAIN_SHARE = 0.07
// Candidates the model proposed are preferred over geometric ones when the gain is
// close, because the model has read the plan rather than just its corners.
const PROPOSAL_BONUS = 1.25

/** The priority weight of an object preset id. */
export function objectWeight(presetId = '') {
  const id = String(presetId)
  if (id.startsWith('stairs')) return PRIORITY_WEIGHTS.stairs
  return PRIORITY_WEIGHTS[id] || 0
}

/** Closed walls are rooms: the unit a camera has to cover. */
export function roomsOf(walls = []) {
  return walls.filter((w) => w && w.closed !== false && Array.isArray(w.points) && w.points.length >= 3)
}

/** Distance from a point to a segment, in pixels. */
function distanceToSegment(px, py, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = dx * dx + dy * dy
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len))
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
}

/** Is the straight line from a to b cut by any wall of a room other than `ownRoom`? */
function rayBlocked(a, b, rooms, ownRoom, objects) {
  for (const room of rooms) {
    if (room === ownRoom) continue
    const pts = room.points
    for (let i = 0; i < pts.length; i++) {
      const a1 = pts[i]
      const a2 = pts[(i + 1) % pts.length]
      const d = (b.x - a.x) * (a2.y - a1.y) - (b.y - a.y) * (a2.x - a1.x)
      if (Math.abs(d) < 1e-9) continue
      const t = ((a1.x - a.x) * (a2.y - a1.y) - (a1.y - a.y) * (a2.x - a1.x)) / d
      const u = ((a1.x - a.x) * (b.y - a.y) - (a1.y - a.y) * (b.x - a.x)) / d
      if (t > 0.02 && t < 0.98 && u > 0 && u < 1) return true
    }
  }
  // Something solid in the way (a closed door, a safe) blocks the view — but only
  // if it sits between the two, never the object being looked at.
  for (const o of objects) {
    if (!o || !o.blocksVision) continue
    const c = objectCentre(o, rooms)
    if (!c) continue
    const halfW = ((o.width || 1) * PIXELS_PER_METER) / 2 + 4
    const halfH = ((o.height || 1) * PIXELS_PER_METER) / 2 + 4
    const withinBox = Math.abs(c.x - b.x) < halfW && Math.abs(c.y - b.y) < halfH
    if (withinBox) continue
    const onSegment = Math.abs(c.x - a.x) <= Math.abs(b.x - a.x) + halfW && Math.abs(c.y - a.y) <= Math.abs(b.y - a.y) + halfH
    if (!onSegment) continue
    const t = lengthAlong(a, b, c)
    if (t > 0.05 && t < 0.95 && Math.abs(c.x - (a.x + (b.x - a.x) * t)) < halfW && Math.abs(c.y - (a.y + (b.y - a.y) * t)) < halfH) return true
  }
  return false
}

function lengthAlong(a, b, p) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = dx * dx + dy * dy
  if (len === 0) return 0
  return ((p.x - a.x) * dx + (p.y - a.y) * dy) / len
}

/**
 * What the plan is worth covering: a grid of floor cells per room, plus a target on
 * every object that matters. Cells near a door, window, stairs, safe or outlet are
 * worth as much as the object itself, so the whole approach to the door is watched
 * rather than one pixel.
 */
export function buildTargets(rooms, objects = []) {
  const targets = []
  for (const room of rooms) {
    const xs = room.points.map((p) => p.x)
    const ys = room.points.map((p) => p.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    for (let x = minX + CELL / 2; x < maxX; x += CELL) {
      for (let y = minY + CELL / 2; y < maxY; y += CELL) {
        if (!isPointInPolygon(x, y, room.points)) continue
        targets.push({ x, y, weight: FLOOR_WEIGHT, kind: 'floor', room })
      }
    }
  }

  const radius = PRIORITY_RADIUS_METRES * PIXELS_PER_METER
  for (const o of objects) {
    const weight = objectWeight(o?.presetId)
    if (weight === 0) continue
    const centre = objectCentre(o, rooms)
    if (!centre) continue
    targets.push({ x: centre.x, y: centre.y, weight, kind: o.presetId, room: rooms.find((r) => isPointInPolygon(centre.x, centre.y, r.points)) || null })
    // The area around it is worth as much: you want the approach to the door, not
    // just the door frame.
    for (const t of targets) {
      if (t.kind !== 'floor') continue
      if (Math.hypot(t.x - centre.x, t.y - centre.y) <= radius) t.weight = Math.max(t.weight, weight)
    }
  }
  return targets
}

/**
 * Positions worth considering: the corners of every room, points along its walls,
 * its centre, and whatever the model proposed.
 *
 * Corners are what keep the camera count down. A camera tucked into the corner of a
 * room sees the whole room through one wide lens, because the room only subtends
 * about ninety degrees from there; put the same camera in the middle and the room
 * wraps right around it, which is how a solver talks itself into three cameras for
 * one room. `nearWall` marks the positions that are deliberately close to a wall.
 */
export function buildCandidates(rooms, proposals = []) {
  const candidates = []
  const push = (x, y, bonus = 1, nearWall = false) => {
    const room = rooms.find((r) => isPointInPolygon(x, y, r.points))
    if (!room) return
    const pts = room.points
    if (!nearWall) {
      // Away from the walls a camera has a clear view rather than being pinned into
      // a corner; positions too close to one are dropped unless deliberately placed.
      for (let i = 0; i < pts.length; i++) {
        if (distanceToSegment(x, y, pts[i], pts[(i + 1) % pts.length]) < WALL_CLEARANCE) return
      }
    }
    if (candidates.some((c) => Math.hypot(c.x - x, c.y - y) < 20)) return
    candidates.push({ x, y, room, bonus })
  }

  for (const room of rooms) {
    const pts = room.points
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2

    for (const v of pts) {
      const dirX = cx - v.x, dirY = cy - v.y
      const len = Math.hypot(dirX, dirY) || 1
      push(v.x + (dirX / len) * CORNER_INSET, v.y + (dirY / len) * CORNER_INSET, 1, true)
    }

    push(cx, cy)
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length]
      // Points along the wall, pulled in towards the middle so they have a view.
      for (const t of [0.25, 0.75]) {
        const px = a.x + (b.x - a.x) * t
        const py = a.y + (b.y - a.y) * t
        const dirX = cx - px, dirY = cy - py
        const len = Math.hypot(dirX, dirY) || 1
        const pull = Math.min(45, len)
        push(px + (dirX / len) * pull, py + (dirY / len) * pull)
      }
    }
  }

  for (const p of proposals) {
    const x = Number(p?.x), y = Number(p?.y)
    if (Number.isFinite(x) && Number.isFinite(y)) push(x, y, PROPOSAL_BONUS)
  }
  return candidates
}

/** Which targets a camera at this position and angle can see. */
export function visibleTargets(cam, targets, rooms, objects) {
  const seen = []
  const range = (cam.distance || RANGE_METRES) * PIXELS_PER_METER
  for (const t of targets) {
    const dx = t.x - cam.x, dy = t.y - cam.y
    const dist = Math.hypot(dx, dy)
    if (dist > range) continue
    const bearing = (Math.atan2(dy, dx) * 180) / Math.PI
    const rel = ((bearing - cam.rotation + 540) % 360) - 180
    if (Math.abs(rel) > (cam.hFov || FOV_DEGREES) / 2) continue
    if (rayBlocked(cam, t, rooms, cam.room || null, objects)) continue
    seen.push(t)
  }
  return seen
}

/**
 * Turn a position into a camera: pick the heading that covers the most weight.
 * Aiming at each candidate target in turn and keeping the best window is O(n²) but
 * n is a room's worth of cells, and it is what makes the camera look *at* the door
 * rather than vaguely across the room.
 */
export function bestHeading(position, targets, rooms, objects) {
  const range = RANGE_METRES * PIXELS_PER_METER
  const reachable = []
  for (const t of targets) {
    const dx = t.x - position.x, dy = t.y - position.y
    if (Math.hypot(dx, dy) > range) continue
    if (rayBlocked(position, t, rooms, position.room || null, objects)) continue
    reachable.push({ target: t, bearing: (Math.atan2(dy, dx) * 180) / Math.PI })
  }

  let best = { rotation: 0, seen: [], weight: 0 }
  for (const aim of reachable) {
    const seen = reachable.filter((r) => Math.abs(((r.bearing - aim.bearing + 540) % 360) - 180) <= FOV_DEGREES / 2)
    const weight = seen.reduce((sum, r) => sum + r.target.weight, 0)
    if (weight > best.weight) best = { rotation: aim.bearing, seen: seen.map((r) => r.target), weight }
  }
  return best
}

const PRIORITY_NOUNS = {
  door: ['the door', '2 doors'],
  window: ['the window', 'windows'],
  safe: ['the safe', 'safes'],
  power: ['the power outlet', 'power outlets'],
  stairs: ['the stairs', 'staircases'],
}

/** "the door, 2 windows and the safe" — what a set of covered targets amounts to in words. */
export function describePriorities(coveredTargets = []) {
  const counts = new Map()
  for (const t of coveredTargets) {
    const kind = String(t.kind).startsWith('stairs') ? 'stairs' : t.kind
    counts.set(kind, (counts.get(kind) || 0) + 1)
  }
  const parts = [...counts.entries()].map(([kind, n]) => {
    const nouns = PRIORITY_NOUNS[kind]
    if (!nouns) return kind
    if (n === 1) return nouns[0]
    return `${n} ${nouns[1]}`
  })
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * Place cameras: cover the heaviest targets first, with as few cameras as the plan
 * allows.
 *
 * Returns the cameras to add plus what the result achieves, so the toolbar can say
 * so rather than leaving the user to guess whether it worked.
 */
export function planCameraPlacement({ walls = [], objects = [], cameras = [], proposals = [], maxCameras = MAX_CAMERAS } = {}) {
  const rooms = roomsOf(walls)
  if (rooms.length === 0) {
    return { cameras: [], summary: 'Draw a closed room first — there is nothing to cover yet.', floorCoveredPercent: 0, priorityCovered: 0, priorityTotal: 0 }
  }

  const targets = buildTargets(rooms, objects)
  const priority = targets.filter((t) => t.kind !== 'floor')
  const covered = new Set()

  // Cameras already on the plan count: never cover the same place twice.
  for (const cam of cameras) {
    const room = rooms.find((r) => isPointInPolygon(cam.x, cam.y, r.points)) || null
    for (const t of visibleTargets({ ...cam, room, hFov: cam.hFov || FOV_DEGREES }, targets, rooms, objects)) covered.add(t)
  }

  const candidates = buildCandidates(rooms, proposals)
  const totalWeight = targets.reduce((sum, t) => sum + t.weight, 0)
  const minGain = Math.max(MIN_GAIN, totalWeight * MIN_GAIN_SHARE)
  const chosen = []
  while (chosen.length < maxCameras) {
    let winner = null
    for (const cand of candidates) {
      const heading = bestHeading(cand, targets, rooms, objects)
      const fresh = heading.seen.filter((t) => !covered.has(t))
      if (fresh.length === 0) continue
      const weight = fresh.reduce((sum, t) => sum + t.weight, 0)
      // The bonus is a tie-breaker only; a proposal still has to be worth placing.
      if (weight < minGain) continue
      const gain = weight * cand.bonus
      if (!winner || gain > winner.gain) winner = { cand, heading, fresh, gain, weight }
    }
    if (!winner) break
    for (const t of winner.fresh) covered.add(t)
    chosen.push(winner)
  }

  const floorCells = targets.filter((t) => t.kind === 'floor')
  const floorDone = floorCells.filter((t) => covered.has(t)).length
  const priorityDone = priority.filter((t) => covered.has(t)).length

  const built = chosen.map((c, i) => {
    const farthest = Math.max(...c.fresh.map((t) => Math.hypot(t.x - c.cand.x, t.y - c.cand.y)), 60)
    return {
      id: `ai_${Math.random().toString(36).slice(2, 9)}`,
      x: Math.round(c.cand.x),
      y: Math.round(c.cand.y),
      rotation: Math.round(c.heading.rotation),
      hFov: FOV_DEGREES,
      distance: Math.min(40, Math.max(4, Math.ceil(farthest / PIXELS_PER_METER) + 2)),
      color: '#38bdf8',
      label: `AI Cam ${i + 1}`,
    }
  })

  const floorPct = floorCells.length ? Math.round((floorDone / floorCells.length) * 100) : 100
  // Name what was covered rather than counting it: "covers the door and 100% of the
  // floor" is the answer to the question the user actually asked.
  const watched = describePriorities(priority.filter((t) => covered.has(t)))
  const summary = built.length === 0
    ? 'Already covered — no extra cameras needed.'
    : `${built.length} camera${built.length === 1 ? ' covers' : 's cover'} ${watched ? `${watched} and ` : ''}${floorPct}% of the floor.`

  return {
    cameras: built,
    summary,
    floorCoveredPercent: floorPct,
    priorityCovered: priorityDone,
    priorityTotal: priority.length,
    candidates: candidates.length,
  }
}
