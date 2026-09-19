// ─── Plan geometry tests ─────────────────────────────────────────────────────
// The pure geometry in src/editor/plan-drawing.js: wall occlusion, the blind-spot
// sampler and the security score. These are the functions the coverage promises of
// the product rest on, and they need no browser to check.
//
// Fixtures are given in metres and converted with PIXELS_PER_METER, so changing the
// drawing scale cannot quietly invalidate an assertion.
//
//   bun run plan:test

import {
  PIXELS_PER_METER, segRayBlocked, computeBlindSpots, cameraSeesPoint, computeHealthScore, scoreBand, isPointInPolygon, objectCentre, clickHitsWallShape,
} from '../src/editor/plan-drawing.js'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

// Metres → world pixels.
const m = (metres) => metres * PIXELS_PER_METER

const rect = (x, y, w, h, label) => ({
  id: `w-${label}`,
  closed: true,
  label,
  points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
})

// A 6 × 6 m hall with a 6 × 6 m kitchen 4 m to the east of it.
const hall = rect(0, 0, m(6), m(6), 'Hall')
const kitchen = rect(m(10), 0, m(6), m(6), 'Kitchen')
// A camera in the middle of a room pointing east only watches a slice of it — which
// is exactly why coverage decides placement (see test-coverage.mjs). A camera in a
// corner, aiming across the room, sees all of it.
const camMid = { id: 'c1', x: m(3), y: m(3), rotation: 0, hFov: 110, distance: 12 }
const camCorner = { id: 'c2', x: m(0.25), y: m(0.25), rotation: 45, hFov: 110, distance: 12 }
const camHall = camMid

// ── Wall occlusion ───────────────────────────────────────────────────────────
console.log('\nWall occlusion')
const wallBetween = { a1: { x: m(7.5), y: m(-1.25) }, a2: { x: m(7.5), y: m(7.5) } }
check('a wall between the camera and the target blocks it', segRayBlocked(m(3), m(3), m(12.5), m(2.5), wallBetween.a1, wallBetween.a2, hall, kitchen))
check('a wall off to one side does not', !segRayBlocked(m(3), m(3), m(5), m(2.5), wallBetween.a1, wallBetween.a2, hall, kitchen))
check("a room's own boundary does not block its own targets", !segRayBlocked(m(3), m(3), m(5), m(5), { x: 0, y: 0 }, { x: m(6), y: 0 }, hall, hall))
check('the same boundary does block a target in the next room', segRayBlocked(m(3), m(3), m(12.5), m(2.5), { x: m(6), y: 0 }, { x: m(6), y: m(6) }, hall, kitchen))
// The regression this test exists for: the arithmetic used to come out NaN for every
// call, so nothing was ever blocked.
check('occlusion is actually computed, not silently NaN', segRayBlocked(0, 0, m(2.5), 0, { x: m(1.25), y: m(-0.25) }, { x: m(1.25), y: m(0.25) }, null, kitchen))

// ── Blind spots ──────────────────────────────────────────────────────────────
console.log('\nBlind spots')
const blind = computeBlindSpots([hall, kitchen], [camCorner], [])
const kitchenBlind = blind.find((b) => b.label === 'Kitchen')
check('a room no camera can see is reported blind', Boolean(kitchenBlind), JSON.stringify(blind.map((b) => b.label)))
check('every part of it is blind', (kitchenBlind?.cells?.length || 0) > 0, String(kitchenBlind?.cells?.length))
// The kitchen is 6 × 6 m, sampled every 1.5 m, so all 4 × 4 cells are blind.
check('a wall is not seen through to a neighbouring room', kitchenBlind?.cells?.length === 16, String(kitchenBlind?.cells?.length))

const noCameras = computeBlindSpots([hall], [], [])
check('with no cameras at all, every room is blind', noCameras.length === 1 && noCameras[0].cells.length > 0)
// 16 cells of 1.5 m: the area has to come out in real square metres, not in cells.
check('the area is reported in square metres', Math.abs(noCameras[0].area - 36) < 0.01, String(noCameras[0].area))

const cornered = computeBlindSpots([hall], [camCorner], [])
check('a camera in the corner sees its whole room', cornered.length === 0, JSON.stringify(cornered.map((b) => b.cells.length)))
const middled = computeBlindSpots([hall], [camMid], [])
check('a camera in the middle of the room leaves gaps behind it', middled.length === 1 && middled[0].cells.length > 0, JSON.stringify(middled.map((b) => b.cells.length)))

// A door on the wall is solid: it blocks the view through the opening.
const doorWall = { ...hall, id: 'door-wall' }
const door = { presetId: 'door', wallId: 'door-wall', segmentIndex: 1, t1: 0.4, t2: 0.6, width: 0.9, height: 0.1, blocksVision: true }
check('a door resolves to a position on its wall', Boolean(objectCentre(door, [doorWall])))
const farCorner = computeBlindSpots([hall], [{ ...camHall, x: m(0.5), y: m(0.5), rotation: 45, hFov: 90, distance: 2 }], [door])
check('a short-range camera leaves gaps', farCorner.length > 0 && farCorner[0].cells.length > 4, JSON.stringify(farCorner.map((b) => b.cells.length)))

// ── Field of view ────────────────────────────────────────────────────────────
console.log('\nSight lines')
check('a point in front and in range is seen', cameraSeesPoint(camHall, { x: m(5), y: m(3) }))
check('a point behind the camera is not', !cameraSeesPoint(camHall, { x: m(1), y: m(3) }))
check('a point beyond its range is not', !cameraSeesPoint(camHall, { x: m(17.5), y: m(3) }))
check('a point just outside the cone is not', !cameraSeesPoint({ ...camHall, rotation: 90, hFov: 30 }, { x: m(5), y: m(6) }))

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

// ── Picking a room by its wall ───────────────────────────────────────────────
// A room is picked by one of its walls, never by its floor — that is what leaves the
// things standing inside a room selectable. The slack is in canvas pixels, so it feels
// the same at every zoom.
console.log('\nRoom picking')
const atOrigin = { x: 0, y: 0 }
const pick = (metresX, metresY, zoom = 1) => clickHitsWallShape({ x: m(metresX), y: m(metresY) }, hall.points, atOrigin, atOrigin, zoom)
check('a click on a wall picks the room', pick(0, 3))
check('a click on a corner picks the room', pick(0, 0) && pick(6, 6))
check('a click just off the outside of a wall still picks it', pick(-0.05, 3))
check('a click in the middle of the room picks nothing', !pick(3, 3))
check('a click a metre short of the wall picks nothing', !pick(1, 3))
check('a click well outside the house picks nothing', !pick(-5, 3))
check('a wall picks only the room it belongs to', clickHitsWallShape({ x: m(10), y: m(3) }, kitchen.points, atOrigin, atOrigin, 1) && !clickHitsWallShape({ x: m(10), y: m(3) }, hall.points, atOrigin, atOrigin, 1))
check('the slack is what you see, not what the plan is measured in', !pick(-0.4, 3, 1) && pick(-0.4, 3, 0.2))
check('a shape with no line is not pickable', !clickHitsWallShape({ x: 0, y: 0 }, [{ x: 0, y: 0 }], atOrigin, atOrigin, 1))

// ── Point in polygon ─────────────────────────────────────────────────────────
console.log('\nGeometry')
check('inside a room', isPointInPolygon(m(3), m(3), hall.points))
check('outside a room', !isPointInPolygon(m(7.5), m(3), hall.points))
check('on the far side of a wall', !isPointInPolygon(m(15), m(3), hall.points))

console.log(`\n${failures === 0 ? 'All plan checks passed.' : `${failures} check(s) failed.`}`)
process.exit(failures === 0 ? 0 : 1)
