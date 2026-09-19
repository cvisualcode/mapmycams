// ─── AI placement smoke test ─────────────────────────────────────────────────
// Drives the real /ai/suggest handler with both providers stubbed out, so the paid
// gate, the prompt, the validation of what a model returns, the provider order and
// every fallback path can be checked without a key, a Cloudflare account, a network
// call or a penny of quota.
//
//   bun run ai:test
//
// No part of this touches Google, Cloudflare's models or a deployed Worker.

import { handle } from '../api/index.js'
import { planRooms, planBounds, validateSpots, parseJsonObject, pickGeminiModel, workersAiText, suggestSpotsWithModel } from '../api/ai.js'

// ── KV, in memory: accounts are really written and read ──────────────────────
function memoryKV() {
  const map = new Map()
  return {
    async get(key, type) {
      const raw = map.get(key)
      if (raw === undefined) return null
      return type === 'json' ? JSON.parse(raw) : raw
    },
    async put(key, value) { map.set(key, value) },
    async delete(key) { map.delete(key) },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name }))
      return { keys, list_complete: true }
    },
  }
}

// ── Workers AI, stubbed: an `AI` binding that answers, or throws, as queued ──
const aiCalls = []
let aiRun = async () => ({ choices: [{ message: { content: '{}' } }] })
const aiBinding = { run: (model, input) => { aiCalls.push({ model, input }); return aiRun(model, input) } }

// ── Gemini, stubbed: records the request and answers with whatever is queued ──
let geminiReply = { status: 200, body: { candidates: [{ content: { parts: [{ text: '{}' }] } }] } }
let geminiModels = { status: 200, body: { models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] } }
const geminiCalls = []
globalThis.fetch = async (url, init = {}) => {
  const full = String(url)
  if (!full.startsWith('https://generativelanguage.googleapis.com/')) throw new Error(`unexpected network call to ${full}`)
  geminiCalls.push({ url: full, body: init.body ? JSON.parse(init.body) : null, key: init.headers?.['x-goog-api-key'] })
  const answer = full.includes('/models?') ? geminiModels : geminiReply
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
}

const env = { AUTH_SECRET: 'smoke-test-secret-0123456789-abcdefghijkl', MAPMYCAMS_STORE: memoryKV(), APP_URL: 'https://mapmycams.dev' }

let failures = 0
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return true }
  failures++
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

async function call(path, { method = 'POST', body, token } = {}) {
  const request = new Request(`https://mapmycams.dev${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const res = await handle(request, env)
  return { status: res.status, data: await res.json().catch(() => null) }
}

const credential = (seed) => `pbkdf2$sha256$210000$${btoa(`salt-${seed}`)}$${btoa(`hash-${seed}-hash-${seed}`)}`
async function createAccount(email) {
  const signup = await call('/auth/signup', { body: { email, credential: credential(email), name: email.split('@')[0] } })
  const verify = await call('/auth/verify', { body: { email, code: signup.data?.devCode } })
  return { token: verify.data?.token, id: verify.data?.user?.id, email }
}

// ── A two-room plan, with a door on the front wall ───────────────────────────
const PLAN = {
  walls: [
    { id: 'w1', closed: true, label: 'Hall', points: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }] },
    { id: 'w2', closed: true, label: 'Kitchen', points: [{ x: 500, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 400 }, { x: 500, y: 400 }] },
    { id: 'w3', closed: false, points: [{ x: 0, y: 0 }, { x: 0, y: -50 }] },
  ],
  cameras: [{ id: 'c1', x: 800, y: 300, rotation: 180, hFov: 120, distance: 8 }],
  objects: [{ presetId: 'door', x: 200, y: 0 }, { presetId: 'window', x: 700, y: 0 }],
}

const goodSpot = (over = {}) => ({ room: 0, x: 80, y: 80, rotation: 135, distance: 9, why: 'covers the hall and the front door', ...over })
const TWO_ROOMS = { spots: [goodSpot(), goodSpot({ room: 1, x: 600, y: 90, why: 'kitchen' })], summary: 'Two cameras cover both rooms.' }
const asChoice = (payload) => ({ choices: [{ message: { content: JSON.stringify(payload) } }] })

// ── 1 · Who is allowed to ask ────────────────────────────────────────────────
console.log('\nAccess')
const unauth = await call('/ai/suggest', { body: PLAN })
check('no session is refused', unauth.status === 401, JSON.stringify(unauth.data))

const free = await createAccount('free@example.com')
const denied = await call('/ai/suggest', { token: free.token, body: PLAN })
check('a Free account cannot reach the AI', denied.status === 402, JSON.stringify(denied.data))
check('the refusal came before any model call', aiCalls.length === 0 && geminiCalls.length === 0)

const alice = await createAccount('alice@example.com')
await call('/billing/checkout', { token: alice.token, body: { item: 'ai_pack', kind: 'addon' } }) // demo grant

// ── 2 · Workers AI — the default, and the one with no key to lose ────────────
console.log('\nWorkers AI (the AI binding, no key)')
env.AI = aiBinding
aiRun = async () => asChoice(TWO_ROOMS)
const placed = await call('/ai/suggest', { token: alice.token, body: PLAN })
check('the answer is attributed to the model', placed.data?.source === 'model', JSON.stringify(placed.data))
check('the provider is named in the answer', placed.data?.provider === 'workers-ai', placed.data?.provider)
check('both positions come back as cameras', placed.data?.spots?.length === 2, JSON.stringify(placed.data?.spots))
const cam = placed.data?.spots?.[0] || {}
check('a camera has the shape the editor places', cam.id?.startsWith('ai_') && cam.hFov === 120 && cam.color === '#38bdf8' && cam.label === 'AI Cam 1', JSON.stringify(cam))
check('the model\'s reason is kept', typeof cam.why === 'string' && cam.why.length > 0)
check('the summary is passed through', placed.data?.summary === 'Two cameras cover both rooms.')
check('a Cloudflare model name is reported', String(placed.data?.model || '').startsWith('@cf/'), placed.data?.model)

const aiCall = aiCalls.at(-1)
check('the prompt is sent as system + user messages', aiCall?.input?.messages?.length === 2 && aiCall.input.messages[0].role === 'system')
const userText = aiCall?.input?.messages?.[1]?.content || ''
const systemText = aiCall?.input?.messages?.[0]?.content || ''
check('the prompt carries the room polygons', userText.includes('[0,0]') && userText.includes('polygon'))
check('the prompt explains the coordinate system', /y grows DOWN/.test(systemText))
check('the prompt carries the entry points', userText.includes('"door"') && userText.includes('"window"'))
check('the prompt carries what is already covered', userText.includes('existingCameras'))
check('the answer is not allowed to run long', aiCall?.input?.max_tokens > 0)

// The older `{ response: "..." }` shape must work too.
aiRun = async () => ({ response: JSON.stringify({ spots: [goodSpot()], summary: 'legacy shape' }) })
const legacy = await call('/ai/suggest', { token: alice.token, body: PLAN })
check('the legacy { response } shape is understood', legacy.data?.source === 'model' && legacy.data?.spots?.length === 1, JSON.stringify(legacy.data?.spots))

// A retired model must not take placement down with it.
let attempts = 0
aiRun = async (model) => {
  attempts++
  if (attempts < 3) throw new Error(`${model} is not available`)
  return asChoice({ spots: [goodSpot()], summary: 'found a working model' })
}
const retried = await call('/ai/suggest', { token: alice.token, body: PLAN })
check('a retired model is skipped for the next one', retried.data?.source === 'model' && attempts >= 3, `attempts ${attempts}`)

aiRun = async () => { throw new Error('no quota left') }
const exhausted = await call('/ai/suggest', { token: alice.token, body: PLAN })
check('an exhausted allowance falls back rather than failing', exhausted.status === 200 && exhausted.data?.source === 'solver', JSON.stringify(exhausted.data))
check('the solver answer is still usable cameras', (exhausted.data?.spots || []).length > 0 && exhausted.data.spots.every((s) => s.id?.startsWith('ai_') && Number.isFinite(s.x)), JSON.stringify(exhausted.data?.spots))

// ── 3 · Gemini — only when it is configured ─────────────────────────────────
console.log('\nGemini (only when a key is set)')
delete env.AI
const noProvider = await call('/ai/suggest', { token: alice.token, body: PLAN })
check('with no binding and no key there is no model call', noProvider.data?.source === 'solver' && geminiCalls.length === 0)

env.GOOGLE_API_KEY = 'test-key-not-real'
env.AI_PROVIDER = 'gemini'
geminiReply = { status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(TWO_ROOMS) }] } }] } }
const viaGemini = await call('/ai/suggest', { token: alice.token, body: PLAN })
check('a configured key is used', viaGemini.data?.provider === 'gemini' && viaGemini.data?.spots?.length === 2, JSON.stringify(viaGemini.data?.provider))
check('the model name is reported', typeof viaGemini.data?.model === 'string' && viaGemini.data.model.includes('flash'), viaGemini.data?.model)
const gCall = geminiCalls.at(-1)
check('the key travels in a header, never the URL', gCall?.key === 'test-key-not-real' && !gCall?.url.includes('key='))
check('Gemini is asked for JSON back', gCall?.body?.generationConfig?.responseMimeType === 'application/json')
check('Gemini gets the system instruction separately', /y grows DOWN/.test(gCall?.body?.systemInstruction?.parts?.[0]?.text || ''))
check('Gemini gets the plan as the user turn', (gCall?.body?.contents?.[0]?.parts?.[0]?.text || '').includes('polygon'))

geminiReply = { status: 429, body: { error: { message: 'Quota exceeded' } } }
const geminiQuota = await call('/ai/suggest', { token: alice.token, body: PLAN })
check('a Gemini quota error falls back rather than failing', geminiQuota.status === 200 && geminiQuota.data?.source === 'solver', JSON.stringify(geminiQuota.data))

// With both configured and Gemini pinned, a Gemini failure must still reach Workers AI.
env.AI = aiBinding
aiRun = async () => asChoice({ spots: [goodSpot()], summary: 'workers ai picked it up' })
const secondOpinion = await call('/ai/suggest', { token: alice.token, body: PLAN })
check('a pinned provider that fails falls through to the other', secondOpinion.data?.provider === 'workers-ai' && secondOpinion.data?.spots?.length === 1, JSON.stringify(secondOpinion.data?.provider))

delete env.AI_PROVIDER
aiRun = async () => asChoice({ spots: [goodSpot()], summary: 'default order' })
const defaultOrder = await call('/ai/suggest', { token: alice.token, body: PLAN })
check('the keyless provider is preferred by default', defaultOrder.data?.provider === 'workers-ai', defaultOrder.data?.provider)

// The per-account limit is 10 a minute, and every account above has spent its
// budget, so the later sections each get a fresh one.
const carol = await createAccount('carol@example.com')
await call('/billing/checkout', { token: carol.token, body: { item: 'ai_pack', kind: 'addon' } })

// ── 4 · What the model is never allowed to do ────────────────────────────────
console.log('\nValidation of what comes back')
delete env.GOOGLE_API_KEY
aiRun = async () => asChoice({ spots: [goodSpot({ x: -900, y: -900 })], summary: 'nonsense' })
const outside = await call('/ai/suggest', { token: carol.token, body: PLAN })
check('a position outside the house is refused', outside.data?.source === 'solver', JSON.stringify(outside.data))
check('...and nothing outside the plan is ever placed', !(outside.data?.spots || []).some((s) => s.x < 0 || s.y < 0), JSON.stringify(outside.data?.spots))

aiRun = async () => ({ choices: [{ message: { content: 'I think you should put them near the door.' } }] })
const prose = await call('/ai/suggest', { token: carol.token, body: PLAN })
check('prose instead of JSON falls back', prose.data?.source === 'solver', JSON.stringify(prose.data))

aiRun = async () => asChoice({ spots: [goodSpot(), goodSpot({ x: 810, y: 310, rotation: 0 })], summary: 'stacked' })
const deduped = await call('/ai/suggest', { token: carol.token, body: PLAN })
check('a position on top of an existing camera is dropped', deduped.data?.source === 'model' && deduped.data?.spots?.length === 1, JSON.stringify(deduped.data))

// ── 5 · With nothing configured at all ───────────────────────────────────────
console.log('\nNo provider')
delete env.AI
const bare = await call('/ai/suggest', { token: carol.token, body: PLAN })
check('the endpoint still answers, from geometry', bare.status === 200 && bare.data?.source === 'solver', JSON.stringify(bare.data))
const empty = await call('/ai/suggest', { token: carol.token, body: { walls: [] } })
check('a plan with no rooms gets nothing, not an error', empty.data?.spots?.length === 0, JSON.stringify(empty.data))

// ── 6 · The endpoint cannot be hammered ──────────────────────────────────────
console.log('\nRate limit')
env.AI = aiBinding
aiRun = async () => asChoice({ spots: [goodSpot()], summary: 'rate limit probe' })
const dave = await createAccount('dave@example.com')
await call('/billing/checkout', { token: dave.token, body: { item: 'ai_pack', kind: 'addon' } })
const statuses = []
for (let i = 0; i < 11; i++) statuses.push((await call('/ai/suggest', { token: dave.token, body: PLAN })).status)
check('the first ten calls are served', statuses.slice(0, 10).every((s) => s === 200), JSON.stringify(statuses))
check('the eleventh is refused', statuses[10] === 429, JSON.stringify(statuses))

// ── 7 · The validation rules on their own ────────────────────────────────────
console.log('\nValidation rules')
const rooms = planRooms(PLAN.walls)
const bounds = planBounds(PLAN.walls)
check('only closed walls count as rooms', rooms.length === 2 && rooms[0].label === 'Hall', JSON.stringify(rooms.map((r) => r.label)))
check('bounds cover every wall', bounds.minX <= 0 && bounds.maxX >= 900)

const kept = validateSpots({ spots: [goodSpot({ rotation: 'nonsense', distance: 900 })] }, rooms, bounds, [])
check('a missing rotation is derived from the room centre', Number.isFinite(kept[0]?.rotation), JSON.stringify(kept[0]))
check('an absurd range is clamped', kept[0]?.distance <= 40 && kept[0]?.distance >= 2, String(kept[0]?.distance))
check('a point inside a room is kept even if the room index is wrong', validateSpots({ spots: [goodSpot({ room: 99 })] }, rooms, bounds, []).length === 1)
check('a point inside no room is dropped', validateSpots({ spots: [{ room: 0, x: 4800, y: 4800 }] }, rooms, bounds, []).length === 0)
const capped = validateSpots({ spots: Array.from({ length: 30 }, (_, i) => goodSpot({ x: 40 + i * 12, y: 40 + i * 12 })) }, rooms, bounds, [])
check('the number of cameras is capped', capped.length <= 12, String(capped.length))
check('the cap keeps them apart, not stacked', new Set(capped.map((c) => `${c.x},${c.y}`)).size === capped.length)

check('fenced JSON is parsed', parseJsonObject('```json\n{"spots":[]}\n```')?.spots?.length === 0)
check('JSON wrapped in prose is parsed', parseJsonObject('Here you go: {"spots":[{"x":1}]} Hope that helps')?.spots?.length === 1)
check('unparseable text is refused', parseJsonObject('no json here') === null)
check('an empty reply is refused', parseJsonObject('') === null)

check('the new Workers AI reply shape is read', workersAiText({ choices: [{ message: { content: 'hi' } }] }) === 'hi')
check('the legacy Workers AI reply shape is read', workersAiText({ response: 'hi' }) === 'hi')
check('an unusable Workers AI reply is empty', workersAiText({}) === '')

// ── 8 · Choosing a model that exists ─────────────────────────────────────────
console.log('\nModel selection')
geminiModels = { status: 200, body: { models: [
  { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
] } }
const chosen = await pickGeminiModel({ GOOGLE_API_KEY: 'k' }, 'k')
check('a preferred flash model is chosen from the live list', chosen === 'gemini-3.8-flash', chosen)
check('a configured model wins', (await pickGeminiModel({ GEMINI_MODEL: 'my-pinned-model' }, 'k')) === 'my-pinned-model')
geminiModels = { status: 500, body: { error: 'nope' } }
check('an unreadable list still yields a model to try', typeof (await pickGeminiModel({ GOOGLE_API_KEY: 'k' }, 'k')) === 'string')

// A provider that answers with nothing placeable must not be retried forever.
const nothingPlaceable = await suggestSpotsWithModel({ AI: { run: async () => asChoice({ spots: [] }) } }, PLAN, {})
check('a model that places nothing yields no answer', nothingPlaceable === null)

// ── Result ───────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'All AI placement checks passed.' : `${failures} check(s) failed.`}`)
process.exit(failures === 0 ? 0 : 1)
