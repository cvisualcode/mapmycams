// The demo Admin account must exist only where a host has *confirmed* it has no
// account service. Three probe outcomes matter: an API answers ('api'), something
// else answers ('no-api' — the dev server or a static host), and the request
// itself failing ('unknown'). The third one is the security-relevant case: a
// flaky network on the live site must never be mistaken for a development host.
import assert from 'node:assert/strict'

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

function freshWindow() {
  const store = new Map()
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    location: { href: 'https://example.test/', search: '', hash: '', origin: 'https://example.test' },
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  }
  return store
}

/** A fresh module instance per case: the probe result is cached per module. */
async function loadApi(caseName, responder) {
  const store = freshWindow()
  globalThis.fetch = async (url, init = {}) => responder(String(url), init)
  const api = await import(`../src/monetisation/api.js?case=${caseName}`)
  return { api, store }
}

const html = () => new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
const json = (body, status = 200) => Response.json(body, { status })

console.log('\nA host that answers, but has no account service (the sandbox preview)')
{
  const { api, store } = await loadApi('no-api', () => html())
  check('the probe reports no account service', await api.apiProbeResult() === 'no-api')
  check('the demo admin is allowed there', await api.demoAdminAllowed() === true)
  const admin = await api.login('Admin', 'Admin1')
  check('Admin / Admin1 signs in as the seeded full-access account', admin?.isAdmin === true)
  store.set('mmc_session_v1', JSON.stringify({ token: 't', userId: 'u_admin', expires: Date.now() + 86400000 }))
  check('and its session is kept while the host still has no account service', (await api.getMe())?.isAdmin === true)
}

console.log('\nA host with a real account service (the live site)')
{
  const { api, store } = await loadApi('api', (url) => (
    url.includes('/auth/login') ? json({ error: 'Invalid email/username or password' }, 401) : json({ ok: true })
  ))
  check('the probe finds the account service', await api.apiProbeResult() === 'api')
  check('the demo admin is not offered there', await api.demoAdminAllowed() === false)
  await assert.rejects(api.login('Admin', 'Admin1'), /Invalid|password/)
  check('Admin / Admin1 is refused on the live site', true)
  store.set('mmc_session_v1', JSON.stringify({ token: 't', userId: 'u_admin', expires: Date.now() + 86400000 }))
  check('a leftover demo-admin session is dropped, not honoured', (await api.getMe()) === null)
  check('...and the session is cleared with it', store.has('mmc_session_v1') === false)
}

console.log('\nA host where the probe itself fails (offline, flaky network)')
{
  const { api, store } = await loadApi('unknown', () => { throw new Error('network down') })
  check('the probe admits it does not know', await api.apiProbeResult() === 'unknown')
  check('a failed probe is not permission: the demo admin stays hidden', await api.demoAdminAllowed() === false)
  await assert.rejects(api.login('Admin', 'Admin1'), /Invalid|password/)
  check('Admin / Admin1 is refused when the network is down', true)
  store.set('mmc_session_v1', JSON.stringify({ token: 't', userId: 'u_admin', expires: Date.now() + 86400000 }))
  check('a demo-admin session is dropped there too', (await api.getMe()) === null)
}

console.log(failures ? `\n${failures} demo-admin check(s) failed.` : '\nAll demo-admin availability checks passed.')
process.exit(failures ? 1 : 0)
