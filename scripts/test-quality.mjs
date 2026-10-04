import assert from 'node:assert/strict'
import {
  pixelsPerMetreAt, tierForDensity, qualityAtPoint, computeCoverageQuality,
  describeCoverageQuality, DEFAULT_RESOLUTION_PIXELS,
} from '../src/editor/quality.js'
import { lineOfSightBlocked, PIXELS_PER_METER } from '../src/editor/plan-drawing.js'
import { roomRiskMultiplier, buildTargets, MAX_TARGET_WEIGHT, ROOM_RISK_MULTIPLIERS } from '../src/editor/coverage-plan.js'

const at = metres => metres * PIXELS_PER_METER
const room = (id, roomType, offsetM = 0) => ({
  id, closed: true, roomType,
  points: [{ x: at(offsetM), y: 0 }, { x: at(offsetM + 10), y: 0 }, { x: at(offsetM + 10), y: at(10) }, { x: at(offsetM), y: at(10) }],
})
const cam = (over = {}) => ({ id: 1, x: 0, y: at(2), rotation: 0, hFov: 90, distance: 40, resolutionPixels: 1920, ...over })
// 1920 px at 90°: 250 px/m to 3.84 m, 100 px/m to 9.6 m, 25 px/m to 38.4 m.

// ── Pixel density: the exact maths the score panel quotes ──
assert.equal(Math.round(pixelsPerMetreAt(cam(), 10) * 10) / 10, 96) // 1920 / (2·10·tan45°)
assert.equal(pixelsPerMetreAt(cam({ resolutionPixels: 0 }), 10), pixelsPerMetreAt(cam({ resolutionPixels: DEFAULT_RESOLUTION_PIXELS }), 10))
assert.equal(pixelsPerMetreAt(cam(), 0), 0)
console.log('✓ pixel density falls with distance and unknown resolution uses the stated default')

// ── Threshold fixtures: below / at / above 25, 100, 250 px/m ──
assert.equal(tierForDensity(24.9), null)
assert.equal(tierForDensity(25).id, 'detect')
assert.equal(tierForDensity(99.9).id, 'detect')
assert.equal(tierForDensity(100).id, 'recognize')
assert.equal(tierForDensity(249.9).id, 'recognize')
assert.equal(tierForDensity(250).id, 'identify')
console.log('✓ detect / recognize / identify thresholds are inclusive and ordered')

// ── Per-point verdicts: range, cone, walls and quality kept apart ──
// A 45 m hall, so every point below is inside the room and no wall lies between.
{
  const walls = [{ id: 1, closed: true, points: [{ x: 0, y: 0 }, { x: at(45), y: 0 }, { x: at(45), y: at(20) }, { x: 0, y: at(20) }] }]
  const shot = (over = {}) => cam({ x: at(1), ...over })
  const point = (metres) => ({ x: at(1 + metres), y: at(2) })
  assert.equal(qualityAtPoint(shot(), point(2), walls, []), 'identify')    // 480 px/m at 2 m
  assert.equal(qualityAtPoint(shot(), point(8), walls, []), 'recognize')   // 120 px/m at 8 m
  assert.equal(qualityAtPoint(shot(), point(30), walls, []), 'detect')     // 32 px/m at 30 m
  assert.equal(qualityAtPoint(shot(), point(39), walls, []), 'below')      // 24.6 px/m at 39 m
  assert.equal(qualityAtPoint(shot({ rotation: 180 }), point(2), walls, []), 'blind')
  assert.equal(qualityAtPoint(shot({ distance: 1 }), point(5), walls, []), 'blind')
  console.log('✓ visible-but-too-grainy is kept distinct from blind, and range/cone still apply')
}

// ── Heights: a safe is looked over, a wardrobe is not ──
{
  const walls = [{ id: 1, closed: true, points: [{ x: 0, y: 0 }, { x: at(45), y: 0 }, { x: at(45), y: at(20) }, { x: 0, y: at(20) }] }]
  const from = { x: at(1), y: at(2) }, target = { x: at(6), y: at(2) }
  const opts = { cameraHeightM: 2.5, targetHeightM: 1.5 }
  const lowSafe = [{ id: 2, presetId: 'safe', x: at(3.5), y: at(2), width: 0.45, height: 0.4, blocksVision: true, obstructionHeightM: 0.45 }]
  const wardrobe = [{ ...lowSafe[0], presetId: 'wardrobe', width: 2, height: 0.6, obstructionHeightM: 2.2 }]
  assert.equal(lineOfSightBlocked(from.x, from.y, target.x, target.y, walls, lowSafe, opts), false)
  assert.equal(lineOfSightBlocked(from.x, from.y, target.x, target.y, walls, wardrobe, opts), true)
  assert.equal(lineOfSightBlocked(from.x, from.y, target.x, target.y, walls, wardrobe, { ...opts, targetHeightM: 0.2 }), true)
  const legacy = [{ ...lowSafe[0], obstructionHeightM: undefined }]
  assert.equal(lineOfSightBlocked(from.x, from.y, target.x, target.y, walls, legacy, opts), true)
  console.log('✓ low furniture is looked over, tall furniture and legacy objects block')
}

// ── Rotated footprint: a wardrobe turned out of the sight line stops blocking ──
{
  const walls = [{ id: 1, closed: true, points: [{ x: 0, y: 0 }, { x: at(45), y: 0 }, { x: at(45), y: at(20) }, { x: 0, y: at(20) }] }]
  const from = { x: at(1), y: at(2) }, target = { x: at(6), y: at(2) }
  const opts = { cameraHeightM: 2.5, targetHeightM: 1.5 }
  const beside = (rotation) => ([{
    id: 3, presetId: 'wardrobe', x: at(3.5), y: at(2.5), width: 0.2, height: 1.2,
    rotation, blocksVision: true, obstructionHeightM: 2.2,
  }])
  assert.equal(lineOfSightBlocked(from.x, from.y, target.x, target.y, walls, beside(0), opts), true)
  assert.equal(lineOfSightBlocked(from.x, from.y, target.x, target.y, walls, beside(90), opts), false)
  console.log('✓ a rotated obstruction blocks where it is drawn, not in an upright box')
}

// ── One visibility rule: quality and blind spots agree about doors ──
{
  const walls = [{ id: 1, closed: true, points: [{ x: 0, y: 0 }, { x: at(10), y: 0 }, { x: at(10), y: at(6) }, { x: 0, y: at(6) }] }]
  const door = [{ id: 2, presetId: 'door', wallId: 1, segmentIndex: 0, t1: 0.45, t2: 0.55, rotation: 90 }]
  const outside = cam({ x: at(5), y: -at(1), rotation: 90, distance: 30 })
  assert.equal(qualityAtPoint(outside, { x: at(5), y: at(1) }, walls, []), 'blind')
  assert.equal(qualityAtPoint(outside, { x: at(5), y: at(1) }, walls, door), 'identify')
  console.log('✓ the same doorway that opens blind spots opens quality too')
}

// ── Room sampling: blind, grainy and met counted separately ──
{
  const walls = [room(1), room(2, 'bedroom', 12)]
  const one = cam({ x: at(1), y: at(2), rotation: 0, distance: 30 })
  const result = computeCoverageQuality(walls, [one], [], { goal: { id: 'identify', pxPerM: 250 }, cellMetres: 1 })
  assert(result.blindArea > 0 && result.belowArea > 0 && result.metArea > 0)
  assert.equal(result.goal, 'identify')
  assert.equal(result.rooms.length, 2)
  assert.equal(result.rooms[0].wall.id, 2) // the far room is the worst one
  const total = result.blindArea + result.belowArea + result.metArea
  assert(Math.abs(total - 200) < 1, `expected 200 m² sampled, got ${total}`)
  assert(describeCoverageQuality(result).includes('identify'))
  console.log('✓ blind, grainy and met are counted separately, worst room first')
}

// ── Room risk weighting: modest, capped, and bedrooms stay downweighted ──
{
  assert.equal(roomRiskMultiplier('entrance'), ROOM_RISK_MULTIPLIERS.entrance)
  assert.equal(roomRiskMultiplier('unknown-room'), 1)
  assert(roomRiskMultiplier('entrance') > roomRiskMultiplier('general') && roomRiskMultiplier('general') > roomRiskMultiplier('bedroom'))
  const risky = room(1, 'entrance')
  const calm = room(2, 'bedroom', 12)
  const doorOn = (r) => [{ id: 10 + r.id, presetId: 'door', wallId: r.id, segmentIndex: 0, t1: 0.4, t2: 0.6, rotation: 90 }]
  const targets = buildTargets([risky, calm], [...doorOn(risky), ...doorOn(calm)])
  const riskyDoor = targets.find((t) => t.kind === 'door' && t.room === risky)
  const calmDoor = targets.find((t) => t.kind === 'door' && t.room === calm)
  assert(riskyDoor.weight > calmDoor.weight)
  assert(targets.every((t) => t.weight <= MAX_TARGET_WEIGHT))
  const safeInBedroom = buildTargets([calm], [{ id: 50, presetId: 'safe', x: at(16), y: at(4), width: 0.45, height: 0.4 }])
  const safeTarget = safeInBedroom.find((t) => t.kind === 'safe')
  assert(safeTarget)
  assert(Math.abs(safeTarget.weight - 3 * roomRiskMultiplier('bedroom')) < 0.001)
  console.log('✓ risk weighting is modest, capped, and bedrooms are downweighted')
}

// ── Cost stays bounded on a large plan, measured rather than assumed ──
{
  const big = Array.from({ length: 12 }, (_, i) => room(i + 1, 'living', (i % 4) * 12) && {
    id: i + 1, closed: true, roomType: 'living',
    points: [
      { x: at((i % 4) * 12), y: at(Math.floor(i / 4) * 12) },
      { x: at((i % 4) * 12 + 10), y: at(Math.floor(i / 4) * 12) },
      { x: at((i % 4) * 12 + 10), y: at(Math.floor(i / 4) * 12 + 10) },
      { x: at((i % 4) * 12), y: at(Math.floor(i / 4) * 12 + 10) },
    ],
  })
  const cams = Array.from({ length: 24 }, (_, i) => cam({
    id: i + 1, x: at((i % 4) * 12 + 2), y: at(Math.floor(i / 4) * 12 + 2), rotation: 45, distance: 30,
  }))
  const started = performance.now()
  const result = computeCoverageQuality(big, cams, [], { goal: { id: 'recognize', pxPerM: 100 }, cellMetres: 1 })
  const ms = performance.now() - started
  assert.equal(result.rooms.length, 12)
  assert(ms < 1500, `quality sampling took ${Math.round(ms)} ms`)
  console.log(`✓ 12-room / 24-camera analysis measured at ${Math.round(ms)} ms`)
}

console.log('Quality regression checks passed.')
