// ─── Duplicate tests ─────────────────────────────────────────────────────────
// Where a copy lands. The awkward cases are the ones worth checking: a second window on
// a wall with no room left, a door at the very end of a wall, a free object already in a
// corner. None of them should leave an item hanging outside the room it belongs to.
//
//   bun run duplicate:test

import { duplicateCamera, duplicateObject, offsetAlongWall, duplicateOffset, DUPLICATE_OFFSET_METERS } from '../src/editor/duplicate.js'
import { PIXELS_PER_METER } from '../src/editor/plan-drawing.js'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

const camera = (id, x, y) => ({ id, x, y, rotation: 45, hFov: 110, distance: 10, color: '#4ade80' })
const windowOnWall = (t1, t2) => ({ id: 1, presetId: 'window', wallId: 7, segmentIndex: 2, t1, t2 })

console.log('\nA camera')
{
  const original = camera(1, 200, 300)
  const copy = duplicateCamera(original)
  check('the copy is offset rather than stacked', copy.x !== original.x || copy.y !== original.y)
  check('the offset is the documented half metre', copy.x - original.x === duplicateOffset() && duplicateOffset() === DUPLICATE_OFFSET_METERS * PIXELS_PER_METER)
  check('the original is untouched', original.x === 200 && original.y === 300)
  check('the aim, lens and range come along', copy.rotation === 45 && copy.hFov === 110 && copy.distance === 10)
  check('the copy has no id of its own yet', copy.id === 1 && duplicateCamera({ ...original, id: undefined }).id === undefined)
  check('rubbish in gives nothing out', duplicateCamera(null) === null)
}

console.log('\nA free-standing object')
{
  const safe = { id: 3, presetId: 'safe', x: 100, y: 100, width: 0.6, height: 0.5, rotation: 90 }
  const copy = duplicateObject(safe)
  check('it is offset like a camera', copy.x === 100 + duplicateOffset() && copy.y === 100 + duplicateOffset())
  check('its size and rotation are kept', copy.width === 0.6 && copy.rotation === 90)
  check('a power outlet copies the same way', duplicateObject({ id: 4, presetId: 'power', x: 0, y: 0 }).x === duplicateOffset())
  check('an object with no coordinates is not a crash', duplicateObject({ id: 5, presetId: 'safe' }).x === duplicateOffset())
}

console.log('\nA window on a wall')
{
  const copy = duplicateObject(windowOnWall(0.2, 0.3))
  check('it stays on its wall', copy.wallId === 7 && copy.segmentIndex === 2)
  check('it moves along the wall, not off it', Math.abs(copy.t1 - 0.32) < 1e-9 && Math.abs(copy.t2 - 0.42) < 1e-9, `t1=${copy.t1}`)
  check('it does not land on top of the original', copy.t1 >= 0.3 - 1e-9)
  check('and it has no coordinates of its own', copy.x === undefined && copy.y === undefined)
}

console.log('\nNowhere left to go')
{
  const atEnd = offsetAlongWall({ t1: 0.85, t2: 0.95 })
  check('a copy at the end of a wall goes to the other side', atEnd.t2 <= 0.95 + 1e-9 && atEnd.t1 < 0.85)
  check('it stays on the wall', atEnd.t1 >= 0 && atEnd.t2 <= 1)

  const noRoom = offsetAlongWall({ t1: 0, t2: 0.9 })
  check('a wall with no room puts the copy at the start', noRoom.t1 === 0 && Math.abs(noRoom.t2 - 0.9) < 1e-9)
  check('rather than hanging off the end', noRoom.t2 <= 1 && noRoom.t1 >= 0)

  const full = offsetAlongWall({ t1: 0, t2: 1 })
  check('a wall entirely filled stays within it', full.t1 >= 0 && full.t2 <= 1)
  check('a whole-wall window does not become wider than the wall', full.t2 - full.t1 <= 1 + 1e-9)

  const tiny = offsetAlongWall({ t1: 0.98, t2: 0.99 })
  check('a copy near the very end is still on the wall', tiny.t1 >= 0 && tiny.t2 <= 1)
  check('missing span values do not produce NaN', Number.isFinite(offsetAlongWall({}).t1) && Number.isFinite(offsetAlongWall({}).t2))
}

console.log('\nA door')
{
  const door = { id: 9, presetId: 'door', wallId: 3, segmentIndex: 0, t1: 0.4, t2: 0.52, rotation: 0, hingeSide: 'left' }
  const copy = duplicateObject(door)
  check('the hinge side is kept', copy.hingeSide === 'left' && copy.rotation === 0)
  check('it slides to the next stretch of wall', copy.t1 > door.t1)
  check('and stays inside it', copy.t1 >= 0 && copy.t2 <= 1)
}

console.log(failures === 0 ? '\nAll duplicate checks passed.\n' : `\n${failures} duplicate check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
