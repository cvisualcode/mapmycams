// ─── Plan timeline tests ─────────────────────────────────────────────────────
// Undo and redo are the difference between a drawing tool and a drawing you have to
// redo by hand, so the timeline is checked directly: the steps, the dedupe that makes
// the observation approach safe, and the limit that stops a long session growing
// without bound.
//
//   bun run history:test

import { createHistory, serializePlan, deserializePlan, DEFAULT_HISTORY_LIMIT } from '../src/editor/history.js'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

const plan = (id, extra = {}) => ({
  activeFloor: 0,
  floors: [{ walls: [{ id }], cameras: extra.cameras || [], objects: [], wires: [] }],
})

const A = serializePlan(plan(1))
const B = serializePlan(plan(2))
const C = serializePlan(plan(3))

console.log('\nSerializing a plan')
{
  const round = deserializePlan(serializePlan({
    activeFloor: 1,
    floors: [{ walls: [{ id: 'w' }] }, { walls: [], cameras: [{ id: 'c' }], objects: [], wires: [] }],
  }))
  check('every floor comes back, not just the visible one', round.floors.length === 2 && round.floors[1].cameras[0].id === 'c')
  check('the floor on screen comes back', round.activeFloor === 1)
  check('a plan with no floors does not throw', deserializePlan(serializePlan({})).floors.length === 0)
  check('rubbish in the store falls back to an empty plan', deserializePlan('not json').floors.length === 0)
  check('the same plan always serializes the same way', serializePlan(plan(1)) === A)
  check('a different plan serializes differently', A !== B)
  check('missing collections become empty arrays', JSON.parse(serializePlan({ floors: [{}] })).floors[0].objects.length === 0)
}

console.log('\nStepping back and forward')
{
  const h = createHistory()
  check('an empty timeline cannot undo', h.canUndo() === false && h.undo() === null)
  h.record(A)
  check('the first plan alone cannot be undone past', h.canUndo() === false)
  h.record(B)
  check('a second state can be undone', h.canUndo() === true)
  check('undo returns the state before it', h.undo() === A)
  check('and now redo is available', h.canRedo() === true)
  check('redo returns the state it left', h.redo() === B)
  check('redo is spent', h.canRedo() === false)
  h.record(B)
  check('recording the same plan twice stores one entry', h.depth().past === 2)
  h.record(C)
  check('a new plan is stored', h.depth().past === 3 && h.current() === C)
  check('undo goes back one step', h.undo() === B)
  check('undo again goes back another', h.undo() === A)
  check('the timeline stops at the oldest state', h.canUndo() === false && h.undo() === null)
  check('redo walks both steps forward', h.redo() === B && h.redo() === C)
  check('and then stops', h.canRedo() === false && h.redo() === null)
}

console.log('\nThe observation loop (what the editor actually does)')
{
  const h = createHistory()
  h.record(A)
  // The editor sees a change, then — as it does after restoring — records what it sees.
  h.record(B)
  const restored = h.undo()
  check('undo hands back the earlier plan', restored === A)
  check('recording the restored plan does not add an entry', h.record(restored) === false)
  check('and does not eat the redo trail', h.canRedo() === true)
  check('the depth is unchanged by the no-op record', h.depth().past === 1)
  check('redo still works afterwards', h.redo() === B)
  check('re-recording the redone plan is also a no-op', h.record(B) === false && h.canRedo() === false)
}

console.log('\nA new edit clears the redo trail')
{
  const h = createHistory()
  h.record(A); h.record(B)
  h.undo()
  check('redo is on offer after an undo', h.canRedo() === true)
  h.record(C)
  check('editing instead of redoing drops it', h.canRedo() === false)
  check('and redo then does nothing', h.redo() === null)
  check('the timeline holds the new state and the one before it', h.depth().past === 2 && h.current() === C)
}

console.log('\nA long session')
{
  const h = createHistory(4)
  for (let i = 0; i < 30; i++) h.record(JSON.stringify({ step: i }))
  check('the timeline is capped', h.depth().past === 4)
  check('the oldest states are the ones dropped', JSON.parse(h.current()).step === 29)
  let steps = 0
  while (h.undo() !== null) steps++
  check('undo cannot walk past the cap', steps === 3)
  check('a limit of 1 still leaves room for one step', createHistory(1).record('a') === true)
  check('the default limit is a sane length', DEFAULT_HISTORY_LIMIT >= 20 && DEFAULT_HISTORY_LIMIT <= 200)
  const d = createHistory()
  check('a non-string is refused rather than stored', d.record(undefined) === false && d.depth().past === 0)
}

console.log(failures === 0 ? '\nAll timeline checks passed.\n' : `\n${failures} timeline check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
