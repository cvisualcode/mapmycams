// ─── AI camera placement ─────────────────────────────────────────────────────
// POST /ai/suggest asks a model where the cameras should go, given the geometry of
// the plan. The model is never allowed to return a camera: it picks positions and
// says why, and everything else is built here. Any position that is not finite, not
// inside the room it claims, or too close to another camera is repaired or dropped,
// and if nothing survives the caller falls back to the deterministic geometry
// solver — so a quota error, a retired model or a nonsense reply degrades instead of
// breaking.
//
// Two providers, tried in this order:
//
//   1. Cloudflare Workers AI — the `AI` binding in wrangler.jsonc. No API key, no
//      separate account, included in the Workers Free plan with 10,000 Neurons a
//      day. This is the default precisely because there is nothing to configure and
//      nothing to be blocked by.
//   2. Google Gemini — only if GOOGLE_API_KEY is set, as a drop-in alternative for
//      anyone who already has one (and whose country Google accepts).
//
// Set AI_PROVIDER=workers-ai or AI_PROVIDER=gemini to pin one.

const GEMINI_ROOT = 'https://generativelanguage.googleapis.com/v1beta'
// Preference order per provider. Names move on, so a worker tries them in turn and
// remembers the one that answered — a retired default degrades to the next instead
// of breaking placement. None of these are the paid-billing-only models.
const WORKERS_AI_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
]
const PREFERRED_GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash']

const MAX_SPOTS = 12
const MAX_ROOMS = 14
const TIMEOUT_MS = 15000
const PIXELS_PER_METER = 40
const MIN_SPACING_PX = 40

// Per-isolate caches: Workers reuse isolates, so this is one probe per isolate
// rather than one per suggestion.
let workersAiModel = null
let geminiModelCache = { at: 0, models: null }

const round = (n) => Math.round(Number(n) || 0)

/** The rooms of a plan: every closed wall with at least three points, with its
 *  bounds and centroid. This is what the model is shown and what positions are
 *  validated against, so the two can never disagree about what a room is. */
export function planRooms(walls = []) {
  return walls
    .filter((w) => w && w.closed !== false && Array.isArray(w.points) && w.points.length >= 3)
    .slice(0, MAX_ROOMS)
    .map((w, i) => {
      const xs = w.points.map((p) => Number(p.x)).filter(Number.isFinite)
      const ys = w.points.map((p) => Number(p.y)).filter(Number.isFinite)
      return {
        index: i,
        label: String(w.label || `Room ${i + 1}`).slice(0, 40),
        polygon: w.points.map((p) => [round(p.x), round(p.y)]),
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minY: Math.min(...ys), maxY: Math.max(...ys),
      }
    })
    .map((r) => ({ ...r, cx: (r.minX + r.maxX) / 2, cy: (r.minY + r.maxY) / 2 }))
}

/** Every wall point's bounding box, padded — nothing is placed outside the plan. */
export function planBounds(walls = []) {
  const pts = walls.flatMap((w) => (Array.isArray(w?.points) ? w.points : []))
    .map((p) => [Number(p.x), Number(p.y)])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  if (pts.length === 0) return null
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return { minX: Math.min(...xs) - 20, maxX: Math.max(...xs) + 20, minY: Math.min(...ys) - 20, maxY: Math.max(...ys) + 20 }
}

export function pointInPolygon(x, y, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** The camera object the editor expects, built from a validated position. */
export function buildCamera(x, y, rotation, distance, index) {
  return {
    id: `ai_${crypto.randomUUID().slice(0, 8)}`,
    x: round(x),
    y: round(y),
    rotation: round(rotation) % 360,
    hFov: 120,
    distance: Math.min(40, Math.max(2, round(distance))),
    color: '#38bdf8',
    label: `AI Cam ${index + 1}`,
  }
}

/**
 * Turn the model's answer into cameras, or drop it.
 *
 * A spot survives only if it is inside the room it names (or, failing that, inside
 * any room), so a hallucinated coordinate outside the house is never placed. The
 * rotation and the range are ours: the model's numbers are a starting point, not a
 * camera.
 */
export function validateSpots(raw, rooms, bounds, existing = []) {
  const candidates = Array.isArray(raw?.spots) ? raw.spots : []
  const out = []
  for (const spot of candidates) {
    if (out.length >= MAX_SPOTS) break
    const x = Number(spot?.x)
    const y = Number(spot?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (bounds && (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY)) continue

    const named = Number.isInteger(spot?.room) ? rooms[spot.room] : null
    // Prefer the room it claims, but accept any room the point is genuinely inside.
    const room = (named && pointInPolygon(x, y, named.polygon) ? named : null)
      || rooms.find((r) => pointInPolygon(x, y, r.polygon))
    if (!room) continue

    const rotation = Number.isFinite(Number(spot?.rotation))
      ? Number(spot.rotation)
      : (Math.atan2(room.cy - y, room.cx - x) * 180) / Math.PI
    const diagonal = Math.hypot(room.maxX - room.minX, room.maxY - room.minY)
    const distance = Number.isFinite(Number(spot?.distance))
      ? Number(spot.distance)
      : Math.max(4, Math.round(diagonal / PIXELS_PER_METER / 2) + 2)

    // No two cameras on top of each other, and none on top of one already placed.
    if ([...out, ...existing].some((c) => Math.hypot((c.x ?? 0) - x, (c.y ?? 0) - y) < MIN_SPACING_PX)) continue

    out.push({ ...buildCamera(x, y, rotation, distance, out.length), why: String(spot?.why || '').slice(0, 120) })
  }
  return out
}

/** The plan as the model sees it: rooms, entries and what is already covered. */
export function buildPrompt(plan, rooms) {
  const entries = (plan.objects || [])
    .filter((o) => o && (o.presetId === 'door' || o.presetId === 'window'))
    .slice(0, MAX_ROOMS)
    .map((o) => ({ type: o.presetId, x: round(o.x), y: round(o.y) }))

  const brief = {
    rooms: rooms.map((r) => ({ room: r.index, name: r.label, polygon: r.polygon, centre: [round(r.cx), round(r.cy)] })),
    existingCameras: (plan.cameras || []).slice(0, MAX_SPOTS).map((c) => ({ x: round(c.x), y: round(c.y), rangeMetres: round(c.distance), headingDegrees: round(c.rotation) })),
    entryPoints: entries,
    cameraRangeMetres: 12,
    maxCameras: MAX_SPOTS,
  }

  const system = [
    'You are a CCTV layout planner. You are given the rooms of a house plan as polygons in pixel coordinates',
    '(x grows right, y grows DOWN, so 0 degrees points right/east and angles increase clockwise), the cameras',
    'already placed, and the doors and windows. Choose where new cameras should go so that every room with no',
    'camera pointed at it gets covered, and entry points are watched. Prefer a corner of the room looking across',
    'it toward the entry.',
    '',
    'Rules:',
    `- At most ${MAX_SPOTS} cameras. Return fewer if the plan is small. Never duplicate a room that is already covered.`,
    '- Every position must be strictly inside the polygon of the room you name, and at least 8 pixels from its walls.',
    '- rangeMetres: how far that camera needs to see, 2 to 40. It is a fixed camera, so 90-120 degrees of view.',
    '',
    'Answer with JSON only, no prose, in exactly this shape:',
    '{"spots":[{"room":0,"x":120,"y":340,"rotation":180,"distance":8,"why":"covers the front door and hallway"}],"summary":"one sentence about the layout"}',
  ].join('\n')

  return { system, user: `The plan:\n${JSON.stringify(brief)}` }
}

/** Parse the first JSON object in a string, tolerating code fences and prose. */
export function parseJsonObject(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim()
  try { return JSON.parse(cleaned) } catch { /* fall through to the slice */ }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try { return JSON.parse(cleaned.slice(start, end + 1)) } catch { return null }
}

/** The text out of a Workers AI reply, whichever shape the model answered in. */
export function workersAiText(res) {
  if (!res) return ''
  if (typeof res === 'string') return res
  const choice = res.choices?.[0]
  if (typeof choice?.message?.content === 'string') return choice.message.content
  if (typeof res.response === 'string') return res.response
  return ''
}

/**
 * Ask Cloudflare Workers AI (the `AI` binding). No key: the binding is the
 * credential, and the free allowance is 10,000 Neurons a day.
 */
export async function callWorkersAi(env, prompt, options = {}) {
  const ai = (env || globalThis.env || {}).AI
  if (!ai || typeof ai.run !== 'function') return null
  const candidates = workersAiModel
    ? [workersAiModel, ...WORKERS_AI_MODELS.filter((m) => m !== workersAiModel)]
    : WORKERS_AI_MODELS

  for (const model of candidates) {
    try {
      const res = await (options.runWorkersAi || ((m, input) => ai.run(m, input)))(model, {
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0.2,
        max_tokens: 1024,
      })
      const text = workersAiText(res)
      if (!text) continue
      workersAiModel = model
      return { text, model }
    } catch { /* model retired, quota spent, wrong input shape — try the next */ }
  }
  return null
}

/** Which Gemini model to ask: the configured one, else a preferred one the key can use. */
export async function pickGeminiModel(env, key, fetchImpl = fetch) {
  const configured = String((env || {}).GEMINI_MODEL || '').trim()
  if (configured) return configured

  const now = Date.now()
  if (geminiModelCache.models && now - geminiModelCache.at < 600000) {
    return pickFromList(geminiModelCache.models)
  }
  try {
    const res = await fetchImpl(`${GEMINI_ROOT}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return PREFERRED_GEMINI_MODELS[0]
    const data = await res.json()
    const models = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
    if (models.length === 0) return PREFERRED_GEMINI_MODELS[0]
    geminiModelCache = { at: now, models }
    return pickFromList(models)
  } catch {
    return PREFERRED_GEMINI_MODELS[0]
  }
}

function pickFromList(available) {
  const preferred = PREFERRED_GEMINI_MODELS.find((m) => available.includes(m))
  if (preferred) return preferred
  const flash = available.find((m) => m.includes('flash') && !m.includes('image') && !m.includes('embedding'))
  return flash || available[0]
}

/** Ask Google Gemini — only used when GOOGLE_API_KEY is set. */
export async function callGemini(env, prompt, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const key = String((env || globalThis.env || {}).GOOGLE_API_KEY || '').trim()
  if (!key) return null
  try {
    const model = await pickGeminiModel(env, key, fetchImpl)
    const res = await fetchImpl(`${GEMINI_ROOT}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048, responseMimeType: 'application/json' },
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''
    return text ? { text, model } : null
  } catch {
    return null
  }
}

/**
 * Ask the configured provider where the cameras should go.
 *
 * Returns `{ spots, model, provider, summary }`, or null when no provider can be
 * used or nothing it returned is placeable — the caller then answers from geometry.
 */
export async function suggestSpotsWithModel(env, plan = {}, options = {}) {
  const walls = plan.walls || []
  const rooms = planRooms(walls)
  const bounds = planBounds(walls)
  if (rooms.length === 0 || !bounds) return null

  const configured = String((env || globalThis.env || {}).AI_PROVIDER || '').trim().toLowerCase()
  const order = configured === 'gemini'
    ? ['gemini', 'workers-ai']
    : configured === 'workers-ai'
      ? ['workers-ai']
      : ['workers-ai', 'gemini']

  const prompt = buildPrompt(plan, rooms)
  for (const provider of order) {
    const answer = provider === 'workers-ai'
      ? await callWorkersAi(env, prompt, options)
      : await callGemini(env, prompt, options)
    if (!answer) continue
    const parsed = parseJsonObject(answer.text)
    if (!parsed) continue
    const spots = validateSpots(parsed, rooms, bounds, plan.cameras || [])
    if (spots.length === 0) continue
    return { spots, model: answer.model, provider, summary: String(parsed.summary || '').slice(0, 200) }
  }
  return null
}
