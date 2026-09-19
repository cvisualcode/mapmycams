// ─── Picking tests ───────────────────────────────────────────────────────────
// Which object is under a tap. This is what decides whether tapping a safe picks it up
// or drops a second one on top of it, so it is worth being sure about.
//
//   bun run pick:test

import { PIXELS_PER_METER, OBJECT_PRESETS } from '../src/editor/plan-drawing.js'
import { findPlacedObjectAt, distanceToObject, PICK_SLACK_PX } from '../src/editor/pick.js'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

const m = (metres) => metres * PIXELS_PER_METER
const rect = (x, y, w, h, label) => ({
  id: label,
  closed: true,
  label,
  points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
})
const hall = rect(0, 0, m(6), m(6), 'Hall')

// A safe in the middle of the room, an outlet a metre away, a stair further off.
const safe = { id: 1, presetId: 'safe', x: m(3), y: m(3), width: 0.45, height: 0.4 }
const outlet = { id: 2, presetId: 'power', x: m(4), y: m(3), width: 0.2, height: 0.15 }
const stairs = { id: 3, presetId: 'stairs-straight', x: m(3), y: m(5), width: 1.1, height: 0.35 }
const objects = [safe, outlet, stairs]

console.log('\nPlaced objects')
check('a tap on the object picks it', findPlacedObjectAt({ x: m(3), y: m(3) }, objects, [hall]) === safe)
check('a tap just inside its edge picks it', findPlacedObjectAt({ x: m(3.2), y: m(3.15) }, objects, [hall]) === safe)
// 0.45 m is 36 px wide, so its edge is 18 px from the centre: a tap 25 px out is a miss
// at 100% zoom and a hit when the plan is zoomed out, where 25 px is a smaller distance.
// The safe is 36 px wide, so its edge is 18 px from the centre; 35 px is 17 px past it.
check('a tap beyond the slack misses', findPlacedObjectAt({ x: m(3) + 35, y: m(3) }, objects, [hall]) === null)
check('the same tap hits when the plan is zoomed out', findPlacedObjectAt({ x: m(3) + 35, y: m(3) }, objects, [hall], 0.3) === safe)
check('the slack is 12 screen pixels', PICK_SLACK_PX === 12 && distanceToObject({ x: m(3) + 18 + 10, y: m(3) }, safe, [hall]) > 0)
check('a tap in open floor picks nothing', findPlacedObjectAt({ x: m(1), y: m(1) }, objects, [hall]) === null)
// Two safes 0.5 m apart: the tap is inside the second one and only just past the first,
// so the nearer wins even though the other comes first in the list.
const left = { id: 6, presetId: 'safe', x: m(3), y: m(3), width: 0.45, height: 0.4 }
const right = { id: 7, presetId: 'safe', x: m(3.5), y: m(3), width: 0.45, height: 0.4 }
check('the nearest object wins, whatever order they were placed in', findPlacedObjectAt({ x: m(3.3), y: m(3) }, [left, right], [hall]) === right)
check('the outlet is pickable in its own right despite being 0.2 m', findPlacedObjectAt({ x: m(4), y: m(3) }, objects, [hall]) === outlet)
check('the stairs are picked by their own rectangle', findPlacedObjectAt({ x: m(3), y: m(5.1) }, objects, [hall]) === stairs)
check('a tap well outside the room picks nothing', findPlacedObjectAt({ x: m(20), y: m(20) }, objects, [hall]) === null)
check('an empty plan picks nothing', findPlacedObjectAt({ x: m(3), y: m(3) }, [], [hall]) === null)
check('an object with no place on the plan is not pickable', findPlacedObjectAt({ x: m(3), y: m(3) }, [{ id: 9, presetId: 'door', wallId: 'gone' }], [hall]) === null)

console.log('\nOn a wall')
const door = { id: 4, presetId: 'door', wallId: 'Hall', segmentIndex: 0, t1: 0.4, t2: 0.55, rotation: 0 }
const window_ = { id: 5, presetId: 'window', wallId: 'Hall', segmentIndex: 2, t1: 0.2, t2: 0.5 }
const wallObjects = [door, window_]
// Segment 0 runs along the top of the room from (0,0) to (6,0); 0.4..0.55 of it is
// 2.4 m to 3.3 m across.
check('a door is picked by its span along the wall', findPlacedObjectAt({ x: m(2.9), y: m(0.05) }, wallObjects, [hall]) === door)
check('a tap away from the door span misses it', findPlacedObjectAt({ x: m(5), y: m(0.05) }, wallObjects, [hall]) === null)
check('a window is picked along its own span', findPlacedObjectAt({ x: m(1.2 + 1.8), y: m(6) }, wallObjects, [hall]) === window_)
check('the nearer of a wall object and a free one wins', findPlacedObjectAt({ x: m(3), y: m(2.9) }, [safe, door], [hall]) === safe)

console.log('\nEvery preset')
// A guard rail worth having: shrink an object far enough and it stops being pickable at
// all, which is how a "scale it down" request quietly breaks selection on a phone. The
// outlet is the one to watch — it is drawn deliberately larger than a real plate.
for (const preset of OBJECT_PRESETS) {
  if (preset.mounted) continue
  const obj = { id: 99, presetId: preset.id, x: m(3), y: m(3), width: preset.width, height: preset.height }
  check(`${preset.label} can be picked up`, findPlacedObjectAt({ x: m(3), y: m(3) }, [obj], [hall]) === obj)
}

console.log(failures === 0 ? '\nAll pick checks passed.' : `\n${failures} pick check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
