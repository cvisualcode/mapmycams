// ─── Every test suite, in one command ────────────────────────────────────────
// The suites are separate processes on purpose — each one stubs the globals it needs
// (window, fetch, KV) — so this runs them in order and reports a summary. It is what
// CI runs, and what to run before a deploy.
//
//   bun run test      (or: node scripts/test-all.mjs)

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** Order is roughly: the editor's pure logic, then the account and money paths. */
const SUITES = [
  ['rooms:test', 'test-rooms.mjs'],
  ['history:test', 'test-history.mjs'],
  ['gestures:test', 'test-gestures.mjs'],
  ['duplicate:test', 'test-duplicate.mjs'],
  ['pick:test', 'test-pick.mjs'],
  ['plan:test', 'test-plan.mjs'],
  ['coverage:test', 'test-coverage.mjs'],
  ['ai:test', 'test-ai.mjs'],
  ['billing:test', 'test-billing.mjs'],
  ['checkout:test', 'test-checkout-client.mjs'],
  ['reset:test', 'test-reset.mjs'],
  ['visibility:test', 'test-visibility.mjs'],
  ['landing:test', 'test-landing.mjs'],
  ['smoke:test', 'smoke-editor.mjs'],
]

const results = []
for (const [name, file] of SUITES) {
  const started = Date.now()
  const run = spawnSync(process.execPath, [join(here, file)], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  const output = `${run.stdout || ''}${run.stderr || ''}`
  const passes = (output.match(/✓/g) || []).length
  const failed = []
  for (const line of output.split('\n')) {
    if (line.includes('✗')) failed.push(line.trim())
  }
  const ok = run.status === 0
  results.push({ name, ok, passes, failed, ms: Date.now() - started })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(16)} ${String(passes).padStart(3)} checks  ${seconds}s`)
  if (!ok) {
    for (const line of failed.slice(0, 10)) console.log(`    ${line}`)
    if (!failed.length && run.error) console.log(`    ${String(run.error).split('\n')[0]}`)
  }
}

const failedSuites = results.filter((r) => !r.ok)
const checks = results.reduce((sum, r) => sum + r.passes, 0)
console.log(`\n${results.length - failedSuites.length}/${results.length} suites · ${checks} checks`)
if (failedSuites.length) {
  console.log(`Failed: ${failedSuites.map((r) => r.name).join(', ')}`)
  process.exit(1)
}
console.log('All suites passed.')
