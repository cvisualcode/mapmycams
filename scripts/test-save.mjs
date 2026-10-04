import assert from 'node:assert/strict'
import { handle } from '../api/index.js'
import { signToken, saveUser } from '../api/_lib.js'
import { createAutosave } from '../src/editor/autosave.js'
const records = new Map(), local = new Map()
const env = { AUTH_SECRET: 'isolated-save-test-secret-0123456789012345', MAPMYCAMS_STORE: {
  async get(k, type) { const v = records.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v },
  async put(k, v) { records.set(k, v) }, async delete(k) { records.delete(k) },
  async list({prefix = ''} = {}) { return {keys: [...records.keys()].filter(k => k.startsWith(prefix)).map(name => ({name}))} },
} }
globalThis.env = env
globalThis.window = {localStorage: {getItem: k => local.get(k) ?? null, setItem: (k,v) => local.set(k,v), removeItem: k => local.delete(k)}}
await saveUser({id: 'alice', email: 'save-alice@example.test', plan: 'free', email_verified: true})
await saveUser({id: 'bob', email: 'save-bob@example.test', plan: 'free', email_verified: true})
const alice = await signToken({id: 'alice', email: 'save-alice@example.test'})
const bob = await signToken({id: 'bob', email: 'save-bob@example.test'})
local.set('mmc_token_v1', alice)
let offline = false
let stale = null
globalThis.fetch = async (url, init = {}) => {
  if (offline) throw new Error('Offline')
  if (stale && init.method === 'GET') return Response.json([stale])
  return handle(new Request(String(url).startsWith('http') ? url : `https://test.local${url}`, init), env)
}
const api = await import('../src/monetisation/api.js')
const data = {version: 2, activeFloor: 1, floors: [{walls: [{id: 1, points: [{x:0,y:0},{x:80,y:0}], closed:false}], cameras:[],objects:[],wires:[]},{walls:[],cameras:[{id:2,x:5,y:7}],objects:[],wires:[]}]}
const first = await api.saveFloorplan('Home', data, 'home')
assert.equal(first.owner, 'alice'); console.log('✓ cloud save carries account owner and complete floors')
stale = {...first, data: {floors:[]}}
offline = true
await assert.rejects(api.saveFloorplan('Home', {...data, activeFloor:0}, 'home'), /Offline/)
offline = false
assert.equal((await api.listFloorplans())[0].data.activeFloor, 0)
assert.equal((await api.listFloorplans())[0].pendingSync, true); console.log('✓ stale remote cannot replace pending local edits')
stale = null
await api.saveFloorplan('Home', data, 'home')
await assert.rejects(api.saveFloorplan('Bypass', data, 'another'), /1 floorplan/); console.log('✓ explicit new ID cannot bypass Free limit')
local.set('mmc_token_v1', bob)
assert.equal(api.readLocalPlan('home'), null)
assert.equal((await api.listFloorplans()).length, 0); console.log('✓ another server account cannot see Alice drafts')
local.set('mmc_token_v1', alice)
offline = true
await assert.rejects(api.deleteFloorplan('home'), /Offline/)
assert(api.readLocalPlan('home')); console.log('✓ failed deletion retains recoverable draft')
offline = false
const queue = [], drafts = []
let release
const saver = createAutosave({delay: 10000, writeDraft: d => drafts.push(d), save: async d => { queue.push(d); if(d.n === 1) await new Promise(r => {release = r}) }})
saver.capture({n:1})
const saving = saver.flush()
await new Promise(r => setTimeout(r,0))
saver.capture({n:2}); assert.equal(drafts.at(-1).n,2)
release(); await saving
assert.deepEqual(queue, [{n:1},{n:2}]); saver.dispose(); console.log('✓ synchronous drafts and serialized saves preserve final edits')
const broken = createAutosave({delay:10000, writeDraft:()=>{}, save:async()=>{throw new Error('Rejected')}})
broken.capture({n:1}); await assert.rejects(broken.flush(), /Rejected/); broken.dispose(); console.log('✓ save failure is reported rather than swallowed')
console.log('Save regression checks passed.')
