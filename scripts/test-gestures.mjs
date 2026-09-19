// ─── Pointer gesture tests ───────────────────────────────────────────────────
// What a finger on the plan means: a tap, a drag, or a pinch. These are the decisions
// that decide whether a tablet can use the editor at all, and whether a two-finger zoom
// quietly leaves half a wall behind. No touchscreen needed.
//
//   bun run gestures:test

import {
  createGestureTracker, pointerDown, pointerMove, pointerUp, pointerCancel,
  beginPinch, pinchTransform, trackedPoints, TOUCH_SLOP_PX, MIN_ZOOM, MAX_ZOOM,
} from '../src/editor/pointer-gestures.js'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

const finger = (id, x, y) => ({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y })
const mouse = (x, y) => ({ pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y })

console.log('\nA mouse and a stylus behave exactly as before')
{
  const t = createGestureTracker()
  check('a mouse press is passed straight through', pointerDown(t, mouse(10, 10)).action === 'mouseDown')
  check('a mouse move is passed straight through', pointerMove(t, mouse(40, 10)).action === 'mouseMove')
  check('a mouse release is passed straight through', pointerUp(t, mouse(40, 10)).action === 'mouseUp')
  const pen = createGestureTracker()
  check('a stylus press is not treated as a finger', pointerDown(pen, { ...mouse(5, 5), pointerType: 'pen' }).action === 'mouseDown')
}

console.log('\nA tap')
{
  const t = createGestureTracker()
  check('the press waits — it may be the first finger of a pinch', pointerDown(t, finger(1, 100, 100)).action === 'wait')
  check('nothing happens while the finger is still', pointerMove(t, finger(1, 102, 101)).action === 'none')
  const up = pointerUp(t, finger(1, 102, 101))
  check('lifting without travelling is a tap', up.action === 'tap')
  check('the tap is reported where the finger landed', up.point.clientX === 100 && up.point.clientY === 100)
  check('and the tracker is left empty', t.pointers.size === 0 && t.pending === null)
  check('a second tap still works', pointerDown(t, finger(1, 5, 5)).action === 'wait' && pointerUp(t, finger(1, 5, 5)).action === 'tap')
}

console.log('\nA drag')
{
  const t = createGestureTracker()
  pointerDown(t, finger(1, 100, 100))
  const small = pointerMove(t, finger(1, 100 + TOUCH_SLOP_PX - 1, 100))
  check(`a nudge under ${TOUCH_SLOP_PX} px is still not a drag`, small.action === 'none')
  const move = pointerMove(t, finger(1, 100 + TOUCH_SLOP_PX + 4, 100))
  check('past the slop, the press is replayed', move.action === 'pressThenMove')
  check('replayed from where the finger landed, not where it is now', move.point.clientX === 100 && move.point.clientY === 100)
  check('and the following moves are live', pointerMove(t, finger(1, 140, 120)).action === 'mouseMove')
  check('releasing a drag ends it without a second press', pointerUp(t, finger(1, 140, 120)).action === 'mouseUp')
  check('the press is not replayed twice', pointerMove(t, finger(1, 180, 120)).action === 'none')
}

console.log('\nA pinch')
{
  const t = createGestureTracker()
  check('the first finger waits', pointerDown(t, finger(1, 300, 300)).action === 'wait')
  const second = pointerDown(t, finger(2, 400, 300))
  check('the second finger starts a pinch', second.action === 'pinchStart')
  check('and the first finger\'s press is thrown away', t.pending === null)
  check('a move is a pinch now, not a drag', pointerMove(t, finger(1, 290, 300)).action === 'pinch')

  // Both fingers on the canvas: 100 px apart, centred at (350, 300).
  const points = trackedPoints(t, { left: 0, top: 0 })
  beginPinch(t, [{ x: 300, y: 300 }, { x: 400, y: 300 }], 1, { x: 50, y: 50 })
  // The plan sits at pan (50, 50) at zoom 1, so the world point under any canvas point
  // is (canvas - pan) / zoom. A zoom anchored properly leaves that number alone at the
  // point between the fingers, which is the whole point of anchoring it there.
  const worldUnder = (canvasX, panX, zoom) => (canvasX - panX) / zoom
  const spread = pinchTransform(t, [{ x: 250, y: 300 }, { x: 450, y: 300 }])
  check('spreading the fingers zooms in', Math.abs(spread.zoom - 2) < 1e-9, `zoom=${spread.zoom}`)
  check('the plan does not slide out from under the fingers', Math.abs(worldUnder(350, spread.pan.x, spread.zoom) - worldUnder(350, 50, 1)) < 1e-9, `x=${spread.pan.x}`)
  const moved = pinchTransform(t, [{ x: 400, y: 300 }, { x: 600, y: 300 }])
  check('zooming about a moved centre also pans', Math.abs(moved.pan.x - (500 - (350 - 50) * 2)) < 1e-9, `x=${moved.pan.x}`)
  check('and the same world point follows the fingers to the new centre', Math.abs(worldUnder(500, moved.pan.x, moved.zoom) - worldUnder(350, 50, 1)) < 1e-9, `x=${moved.pan.x}`)
  const pinch = pinchTransform(t, [{ x: 300, y: 300 }, { x: 300, y: 300 }])
  check('pinching to nothing hits the zoom floor rather than zero', pinch.zoom === MIN_ZOOM)
  const wide = pinchTransform(t, [{ x: 0, y: 0 }, { x: 100000, y: 0 }])
  check('and pinching wide hits the ceiling', wide.zoom === MAX_ZOOM)
  check('an unreported pinch has no transform', pinchTransform(createGestureTracker(), points) === null)

  check('lifting one finger ends the pinch, not the gesture', pointerUp(t, finger(2, 400, 300)).action === 'none')
  check('the remaining finger does not become a drag', pointerMove(t, finger(1, 500, 500)).action === 'none')
  check('and lifting it is not a tap either', pointerUp(t, finger(1, 500, 500)).action === 'none')
  check('the tracker is clean afterwards', t.pointers.size === 0 && t.swallowUntilLift === false)
}

console.log('\nAfter a pinch, the next tap works normally')
{
  const t = createGestureTracker()
  pointerDown(t, finger(1, 10, 10))
  pointerDown(t, finger(2, 60, 10))
  pointerUp(t, finger(2, 60, 10))
  pointerUp(t, finger(1, 10, 10))
  check('a fresh press waits as usual', pointerDown(t, finger(3, 200, 200)).action === 'wait')
  check('and still taps', pointerUp(t, finger(3, 200, 200)).action === 'tap')
}

console.log('\nA cancelled gesture')
{
  const t = createGestureTracker()
  pointerDown(t, finger(1, 100, 100))
  pointerMove(t, finger(1, 150, 100))
  check('a cancel abandons what was in flight', pointerCancel(t, finger(1, 150, 100)).action === 'abandon')
  check('nothing is left pending', t.pending === null && t.pointers.size === 0)
  check('a cancel does not commit anything', pointerUp(t, finger(1, 150, 100)).action === 'none')
}

console.log('\nThree fingers and other nonsense')
{
  const t = createGestureTracker()
  pointerDown(t, finger(1, 0, 0))
  pointerDown(t, finger(2, 50, 0))
  beginPinch(t, [{ x: 0, y: 0 }, { x: 50, y: 0 }], 1, { x: 0, y: 0 })
  check('a third finger keeps pinching rather than starting over', pointerDown(t, finger(3, 100, 0)).action === 'pinchStart')
  // The editor re-anchors on that answer, so a third finger never makes the plan jump.
  beginPinch(t, [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }], 1, { x: 0, y: 0 })
  check('pinching still reports a transform with three fingers down', pinchTransform(t, [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }]) !== null)
  check('a move with no press at all does nothing', pointerMove(createGestureTracker(), finger(9, 1, 1)).action === 'none')
  check('a release with no press at all does nothing', pointerUp(createGestureTracker(), finger(9, 1, 1)).action === 'none')
}

console.log(failures === 0 ? '\nAll gesture checks passed.\n' : `\n${failures} gesture check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
