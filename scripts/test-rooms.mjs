// ─── Room naming tests ───────────────────────────────────────────────────────
// What a room is called is what the blind-spot list, the security score's advice and
// the PDF report print, so "Room 2" twice is a real defect: two rooms with one name
// is worse than no name at all. These check the rules without a browser.
//
//   bun run rooms:test

import {
  MAX_ROOM_NAME, normalizeRoomName, nextRoomNumber, nextRoomLabel,
  roomDisplayName, renameRoom, roomNames, ensureRoomLabels,
} from '../src/editor/room-names.js'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

const room = (label, id = label) => ({
  id,
  closed: true,
  label,
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
})
const line = (id) => ({ id, closed: false, label: id, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] })

console.log('\nWhat a name is allowed to be')
check('a name is trimmed', normalizeRoomName('  Kitchen  ') === 'Kitchen')
check('inner whitespace collapses', normalizeRoomName('Back\t  bedroom') === 'Back bedroom')
check('a pasted paragraph is capped', normalizeRoomName('x'.repeat(500)).length === MAX_ROOM_NAME)
check('a non-string is nothing, not "undefined"', normalizeRoomName(undefined) === '' && normalizeRoomName(7) === '')

console.log('\nNumbering a new room')
check('the first room is Room 1', nextRoomLabel([]) === 'Room 1')
check('the number follows the rooms already there', nextRoomLabel([room('Room 1'), room('Room 2')]) === 'Room 3')
check('a gap is reused rather than skipped', nextRoomNumber([room('Room 1'), room('Room 3')]) === 2)
check('rooms named by hand are not counted', nextRoomNumber([room('Kitchen'), room('Hall')]) === 1)
check('a name that merely starts with "Room" is not counted', nextRoomNumber([room('Room service')]) === 1)

console.log('\nDisplaying a name')
check('a named room shows its name', roomDisplayName(room('Kitchen')) === 'Kitchen')
check('an unnamed room falls back to its position', roomDisplayName(room(''), 2) === 'Room 3')
check('a whitespace name is treated as unnamed', roomDisplayName(room('   '), 0) === 'Room 1')
check('roomNames lists closed rooms in order', roomNames([room('Kitchen'), line('l1'), room('Hall')]).join() === 'Kitchen,Hall')

console.log('\nRenaming one room')
{
  const walls = [room('Room 1'), room('Room 2'), room('Room 3')]
  const renamed = renameRoom(walls, 1, '  Kitchen  ')
  check('the named room is renamed', renamed[1].label === 'Kitchen')
  check('the rooms around it are untouched', renamed[0].label === 'Room 1' && renamed[2].label === 'Room 3')
  check('the original array is not mutated', walls[1].label === 'Room 2')
  check('a blank name falls back to its position', renameRoom(walls, 1, '   ')[1].label === 'Room 2')
  check('an over-long name is capped', renameRoom(walls, 0, 'y'.repeat(200))[0].label.length === MAX_ROOM_NAME)
  check('an out-of-range index changes nothing', renameRoom(walls, 9, 'Nope').length === 3)
}

console.log('\nRepairing a plan (the effect that runs on every change)')
{
  const dupes = ensureRoomLabels([room('Room 2', 'a'), room('Room 2', 'b')])
  check('two "Room 2"s become distinct', dupes[0].label !== dupes[1].label)
  check('the first keeps its name', dupes[0].label === 'Room 2')
  check('the second takes the lowest free number', dupes[1].label === 'Room 1')
  check('and the repair is idempotent', ensureRoomLabels(dupes) === dupes)

  const unnamed = ensureRoomLabels([room('', 'a'), room('', 'b')])
  check('unnamed rooms are numbered', unnamed.map((w) => w.label).join() === 'Room 1,Room 2')

  const custom = ensureRoomLabels([room('Kitchen', 'a'), room('Hall', 'b')])
  check('names typed by the user are left exactly as they are', custom === custom && custom[0].label === 'Kitchen' && custom[1].label === 'Hall')
  check('a plan that needed nothing comes back as the same array', (() => {
    const walls = [room('Kitchen'), room('Hall')]
    return ensureRoomLabels(walls) === walls
  })())

  const sameName = ensureRoomLabels([room('Kitchen', 'a'), room('Kitchen', 'b')])
  check('a duplicate name the user chose is not rewritten', sameName[1].label === 'Kitchen')

  const mixed = ensureRoomLabels([room('Kitchen', 'a'), room('Room 1', 'b'), room('Room 1', 'c')])
  check('a hand-named room keeps its number reserved', mixed.map((w) => w.label).join() === 'Kitchen,Room 1,Room 2')

  const drawing = ensureRoomLabels([line('l1'), room('Room 4', 'a'), line('l2')])
  check('walls that are not closed rooms are skipped, not numbered', drawing[0].label === 'l1' && drawing[1].label === 'Room 4')
  check('a line with no points at all does not throw', ensureRoomLabels([{ id: 'x' }]).length === 1)
}

console.log(failures === 0 ? '\nAll room-name checks passed.\n' : `\n${failures} room-name check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
