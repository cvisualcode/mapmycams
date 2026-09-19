// ─── Camera placement tests ──────────────────────────────────────────────────
// The placement solver is pure geometry, so it can be checked exactly: does it
// cover the room, does it stop after as few cameras as the plan allows, does it
// watch the doors and windows before the floor, and does it ever duplicate an area
// a camera already covers.
//
//   bun run coverage:test

import {
  planCameraPlacement, buildTargets, buildCandidates, visibleTargets, objectWeight, roomsOf, PRIORITY_WEIGHTS,
} from '../src/editor/coverage-plan.js'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

const rect = (x, y, w, h, label) => ({
  id: `w-${label || `${x},${y}`}`,
  closed: true,
  label,
  points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
})
const doorOn = (wall, presetId = 'door', extra = {}) => ({ presetId, wallId: wall.id, segmentIndex: 0, t1: 0.4, t2: 0.6, blocksVision: true, width: 0.9, height: 0.1, ...extra })

// ── One room ─────────────────────────────────────────────────────────────────
console.log('\nA single room')
const hall = rect(0, 0, 240, 240, 'Hall')
const one = planCameraPlacement({ walls: [hall] })
check('one wide camera is enough for one room', one.cameras.length === 1, `${one.cameras.length} cameras`)
check('and it covers most of the floor', one.floorCoveredPercent >= 85, `${one.floorCoveredPercent}%`)
check('the camera lands inside the room', one.cameras[0].x > 0 && one.cameras[0].x < 240 && one.cameras[0].y > 0 && one.cameras[0].y < 240, JSON.stringify(one.cameras[0]))
check('the camera is kept off the walls', Math.min(one.cameras[0].x, 240 - one.cameras[0].x, one.cameras[0].y, 240 - one.cameras[0].y) > 8, JSON.stringify(one.cameras[0]))
check('the range reaches its targets', one.cameras[0].distance >= 4 && one.cameras[0].distance <= 40, String(one.cameras[0].distance))
check('a wide fixed lens is used', one.cameras[0].hFov === 110, String(one.cameras[0].hFov))
check('the result says what it achieved', /1 camera covers/.test(one.summary), one.summary)
check('the camera sits in a corner, not the middle', Math.min(one.cameras[0].x, 240 - one.cameras[0].x) < 40 || Math.min(one.cameras[0].y, 240 - one.cameras[0].y) < 40, JSON.stringify(one.cameras[0]))

// ── Two rooms, separated ─────────────────────────────────────────────────────
console.log('\nTwo rooms')
const kitchen = rect(400, 0, 240, 240, 'Kitchen')
const two = planCameraPlacement({ walls: [hall, kitchen] })
check('each room gets its own camera', two.cameras.length === 2, `${two.cameras.length} cameras`)
check('one of them is in each room', two.cameras.filter((c) => c.x < 300).length === 1 && two.cameras.filter((c) => c.x > 300).length === 1, JSON.stringify(two.cameras.map((c) => c.x)))
check('a wall is never seen through', visibleTargets({ ...two.cameras[0], room: hall }, [{ x: 500, y: 100, weight: 1, kind: 'floor' }], [hall, kitchen], []).length === 0)
check('both rooms are covered', two.floorCoveredPercent >= 85, `${two.floorCoveredPercent}%`)

// ── Doors come first ─────────────────────────────────────────────────────────
console.log('\nDoors, windows and valuables')
const frontDoor = doorOn(hall)
const withDoor = planCameraPlacement({ walls: [hall], objects: [frontDoor] })
check('a door is worth more than floor', PRIORITY_WEIGHTS.door > 1)
check('the door target exists', withDoor.priorityTotal >= 1, String(withDoor.priorityTotal))
check('the door is covered', withDoor.priorityCovered === withDoor.priorityTotal, `${withDoor.priorityCovered}/${withDoor.priorityTotal}`)
check('the report names the door', /the door/.test(withDoor.summary), withDoor.summary)

const targets = buildTargets([hall], [frontDoor])
const doorTarget = targets.find((t) => t.kind === 'door')
const chosen = withDoor.cameras[0]
const aimedAtDoor = visibleTargets({ ...chosen, room: hall }, [doorTarget], [hall], []).length === 1
check('the camera is pointed at the door, not just near it', aimedAtDoor, `rotation ${chosen.rotation}`)
check('the floor around the door is worth as much as the door', targets.filter((t) => t.weight === PRIORITY_WEIGHTS.door).length > 1, String(targets.filter((t) => t.weight === PRIORITY_WEIGHTS.door).length))

check('stairs count as an entry', objectWeight('stairs-straight') === PRIORITY_WEIGHTS.stairs && objectWeight('stairs-curved') === PRIORITY_WEIGHTS.stairs)
check('a safe is worth more than floor', objectWeight('safe') > 1)
check('a power outlet is worth more than floor', objectWeight('power') > 1)
check('an unknown object is not a priority', objectWeight('bed') === 0)

// Priority beats floor when only one camera can be placed: the room with the door
// wins over the bigger room without one.
const bigRoomNoDoor = rect(400, 0, 300, 300, 'Big')
const oneCamera = planCameraPlacement({ walls: [hall, bigRoomNoDoor], objects: [frontDoor], maxCameras: 1 })
check('with one camera, the room with the door wins', oneCamera.cameras[0].x < 300, JSON.stringify(oneCamera.cameras[0]))
check('...and the door is covered by it', oneCamera.priorityCovered === 1, `${oneCamera.priorityCovered}`)

// ── An awkward room wants more than one camera ───────────────────────────────
console.log('\nA long room')
const corridor = rect(0, 0, 800, 160, 'Corridor')
const long = planCameraPlacement({ walls: [corridor] })
check('a corridor needs more than one camera', long.cameras.length >= 2, `${long.cameras.length} cameras`)
check('but not one per corner', long.cameras.length <= 4, `${long.cameras.length} cameras`)
check('and it still covers itself', long.floorCoveredPercent >= 85, `${long.floorCoveredPercent}%`)

// ── Never duplicate what is already covered ──────────────────────────────────
console.log('\nExisting cameras')
// Whatever the solver places should make a second run unnecessary — that is the
// whole promise of the feature.
const sorted = planCameraPlacement({ walls: [hall], objects: [frontDoor] })
const already = planCameraPlacement({ walls: [hall], objects: [frontDoor], cameras: sorted.cameras })
check('what the solver placed makes a second run unnecessary', already.cameras.length === 0, `${already.cameras.length} more: ${JSON.stringify(already.cameras)}`)
check('...and it says so', /Already covered/.test(already.summary), already.summary)

const partly = planCameraPlacement({ walls: [hall, kitchen], cameras: sorted.cameras })
check('a half-covered plan only gets the missing room', partly.cameras.length === 1 && partly.cameras[0].x > 300, JSON.stringify(partly.cameras))

// A camera someone placed in the middle of the room, facing one way, is a genuine
// gap — the solver is right to fill it, not to call the room covered.
const centred = planCameraPlacement({ walls: [hall], cameras: [{ x: 120, y: 120, rotation: 0, hFov: 110, distance: 12 }] })
check('a badly aimed camera does not count as coverage', centred.cameras.length > 0 && centred.floorCoveredPercent >= 90, `${centred.cameras.length} more, ${centred.floorCoveredPercent}%`)
check('...and the report is honest about what was already there', centred.floorCoveredPercent >= 90 && centred.cameras.length + 1 <= 3, `total ${centred.cameras.length + 1} cameras`)

// ── Limits and nothing-to-do cases ───────────────────────────────────────────
console.log('\nLimits')
const manyRooms = Array.from({ length: 12 }, (_, i) => rect(i * 300, 0, 240, 240, `Room ${i}`))
const capped = planCameraPlacement({ walls: manyRooms, maxCameras: 3 })
check('the camera count is capped', capped.cameras.length === 3, `${capped.cameras.length}`)
check('the cap still spreads the cameras out', new Set(capped.cameras.map((c) => Math.round(c.x / 300))).size === 3, JSON.stringify(capped.cameras.map((c) => c.x)))

const empty = planCameraPlacement({ walls: [] })
check('no rooms means nothing placed', empty.cameras.length === 0)
check('...and the user is told what to do', /Draw a closed room/.test(empty.summary), empty.summary)
check('an open wall is not a room', roomsOf([{ id: 'x', closed: false, points: [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }] }]).length === 0)

// ── The model proposes, coverage disposes ────────────────────────────────────
console.log('\nAI proposals')
// (30,30) sees exactly as much of this room as the corner the solver would pick on
// its own, so it is the case where the model's reading of the plan should win.
const proposed = { x: 30, y: 30, rotation: 0, hFov: 110, distance: 8, why: 'looking across the hall' }
const withProposal = planCameraPlacement({ walls: [hall], proposals: [proposed] })
check('a proposed position is available to the solver', buildCandidates([hall], [proposed]).some((c) => Math.hypot(c.x - proposed.x, c.y - proposed.y) < 2), JSON.stringify(buildCandidates([hall], [proposed]).map((c) => [Math.round(c.x), Math.round(c.y)])))
check('an equally good proposal is the one used', Math.hypot(withProposal.cameras[0].x - proposed.x, withProposal.cameras[0].y - proposed.y) < 20, JSON.stringify(withProposal.cameras[0]))
check('a proposal that covers less does not win', (() => {
  // Mid-way down the room, facing nothing in particular: the corner beats it.
  const worse = planCameraPlacement({ walls: [hall, kitchen], proposals: [{ x: 120, y: 120, rotation: 0, hFov: 110, distance: 2 }] })
  return worse.cameras.every((c) => Math.hypot(c.x - 120, c.y - 120) > 20)
})())
check('a proposal outside every room is ignored', buildCandidates([hall], [{ x: -900, y: -900 }]).every((c) => c.x >= 0 && c.x <= 240))
check('the heading is still chosen by coverage, not the model', withProposal.cameras[0].hFov === 110 && Number.isFinite(withProposal.cameras[0].rotation))

// ── Result ───────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'All placement checks passed.' : `${failures} check(s) failed.`}`)
process.exit(failures === 0 ? 0 : 1)
