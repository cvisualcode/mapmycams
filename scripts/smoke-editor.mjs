// ─── Editor smoke test ───────────────────────────────────────────────────────
// The editor component can't be checked by the pure module tests, and a mistake in it
// takes the whole page down — a blank canvas and a console full of red. This renders
// the real component (through the same JSX transform the app build uses) with a few
// plans and asserts it produced a toolbar and a canvas instead of throwing.
//
//   bun run smoke:test
//
// It is written to run anywhere: the plan is the same shape the dashboard saves, so it
// covers the paths a room, a door, a window, a wire and several floors go through.

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const OUT = 'node_modules/.cache/ssr'

// Vite is run through node rather than a package runner: `bunx`/`npx` are not both
// guaranteed to exist, but the installed binary always is, and going through node
// means it does not depend on the executable bit the upload strips.
execFileSync(process.execPath, [
  'node_modules/vite/bin/vite.js', 'build', '--ssr', 'src/App.jsx', '--outDir', OUT, '--logLevel', 'warn',
], { stdio: ['ignore', 'ignore', 'inherit'] })

// A browser-less module still has to survive import: the app reads its backend choice
// and sets a couple of window hooks at module scope.
const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  location: { href: 'https://mapmycams.dev/', search: '', hash: '', origin: 'https://mapmycams.dev' },
  addEventListener() {},
  removeEventListener() {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
}

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToString } = require('react-dom/server')
const { default: App } = await import(pathToFileURL(`${process.cwd()}/${OUT}/App.js`).href)

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

function render(snapshot) {
  return renderToString(React.createElement(App, {
    onExit() {},
    showUpgrade() {},
    initialSnapshot: snapshot,
  }))
}

console.log('\nThe editor renders')
{
  let html = ''
  let error = null
  try {
    html = render(null)
  } catch (e) {
    error = e
  }
  check('an empty plan renders without throwing', !error, error && error.message)
  check('the canvas is there', typeof html === 'string' && html.includes('<canvas'))
  check('the toolbar is there', html.includes('>Select<'))
  check('undo and redo are offered', html.includes('Undo') && html.includes('Redo'))
  check('every sidebar tab is offered', ['Cameras', 'Objects', 'Score', 'Tools'].every((t) => html.includes(`>${t}<`)))
  check('the AI button is offered', html.includes('AI Place Cameras'))
  check('the camera catalogue loaded', html.includes('Recommended cameras'))
  check('the plan is reported as empty', html.includes('0 cameras on this plan'))
  check('an empty plan offers no room name box', !html.includes('room-name'))
}

console.log('\nA furnished plan renders')
{
  const metres = 80
  const room = {
    id: 1,
    closed: true,
    label: 'Kitchen',
    points: [{ x: 0, y: 0 }, { x: 6 * metres, y: 0 }, { x: 6 * metres, y: 5 * metres }, { x: 0, y: 5 * metres }],
  }
  const snapshot = {
    version: 1,
    walls: [room],
    cameras: [{ id: 2, x: metres, y: metres, rotation: 45, hFov: 110, distance: 10, color: '#4ade80', label: 'Cam 1' }],
    objects: [
      { id: 3, presetId: 'door', wallId: 1, segmentIndex: 0, t1: 0.4, t2: 0.52, rotation: 0, hingeSide: 'right' },
      { id: 4, presetId: 'window', wallId: 1, segmentIndex: 1, t1: 0.2, t2: 0.6 },
      { id: 5, presetId: 'safe', x: 3 * metres, y: 4 * metres, width: 0.6, height: 0.5, rotation: 90 },
      { id: 6, presetId: 'power', x: 5 * metres, y: 1 * metres, width: 0.3, height: 0.3 },
    ],
    wires: [{ id: 7, points: [{ x: 5 * metres, y: metres }, { x: 2 * metres, y: 3 * metres }], snapStartId: 'power-6', snapEndId: 'cam-2' }],
  }
  let html = ''
  let error = null
  try {
    html = render(snapshot)
  } catch (e) {
    error = e
  }
  check('a plan with a room, camera, door, window, safe, outlet and wire renders', !error, error && error.message)
  check('the plan\'s own contents are counted', html.includes('1 camera on this plan'))
  check('the toolbar still offers to undo and redo', html.includes('Undo') && html.includes('Redo'))
}

console.log('\nA room that needs repairing renders')
{
  const points = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }]
  let error = null
  try {
    render({
      version: 1,
      // No label at all, and a line that is not a room: both go through the naming rules.
      walls: [{ id: 1, closed: true, points }, { id: 2, closed: false, points: [points[0], points[1]] }],
      cameras: [],
      objects: [],
      wires: [],
    })
  } catch (e) {
    error = e
  }
  check('a plan with an unnamed room and a stray wall renders', !error, error && error.message)
}

console.log('\nThe API the browser talks to')
{
  // The Pages host has no API of its own: its build bakes VITE_API_URL in and every call
  // goes to the Worker instead. Anything that hardcodes a relative path is dead on that
  // host — which is exactly how an error reporter that never reported anything would
  // behave — so the setting is checked rather than assumed.
  const { readFileSync } = await import('node:fs')
  const build = (outDir, apiUrl) => {
    execFileSync(process.execPath, [
      'node_modules/vite/bin/vite.js', 'build', '--ssr', 'src/monetisation/errors.js',
      '--outDir', outDir, '--logLevel', 'warn',
    ], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, VITE_API_URL: apiUrl } })
    return readFileSync(`${outDir}/errors.js`, 'utf8')
  }
  const staticHost = build('node_modules/.cache/ssr-api', 'https://mapmycams.dev')
  check('a static host reports to the API it was built for', staticHost.includes('mapmycams.dev') && /report-error/.test(staticHost))
  const sameOrigin = build('node_modules/.cache/ssr-api-relative', '')
  check('and a build with no API configured stays on its own origin', !sameOrigin.includes('mapmycams.dev') && /report-error/.test(sameOrigin))
}

console.log(failures === 0 ? '\nEditor smoke checks passed.\n' : `\n${failures} editor smoke check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
