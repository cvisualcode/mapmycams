// ─── Room names ──────────────────────────────────────────────────────────────
// A report that says "Room 2" is worth far less than one that says "Kitchen", so
// a room carries a name of its own. The name lives on the wall object as `label`
// — that is what the canvas and the blind-spot report already read — and these
// helpers are the only place that decides what a room is called. Keeping the
// rules here (rather than inline in the editor) means they can be tested without
// a browser, which is how the "never two Room 3s" case got caught.

/** Longest name we will store, so a pasted paragraph cannot wreck the report. */
export const MAX_ROOM_NAME = 40

/** What the user typed, made safe to store and safe to print. */
export function normalizeRoomName(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_ROOM_NAME)
}

/**
 * The lowest room number that is not already taken, so `Room ${n}` is always unique.
 *
 * The old `walls.length + 1` gave you a second "Room 2" as soon as you deleted the
 * first room, and two rooms with one name is worse than no name at all.
 */
export function nextRoomNumber(walls = []) {
  const used = new Set()
  for (const wall of walls) {
    const match = /^Room (\d+)$/.exec(String(wall?.label ?? '').trim())
    if (match) used.add(Number(match[1]))
  }
  let n = 1
  while (used.has(n)) n += 1
  return n
}

/** The name a newly drawn room gets. */
export function nextRoomLabel(walls = []) {
  return `Room ${nextRoomNumber(walls)}`
}

/** The name to show and to print for a room: its own, or where it sits in the plan. */
export function roomDisplayName(wall, index = 0) {
  return normalizeRoomName(wall?.label) || `Room ${index + 1}`
}

/**
 * Rename one room. A blank name does not leave the room nameless — it goes back to
 * the positional default, so nothing downstream ever has to print "undefined".
 */
export function renameRoom(walls = [], index, name) {
  const clean = normalizeRoomName(name)
  return walls.map((wall, i) => {
    if (i !== index) return wall
    return { ...wall, label: clean || `Room ${index + 1}` }
  })
}

/**
 * Give every room a name that is present and unique, without touching a name the user
 * chose.
 *
 * Rooms used to be named `Room ${walls.length + 1}` at the moment they were drawn, which
 * meant deleting a room and drawing another left you with two "Room 3"s, and a plan
 * restored from the dashboard or a shared link could arrive with no labels at all — the
 * report then read "Room, Room, Room". Only a missing name, or an automatic name that
 * clashes, is replaced; anything the user typed is left exactly as it is, even if they
 * deliberately name two rooms the same thing.
 *
 * Returns the same array when nothing needed fixing, so a caller can use it in an effect
 * without looping.
 */
export function ensureRoomLabels(walls = []) {
  const used = new Set()
  let changed = false
  const next = walls.map((wall) => {
    if (!wall || !Array.isArray(wall.points) || wall.points.length < 3) return wall
    const current = normalizeRoomName(wall.label)
    const auto = current === '' || /^Room \d+$/.test(current)
    if (!auto) {
      used.add(current)
      return wall
    }
    if (current && !used.has(current)) {
      used.add(current)
      return wall
    }
    let n = 1
    while (used.has(`Room ${n}`)) n += 1
    const label = `Room ${n}`
    used.add(label)
    if (label === current) return wall
    changed = true
    return { ...wall, label }
  })
  return changed ? next : walls
}

/** Every room in the plan, by name, in the order the canvas draws them. */
export function roomNames(walls = []) {
  const names = []
  walls.forEach((wall, index) => {
    if (!wall || !Array.isArray(wall.points) || wall.points.length < 3) return
    names.push(roomDisplayName(wall, index))
  })
  return names
}
