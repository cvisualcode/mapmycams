// ─── Plan geometry tests ─────────────────────────────────────────────────────
// The pure geometry in src/editor/plan-drawing.js: wall occlusion, the blind-spot
// sampler and the security score. These are the functions the coverage promises of
// the product rest on, and they need no browser to check.
//
//   bun run plan:test

import {
  segRayBlocked, computeBlindSpots, cameraSeesPoint, computeHealthScore, scoreBand, isPointInPolygon, objectCentre,
} from '../src/editor/plan-drawing.js'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

const rect = (x, y, w, h, label) => ({
  id: `w-${label}`,
  closed: true,
  label,
  points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
})

const hall = rect(0, 0, 240, 240, 'Hall')
const kitchen = rect(400, 0, 240, 240, 'Kitchen')
// A camera in the middle of a room pointing east only watches a slice of it — which
// is exactly why coverage decides placement (see test-coverage.mjs). A camera in a
// corner, aiming across the room, sees all of it.
const camMid = { id: 'c1', x: 120, y: 120, rotation: 0, hFov: 110, distance: 12 }
const camCorner = { id: 'c2', x: 10, y: 10, rotation: 45, hFov: 110, distance: 12 }
const camHall = camMid

// ── Wall occlusion ───────────────────────────────────────────────────────────
console.log('\nWall occlusion')
const wallBetween = { a1: { x: 300, y: -50 }, a2: { x: 300, y: 300 } }
check('a wall between the camera and the target blocks it', segRayBlocked(120, 120, 500, 100, wallBetween.a1, wallBetween.a2, hall, kitchen))
check('a wall off to one side does not', !segRayBlocked(120, 120, 200, 100, wallBetween.a1, wallBetween.a2, hall, kitchen))
check("a room's own boundary does not block its own targets", !segRayBlocked(120, 120, 200, 200, { x: 0, y: 0 }, { x: 240, y: 0 }, hall, hall))
check('the same boundary does block a target in the next room', segRayBlocked(120, 120, 500, 100, { x: 240, y: 0 }, { x: 240, y: 240 }, hall, kitchen))
// The regression this test exists for: the arithmetic used to come out NaN for every
// call, so nothing was ever blocked.
check('occlusion is actually computed, not silently NaN', segRayBlocked(0, 0, 100, 0, { x: 50, y: -10 }, { x: 50, y: 10 }, null, kitchen))

// ── Blind spots ──────────────────────────────────────────────────────────────
console.log('\nBlind spots')
const blind = computeBlindSpots([hall, kitchen], [camCorner], [])
const kitchenBlind = blind.find((b) => b.label === 'Kitchen')
check('a room no camera can see is reported blind', Boolean(kitchenBlind), JSON.stringify(blind.map((b) => b.label)))
check('every part of it is blind', (kitchenBlind?.cells?.length || 0) > 0, String(kitchenBlind?.cells?.length))
check('a wall is not seen through to a neighbouring room', kitchenBlind?.cells?.length === 16, String(kitchenBlind?.cells?.length))

const noCameras = computeBlindSpots([hall], [], [])
check('with no cameras at all, every room is blind', noCameras.length === 1 && noCameras[0].cells.length > 0)
check('the area is reported in square metres', noCameras[0].area > 0, String(noCameras[0].area))

const cornered = computeBlindSpots([hall], [camCorner], [])
check('a camera in the corner sees its whole room', cornered.length === 0, JSON.stringify(cornered.map((b) => b.cells.length)))
const middled = computeBlindSpots([hall], [camMid], [])
check('a camera in the middle of the room leaves gaps behind it', middled.length === 1 && middled[0].cells.length > 0, JSON.stringify(middled.map((b) => b.cells.length)))

// A door on the wall is solid: it blocks the view through the opening.
const doorWall = { ...hall, id: 'door-wall' }
const door = { presetId: 'door', wallId: 'door-wall', segmentIndex: 1, t1: 0.4, t2: 0.6, width: 0.9, height: 0.1, blocksVision: true }
check('a door resolves to a position on its wall', Boolean(objectCentre(door, [doorWall])))
const farCorner = computeBlindSpots([hall], [{ ...camHall, x: 20, y: 20, rotation: 45, hFov: 90, distance: 2 }], [door])
check('a short-range camera leaves gaps', farCorner.length > 0 && farCorner[0].cells.length > 4, JSON.stringify(farCorner.map((b) => b.cells.length)))

// ── Field of view ────────────────────────────────────────────────────────────
console.log('\nSight lines')
check('a point in front and in range is seen', cameraSeesPoint(camHall, { x: 200, y: 120 }))
check('a point behind the camera is not', !cameraSeesPoint(camHall, { x: 40, y: 120 }))
check('a point beyond its range is not', !cameraSeesPoint(camHall, { x: 700, y: 120 }))
check('a point just outside the cone is not', !cameraSeesPoint({ ...camHall, rotation: 90, hFov: 30 }, { x: 200, y: 240 }))

// ── Score ────────────────────────────────────────────────────────────────────
console.log('\nSecurity score')
const empty = computeHealthScore([hall], [], [], [])
const covered = computeHealthScore([hall], [camCorner], [], [])
check('a score is a number out of 100', empty.score >= 0 && empty.score <= 100, String(empty.score))
check('a camera that covers the room raises the score', covered.score > empty.score, `${empty.score} → ${covered.score}`)
check('the room now counts as watched', covered.checks.find((c) => c.key === 'coverage')?.earned === 20, JSON.stringify(covered.checks.find((c) => c.key === 'coverage')))
check('the score explains itself', Array.isArray(covered.checks) && covered.checks.length >= 4, JSON.stringify(covered.checks?.length))
check('each check names what it is', covered.checks.every((c) => typeof c.label === 'string' && typeof c.earned === 'number'), JSON.stringify(covered.checks))
const band = scoreBand(covered.score)
check('a band with a label and a tone is returned', typeof band?.label === 'string' && typeof band?.tone === 'string', JSON.stringify(band))
check('the bands rise with the score', scoreBand(90).tone === 'good' && scoreBand(0).tone === 'bad', `${scoreBand(90).tone}/${scoreBand(0).tone}`)

// ── Point in polygon ─────────────────────────────────────────────────────────
console.log('\nGeometry')
check('inside a room', isPointInPolygon(120, 120, hall.points))
check('outside a room', !isPointInPolygon(300, 120, hall.points))
check('on the far side of a wall', !isPointInPolygon(600, 120, hall.points))

console.log(`\n${failures === 0 ? 'All plan checks passed.' : `${failures} check(s) failed.`}`)
process.exit(failures === 0 ? 0 : 1)
