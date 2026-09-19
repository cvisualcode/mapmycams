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
  PIXELS_PER_METER, lineOfSightBlocked, computeBlindSpots, cameraSeesPoint, computeHealthScore, scoreBand, isPointInPolygon, objectCentre, clickHitsWallShape,
  roomContaining, isOpeningPoint, polygonArea, coverageCheck, scoreWithAreaCoverage, describeBlindSpots, drawBlindSpots, toCanvas,
  OBJECT_PRESETS, SINGLE_SHOT_PRESETS, isSingleShot, shouldDisarmAfterPlacement, drawObject,
  objectRotateHandlePoint, isOnObjectRotateHandle, angleAbout, rotationFromDrag, toObjectFrame,
  ROTATE_GRIP_PX,
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
// Two rooms sharing the wall at x = 6 m, which is where the old model went wrong.
console.log('\nWall occlusion')
const wing = rect(m(6), 0, m(6), m(6), 'Kitchen')
const pair = [hall, wing]
check('a wall between the camera and the target blocks it', lineOfSightBlocked(m(3), m(3), m(9), m(3), pair, []))
check('a point in the same room is visible from inside it', !lineOfSightBlocked(m(3), m(3), m(5), m(5), pair, []))
check('a room does not block a view of a target inside it', !lineOfSightBlocked(m(0.25), m(0.25), m(5.75), m(5.75), pair, []))
// The regression this rewrite exists for: the room being looked at was exempt from its
// own boundary, so any camera outside the house was credited with seeing into every
// room through its wall — and every room was reported as covered.
check('a camera outside the house cannot see through a wall into a room', lineOfSightBlocked(m(-2), m(3), m(3), m(3), pair, []))
// An interior partition drawn as an open line blocks a view too. It used to be
// invisible: only closed rooms were consulted, by the sampler and by the solver.
const partition = { id: 'p1', closed: false, label: 'Partition', points: [{ x: m(3), y: 0 }, { x: m(3), y: m(6) }] }
check('an interior partition drawn as an open line blocks the view', lineOfSightBlocked(m(1), m(3), m(5), m(3), [hall, partition], []))
check('…but not a view that stays on one side of it', !lineOfSightBlocked(m(1), m(1), m(2), m(4), [hall, partition], []))
check('the room containing a point is reported', roomContaining(m(3), m(3), pair) === hall && roomContaining(m(9), m(3), pair) === wing)
check('a point outside every room belongs to none', roomContaining(m(-2), m(3), pair) === null)

// ── Doorways, windows and things in the way ──────────────────────────────────
console.log('\nDoorways and windows')
// A 0.6 m doorway in the middle of the shared wall at x = 6 m, swung open so the leaf
// lies along the wall's perpendicular and the opening itself is clear.
const swing = { id: 'd1', presetId: 'door', wallId: hall.id, segmentIndex: 1, t1: 0.45, t2: 0.55, rotation: 0, hingeSide: 'right', width: 0.9, height: 0.1, blocksVision: true }
check('a doorway is a hole in the wall', !lineOfSightBlocked(m(3), m(3), m(9), m(3), pair, [swing]))
check('…and both rooms carry the hole, not just the one it was placed on', isOpeningPoint(m(6), m(3), pair, [swing]))
check('the wall either side of the doorway still blocks', lineOfSightBlocked(m(3), m(1), m(9), m(1), pair, [swing]))
check('a door leaf across its own opening blocks it (a closed door)', lineOfSightBlocked(m(3), m(3), m(9), m(3), pair, [{ ...swing, rotation: 90 }]))
check('a swung door leaf casts a shadow of its own', lineOfSightBlocked(m(5.7), m(2.4), m(5.7), m(4.6), pair, [swing]))
const pane = { id: 'w1', presetId: 'window', wallId: hall.id, segmentIndex: 1, t1: 0.45, t2: 0.55, width: 1.2, height: 0.1, blocksVision: false }
check('a window is a hole too', !lineOfSightBlocked(m(3), m(3), m(9), m(3), pair, [pane]))
const safe = { id: 's1', presetId: 'safe', x: m(3), y: m(3), width: 0.6, height: 0.5, blocksVision: true }
check('a safe between the camera and the target blocks the view', lineOfSightBlocked(m(1), m(3), m(5), m(3), [hall], [safe]))
check('…but looking at the safe itself is not blocked by it', !lineOfSightBlocked(m(1), m(3), m(3), m(3), [hall], [safe]))

// ── Blind spots ──────────────────────────────────────────────────────────────
console.log('\nBlind spots')
const blind = computeBlindSpots(pair, [camCorner], [])
const kitchenBlind = blind.find((b) => b.label === 'Kitchen')
check('a room no camera can see is reported blind', Boolean(kitchenBlind), JSON.stringify(blind.map((b) => b.label)))
// The kitchen is 6 × 6 m: a camera 6 m away with a 110° lens is inside range of it, so
// only the wall keeps it honest. This is the test that used to pass through the wall.
check('a wall is not seen through to the neighbouring room', Math.abs((kitchenBlind?.area || 0) - 36) < 0.01, String(kitchenBlind?.area))
check('…and the whole of it is blind', (kitchenBlind?.fraction || 0) > 0.99, String(kitchenBlind?.fraction))
check('rooms come back worst first', blind.every((spot, i) => i === 0 || blind[i - 1].area >= spot.area))

const noCameras = computeBlindSpots([hall], [], [])
check('with no cameras at all, every room is blind', noCameras.length === 1 && noCameras[0].cells.length > 0)
// The area has to come out in real square metres, not in cells or pixels.
check('the area is reported in square metres', Math.abs(noCameras[0].area - 36) < 0.01, String(noCameras[0].area))
check('the floor is sampled at half a metre', Math.abs(noCameras[0].cellMetres - 0.5) < 1e-9, String(noCameras[0].cellMetres))

const cornered = computeBlindSpots([hall], [camCorner], [])
check('a camera in the corner sees its whole room', cornered.length === 0, JSON.stringify(cornered.map((b) => b.area)))
const middled = computeBlindSpots([hall], [camMid], [])
check('a camera in the middle of the room leaves gaps behind it', middled.length === 1 && middled[0].cells.length > 0, JSON.stringify(middled.map((b) => b.area)))

// Through a doorway the next room becomes partly watchable — the placement an
// installer actually wants, and something the report could not see before.
const throughDoor = computeBlindSpots(pair, [{ ...camHall, x: m(5), y: m(3), rotation: 0, hFov: 90, distance: 6 }], [swing])
const doorKitchen = throughDoor.find((b) => b.label === 'Kitchen')
check('a doorway puts part of the next room in view', Boolean(doorKitchen) && doorKitchen.area < 36, String(doorKitchen?.area))
check('…but most of it is still blind', (doorKitchen?.fraction || 0) > 0.5, String(doorKitchen?.fraction))

// A partition splits coverage even though it is not a closed room.
const split = computeBlindSpots([hall, partition], [camCorner], [])
check('an interior partition splits the coverage', split.length === 1 && split[0].fraction > 0.05 && split[0].fraction < 0.95, JSON.stringify(split.map((b) => b.fraction)))

// A door on the wall is solid: it blocks the view through the opening.
const doorWall = { ...hall, id: 'door-wall' }
const door = { presetId: 'door', wallId: 'door-wall', segmentIndex: 1, t1: 0.4, t2: 0.6, width: 0.9, height: 0.1, blocksVision: true }
check('a door resolves to a position on its wall', Boolean(objectCentre(door, [doorWall])))
const farCorner = computeBlindSpots([hall], [{ ...camHall, x: m(0.5), y: m(0.5), rotation: 45, hFov: 90, distance: 2 }], [door])
check('a short-range camera leaves gaps', farCorner.length > 0 && farCorner[0].cells.length > 4, JSON.stringify(farCorner.map((b) => b.area)))

// ── What the report says, and what the plan paints ──────────────────────────
console.log('\nCoverage in words, and on the canvas')
const words = describeBlindSpots(blind)
check('the summary leads with the total and names the worst room', /^0\.0 m² blind/.test(words) === false && /m² blind — Kitchen/.test(words), words)
check('it says when there is nothing to report', describeBlindSpots([]) === '', describeBlindSpots([]))

const gap = computeBlindSpots([hall], [camMid], [])
const scored = coverageCheck(gap, [hall])
check('coverage is scored on the area that is unwatched', scored.earned > 0 && scored.earned < 20, JSON.stringify(scored))
check('the ratio is the blind share of the floor', Math.abs(scored.ratio - gap[0].area / 36) < 0.01, `${scored.ratio} vs ${gap[0].area / 36}`)
check('the advice says how many square metres', /m² of 36\.0 m²/.test(scored.advice), scored.advice)
// The room count and the area disagree here, which is the whole point: one room with a
// 60% gap used to score 0 coverage, exactly like a room no camera reaches.
const before = computeHealthScore([hall], [camMid], [], [])
const after = scoreWithAreaCoverage(before, [hall])
check('the score table graded by room count, the panel by area', after.checks.find((c) => c.key === 'coverage').earned === scored.earned && before.checks.find((c) => c.key === 'coverage').earned !== scored.earned, JSON.stringify([before.checks.find((c) => c.key === 'coverage').earned, scored.earned]))
check('…and the total moves by the same amount', after.score === before.score - before.checks.find((c) => c.key === 'coverage').earned + scored.earned, JSON.stringify([before.score, after.score]))
const fullyCovered = scoreWithAreaCoverage(computeHealthScore([hall], [camCorner], [], []), [hall])
check('a fully covered plan still scores full marks for coverage', fullyCovered.checks.find((c) => c.key === 'coverage').earned === 20, JSON.stringify(fullyCovered.checks.find((c) => c.key === 'coverage')))
check('with no rooms there is nothing to score', coverageCheck([], []).earned === 0)

// The overlay is drawn inside the canvas render, so it must never throw.
function stubCtx() {
  const calls = []
  const record = (name) => (...args) => calls.push({ name, args })
  return {
    calls,
    save: record('save'), restore: record('restore'),
    translate: record('translate'), rotate: record('rotate'), scale: record('scale'),
    fillRect: record('fillRect'), strokeRect: record('strokeRect'), clearRect: record('clearRect'),
    beginPath: record('beginPath'), moveTo: record('moveTo'), lineTo: record('lineTo'),
    stroke: record('stroke'), fill: record('fill'), arc: record('arc'), closePath: record('closePath'),
    setLineDash: record('setLineDash'), strokeText: record('strokeText'), fillText: record('fillText'),
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: '', textBaseline: '',
  }
}
const ctx = stubCtx()
const origin = { x: 0, y: 0 }
const pan = { x: 0, y: 0 }
drawBlindSpots(ctx, gap, origin, pan, 1)
check('the overlay paints one square per blind cell', ctx.calls.filter((c) => c.name === 'fillRect').length === gap[0].cells.length, `${ctx.calls.filter((c) => c.name === 'fillRect').length} vs ${gap[0].cells.length}`)
check('it labels the room with its blind area', ctx.calls.some((c) => c.name === 'fillText' && /^\d+\.\d m² blind$/.test(c.args[0])), JSON.stringify(ctx.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])))
check('it puts the canvas state back', ctx.calls[0]?.name === 'save' && ctx.calls[ctx.calls.length - 1]?.name === 'restore')
// The patches have to land on the cells they stand for, whatever the pan and zoom.
const panned = stubCtx()
const shifted = { x: 40, y: -25 }
drawBlindSpots(panned, gap, origin, shifted, 2)
const square = panned.calls.find((c) => c.name === 'fillRect').args
const target = toCanvas(gap[0].cells[0].x, gap[0].cells[0].y, origin, shifted, 2)
check('a square is centred on the cell it stands for', Math.abs(square[0] + square[2] / 2 - target.x) < 1e-6 && Math.abs(square[1] + square[3] / 2 - target.y) < 1e-6, JSON.stringify([square, target]))
check('…and is drawn at the plan\u2019s scale', Math.abs(square[2] - gap[0].cell * 2) < 1e-6, `${square[2]} vs ${gap[0].cell * 2}`)
const emptyCtx = stubCtx()
drawBlindSpots(emptyCtx, [], origin, pan, 1)
check('nothing to show draws nothing', emptyCtx.calls.length === 0)
check('a polygon\u2019s area is its area', Math.abs(polygonArea(hall.points) / (PIXELS_PER_METER ** 2) - 36) < 1e-9, String(polygonArea(hall.points) / (PIXELS_PER_METER ** 2)))

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

// ── Objects and how they behave when placed ──────────────────────────────────
console.log('\nObjects')
const sizeOf = (id) => OBJECT_PRESETS.find((p) => p.id === id)
check('a safe is a safe-sized box, not half a metre and a bit', sizeOf('safe').width <= 0.5 && sizeOf('safe').height <= 0.45, `${sizeOf('safe').width} × ${sizeOf('safe').height}`)
check('a socket is scaled to a plate rather than a paving slab', sizeOf('power').width <= 0.25 && sizeOf('power').height <= 0.2, `${sizeOf('power').width} × ${sizeOf('power').height}`)
// The deliberate fudge: a real 146 × 86 mm plate is 12 × 7 px at 100% zoom, which no
// finger can hit. Only the free-standing objects have to clear a finger — a window or a
// door is picked along its span in the wall, whatever its thickness.
const freeStanding = OBJECT_PRESETS.filter((p) => !p.mounted)
const smallest = Math.min(...freeStanding.map((p) => Math.min(p.width, p.height)))
check('every free-standing object stays tappable at 100% zoom', smallest * PIXELS_PER_METER >= 10, `${(smallest * PIXELS_PER_METER).toFixed(1)} px`)
check('what is mounted on a wall says so', OBJECT_PRESETS.filter((p) => p.mounted).map((p) => p.id).join(',') === 'window,door')
check('only the stairs are one-at-a-time', OBJECT_PRESETS.every((p) => Boolean(p.singleShot) === p.id.startsWith('stairs')), JSON.stringify(SINGLE_SHOT_PRESETS))

console.log('\nPutting a tool down')
const placed = { added: 1, mode: 'object', armedPresetId: 'stairs-straight', placedPresetId: 'stairs-straight' }
check('a stair puts the tool down', shouldDisarmAfterPlacement(placed))
check('…so another has to be asked for', shouldDisarmAfterPlacement({ ...placed, placedPresetId: 'safe' }) === false)
check('a safe or a socket is a rubber stamp', shouldDisarmAfterPlacement({ ...placed, armedPresetId: 'safe', placedPresetId: 'safe' }) === false)
check('the tool stays put if it was not the one used', shouldDisarmAfterPlacement({ ...placed, mode: 'select' }) === false)
check('an undo does not knock the tool out of your hand', shouldDisarmAfterPlacement({ ...placed, added: -1 }) === false)
check('a plan arriving from a file is not a placement', shouldDisarmAfterPlacement({ ...placed, added: 4, armedPresetId: 'safe', placedPresetId: 'stairs-straight' }) === false)
check('nothing placed, nothing to put down', shouldDisarmAfterPlacement({ ...placed, added: 0 }) === false)

// A stair is only useful if it can be turned to suit the house, and turning it is a
// rotation on the object that the drawing has to honour.
const stair = { id: 1, presetId: 'stairs-straight', x: m(3), y: m(3), rotation: 90, width: 1.1, height: 0.35 }
const stairCtx = stubCtx()
drawObject(stairCtx, stair, atOrigin, atOrigin, 1, [hall])
const rotation = stairCtx.calls.find((c) => c.name === 'rotate')
check('a stair draws where it stands', stairCtx.calls.some((c) => c.name === 'translate' && c.args[0] > 0), JSON.stringify(stairCtx.calls.find((c) => c.name === 'translate')))
check('…and turns when it is rotated', rotation && Math.abs(rotation.args[0] - Math.PI / 2) < 1e-9, JSON.stringify(rotation && rotation.args))
const straightCtx = stubCtx()
drawObject(straightCtx, { ...stair, rotation: 0 }, atOrigin, atOrigin, 1, [hall])
check('…and not when it is not', straightCtx.calls.find((c) => c.name === 'rotate').args[0] === 0)

// ── Turning an object ────────────────────────────────────────────────────────
// A turned object has to be grabbable where it is drawn, and every one of these is the
// same rectangle seen three times: the shape that is drawn, the shape a press lands on,
// and the shape a drag turns about its centre.
console.log('\nTurning what is on the plan')
const turnable = { id: 7, presetId: 'stairs-straight', x: m(3), y: m(3), width: 1.1, height: 0.35, rotation: 0 }
const gripAt = (rotation) => objectRotateHandlePoint({ ...turnable, rotation }, [], atOrigin, atOrigin, 1)
check('a stair offers a grip to turn it', Boolean(gripAt(0)))
check('the grip sits clear of its edge', Math.abs(Math.hypot(gripAt(0).x - gripAt(0).centre.x, gripAt(0).y - gripAt(0).centre.y) - (m(1.1) / 2 + ROTATE_GRIP_PX)) < 1e-9)
check('the grip travels with the object', Math.abs(gripAt(90).y - gripAt(90).centre.y) > 40 && Math.abs(gripAt(90).x - gripAt(90).centre.x) < 1e-9, JSON.stringify(gripAt(90)))
check('a press on the grip is a press on the grip', isOnObjectRotateHandle(gripAt(45).x, gripAt(45).y, { ...turnable, rotation: 45 }, [], atOrigin, atOrigin, 1))
check('a press a long way off it is not', !isOnObjectRotateHandle(gripAt(45).x + 40, gripAt(45).y, { ...turnable, rotation: 45 }, [], atOrigin, atOrigin, 1))
// A window is a span along a wall and a door carries its own hinge handle, so neither
// should grow a second one for the same job.
check('a window has no grip of its own', objectRotateHandlePoint({ id: 8, presetId: 'window', wallId: 'w', t1: 0.2, t2: 0.5 }, [hall], atOrigin, atOrigin, 1) === null)
check('a door has no grip of its own', objectRotateHandlePoint({ id: 9, presetId: 'door', x: m(3), y: m(3), rotation: 0 }, [], atOrigin, atOrigin, 1) === null)
check('something with no place on the plan has no grip', objectRotateHandlePoint({ id: 10, presetId: 'safe' }, [], atOrigin, atOrigin, 1) === null)

check('an angle is measured about the object, not the origin', angleAbout({ x: 0, y: 0 }, { x: 0, y: 10 }) === 90)
check('…and never comes back negative', angleAbout({ x: 0, y: 0 }, { x: -10, y: 0 }) === 180 && angleAbout({ x: 0, y: 0 }, { x: 0, y: -4 }) === 270)
check('grabbing a grip does not snap the object to the pointer', rotationFromDrag(0, 200, 200) === 0)
check('a quarter turn is a quarter turn', rotationFromDrag(0, 0, 90) === 90)
check('…in either direction', rotationFromDrag(0, 90, 0) === 270)
check('…and past a full turn it comes back round', rotationFromDrag(350, 0, 20) === 10)
check('half a degree of drag is not half a degree of plan', rotationFromDrag(0, 0, 44.6) === 45)
// Into the object's own frame: what was to the east of it is along its width when it lies
// at 0°, and along its height once it has been turned a quarter turn.
const frame = toObjectFrame({ x: m(1), y: 0 }, { x: 0, y: 0 }, 90)
check('a point a metre east is measured along the object\'s width', Math.abs(frame.x) < 1e-9 && Math.abs(frame.y + m(1)) < 1e-9, JSON.stringify(frame))
// Sockets and safes are drawn as their box, so what is drawn and what is clickable are
// the same rectangle — the whole reason picking can work off the object's size.
const safeCtx = stubCtx()
drawObject(safeCtx, { id: 2, presetId: 'safe', x: m(3), y: m(3), width: 0.45, height: 0.4 }, atOrigin, atOrigin, 1, [hall])
const safeBox = safeCtx.calls.find((c) => c.name === 'fillRect')
check('a safe is drawn at the size it is stored', Math.abs(Math.abs(safeBox.args[2]) - 0.45 * PIXELS_PER_METER) < 1e-6 && Math.abs(Math.abs(safeBox.args[3]) - 0.4 * PIXELS_PER_METER) < 1e-6, JSON.stringify(safeBox.args))

// ── Point in polygon ─────────────────────────────────────────────────────────
console.log('\nGeometry')
check('inside a room', isPointInPolygon(m(3), m(3), hall.points))
check('outside a room', !isPointInPolygon(m(7.5), m(3), hall.points))
check('on the far side of a wall', !isPointInPolygon(m(15), m(3), hall.points))

console.log(`\n${failures === 0 ? 'All plan checks passed.' : `${failures} check(s) failed.`}`)
process.exit(failures === 0 ? 0 : 1)
