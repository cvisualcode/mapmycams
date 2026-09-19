// ─── Plan geometry, drawing and scoring ──────────────────────────────────────
// Everything in the planner that is a pure function of the plan itself: the
// constants the catalogs are built from, the canvas drawing helpers, the
// hit-testing the mouse handlers lean on, the AI placement heuristic, the
// blind-spot sampler and the security score. None of it touches React, which is
// what lets `bun run plan:test` check it without a browser.
//
// src/App.jsx holds the editor component itself and imports from here.

export const PIXELS_PER_METER = 40
export const DOOR_WIDTH_METERS = 0.9
export const PRESETS = [
  { id: 'indoor-wide', label: 'Indoor Wide', hFov: 90, distance: 8, color: '#4ade80' },
  { id: 'outdoor-bullet', label: 'Outdoor Bullet', hFov: 70, distance: 20, color: '#60a5fa' },
  { id: 'dome', label: 'Dome', hFov: 110, distance: 10, color: '#f472b6' },
  { id: 'ptz', label: 'PTZ', hFov: 30, distance: 50, color: '#fbbf24' },
];
export const OBJECT_PRESETS = [
  { id: 'safe', label: 'Safe', width: 0.6, height: 0.5, blocksVision: true, color: '#ef4444' },
  { id: 'window', label: 'Window', width: 1.2, height: 0.1, blocksVision: false, color: '#3b82f6', resizable: true },
  { id: 'door', label: 'Door', width: DOOR_WIDTH_METERS, blocksVision: true, color: '#f59e0b', resizable: false },
  { id: 'power', label: 'Power Outlet', width: 0.3, height: 0.3, blocksVision: false, color: '#facc15', isPowerSource: true },
  { id: 'stairs-straight', label: 'Stairs · Straight', width: 1.1, height: 0.35, blocksVision: false, color: '#8b5cf6' },
  { id: 'stairs-curved', label: 'Stairs · Curved', width: 1.3, height: 1.3, blocksVision: false, color: '#a78bfa' },
]

// Free end-points that wires can snap to. Cameras use cam-<id>, power outlets use power-<id>.
export const SNAP_RADIUS_PX = 18
export const FLOOR_NAMES = ['Ground', 'First', 'Second', 'Roof']
export const FLOOR_COLORS = ['#64748b', '#6366f1', '#d97706', '#0ea5e9']
export const METERS_PER_STORY = 2.6

export function endpointId(kind, id) {
  return kind === 'cam' ? `cam-${id}` : kind === 'power' ? `power-${id}` : null
}

export function findSnapTarget(world, cameras, objects, origin, pan, zoom) {
  let best = null
  let bestDist = SNAP_RADIUS_PX
  for (const cam of cameras) {
    const cp = toCanvas(cam.x, cam.y, origin, pan, zoom)
    const d = Math.hypot(cp.x - world.canvasX, cp.y - world.canvasY)
    if (d < bestDist) {
      bestDist = d
      best = { kind: 'cam', id: cam.id, x: cam.x, y: cam.y, label: cam.label || 'Cam' }
    }
  }
  for (const obj of objects) {
    const preset = OBJECT_PRESETS.find((p) => p.id === obj.presetId)
    if (!preset || !preset.isPowerSource) continue
    if (obj.wallId != null) continue
    const cp = toCanvas(obj.x, obj.y, origin, pan, zoom)
    const d = Math.hypot(cp.x - world.canvasX, cp.y - world.canvasY)
    if (d < bestDist) {
      bestDist = d
      best = { kind: 'power', id: obj.id, x: obj.x, y: obj.y, label: 'Outlet' }
    }
  }
  return best
}

// Adjacency map: each endpoint id is linked to every endpoint it's wired to.
export function buildPowerAdjacency(wires) {
  const adj = new Map()
  const ensure = (id) => { if (!adj.has(id)) adj.set(id, new Set()); return adj.get(id) }
  for (const w of wires) {
    const a = w.snapStartId
    const b = w.snapEndId
    if (!a || !b || a === b) continue
    ensure(a).add(b)
    ensure(b).add(a)
  }
  return adj
}

export function computePoweredCameraIds(cameras, objects, wires) {
  const sources = []
  for (const obj of objects) {
    const preset = OBJECT_PRESETS.find((p) => p.id === obj.presetId)
    if (preset && preset.isPowerSource) sources.push(endpointId('power', obj.id))
  }
  if (sources.length === 0) return new Set()
  const adj = buildPowerAdjacency(wires)
  const reachable = new Set(sources)
  const queue = [...sources]
  while (queue.length) {
    const cur = queue.shift()
    const neighbours = adj.get(cur)
    if (!neighbours) continue
    for (const nb of neighbours) {
      if (!reachable.has(nb)) {
        reachable.add(nb)
        queue.push(nb)
      }
    }
  }
  const powered = new Set()
  for (const cam of cameras) {
    if (reachable.has(endpointId('cam', cam.id))) powered.add(cam.id)
  }
  return powered
}

// Camera quality presets used by the observable-range calculator (horizontal pixel counts)
export const RESOLUTIONS = [
  { id: '720p', label: 'HD 720p', px: 1280 },
  { id: '1080p', label: 'Full HD 1080p', px: 1920 },
  { id: '2k', label: '2K · 3MP', px: 2048 },
  { id: '4mp', label: '4K · 4MP', px: 2560 },
  { id: '8mp', label: '4K Ultra · 8MP', px: 3840 },
]

// Minimum pixel density per metre of scene width for each identification goal
export const DETECTION_LEVELS = [
  { id: 'detect', label: 'Detect', pxPerM: 25, hint: 'Spot a person or vehicle moving' },
  { id: 'recognize', label: 'Recognize', pxPerM: 100, hint: 'Identify who or what it is' },
  { id: 'identify', label: 'Identify', pxPerM: 250, hint: 'Read faces and number plates' },
]

// Stylized product artwork for the camera catalog (inline SVG data URIs, no network needed)
export function cameraSvg(accent, kind) {
  let shape = ''
  if (kind === 'dome') {
    shape = `
      <rect x="6" y="6" width="84" height="10" rx="3" fill="#334155"/>
      <rect x="16" y="14" width="64" height="8" rx="2" fill="#475569"/>
      <circle cx="48" cy="47" r="21" fill="${accent}"/>
      <circle cx="48" cy="47" r="16" fill="#0f172a"/>
      <circle cx="48" cy="47" r="7" fill="#38bdf8"/>
      <circle cx="48" cy="47" r="3" fill="#e0f2fe"/>`
  } else if (kind === 'bullet') {
    shape = `
      <rect x="8" y="14" width="8" height="46" rx="3" fill="#334155"/>
      <rect x="14" y="22" width="20" height="30" rx="4" fill="#475569"/>
      <rect x="32" y="16" width="56" height="42" rx="13" fill="${accent}"/>
      <circle cx="54" cy="37" r="10" fill="#0f172a"/>
      <circle cx="54" cy="37" r="6" fill="#38bdf8"/>
      <circle cx="54" cy="37" r="2.4" fill="#e0f2fe"/>`
  } else if (kind === 'turret') {
    shape = `
      <rect x="8" y="8" width="80" height="8" rx="3" fill="#334155"/>
      <path d="M26 16 h44 l-5 12 h-34 z" fill="#475569"/>
      <rect x="25" y="26" width="46" height="24" rx="7" fill="${accent}"/>
      <circle cx="48" cy="38" r="9" fill="#0f172a"/>
      <circle cx="48" cy="38" r="5.5" fill="#38bdf8"/>
      <circle cx="48" cy="38" r="2.2" fill="#e0f2fe"/>`
  } else {
    shape = `
      <rect x="34" y="6" width="28" height="9" rx="3" fill="#334155"/>
      <rect x="42" y="15" width="12" height="10" fill="#475569"/>
      <circle cx="48" cy="43" r="19" fill="${accent}"/>
      <circle cx="48" cy="43" r="13" fill="#0f172a"/>
      <circle cx="48" cy="43" r="6" fill="#38bdf8"/>
      <circle cx="48" cy="43" r="2.6" fill="#e0f2fe"/>`
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 72">${shape}</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

// Camera catalog. Fill in referralUrl with your affiliate link and the Buy button goes live.
export const CAMERA_CATALOG = [
  {
    id: 'indoor-dome',
    name: 'Indoor Dome 2K',
    presetId: 'indoor-wide',
    kind: 'dome',
    accent: '#4ade80',
    resolutionLabel: '2K · 3MP',
    fovLabel: '110°',
    irLabel: 'IR 10 m',
    rating: 'Indoor',
    referralUrl: '',
  },
  {
    id: 'outdoor-bullet',
    name: 'Outdoor Bullet 4MP',
    presetId: 'outdoor-bullet',
    kind: 'bullet',
    accent: '#60a5fa',
    resolutionLabel: '4MP 2K',
    fovLabel: '70°',
    irLabel: 'IR 30 m',
    rating: 'IP66',
    referralUrl: '',
  },
  {
    id: 'turret-2k',
    name: '2K Turret Cam',
    presetId: 'dome',
    kind: 'turret',
    accent: '#f472b6',
    resolutionLabel: '4MP 2K',
    fovLabel: '90°',
    irLabel: 'IR 20 m',
    rating: 'IP67',
    referralUrl: '',
  },
  {
    id: 'ring-stickup',
    name: 'Ring Stick Up Cam',
    brand: 'Ring',
    premium: true,
    presetId: 'outdoor-bullet',
    kind: 'bullet',
    accent: '#22d3ee',
    resolutionLabel: '1080p HD',
    fovLabel: '80°',
    irLabel: 'Night vision',
    rating: 'Battery',
    referralUrl: '',
  },
  {
    id: 'nest-cam-indoor',
    name: 'Nest Cam (indoor)',
    brand: 'Nest',
    premium: true,
    presetId: 'indoor-wide',
    kind: 'dome',
    accent: '#fb923c',
    resolutionLabel: '1080p HDR',
    fovLabel: '135°',
    irLabel: 'Night vision',
    rating: 'Wi-Fi',
    referralUrl: '',
  },
  {
    id: 'reolink-8mp',
    name: 'Reolink 4K PoE',
    brand: 'Reolink',
    premium: true,
    presetId: 'outdoor-bullet',
    kind: 'bullet',
    accent: '#a78bfa',
    resolutionLabel: '4K 8MP',
    fovLabel: '100°',
    irLabel: 'IR 30 m',
    rating: 'PoE',
    referralUrl: '',
  },
  {
    id: 'ptz-8mp',
    name: 'PTZ 8MP',
    presetId: 'ptz',
    kind: 'ptz',
    accent: '#fbbf24',
    resolutionLabel: '8MP 4K',
    fovLabel: '30° zoom',
    irLabel: 'IR 100 m',
    rating: 'IP66',
    referralUrl: '',
  },
]

export function toCanvas(x, y, origin, pan, zoom) {
  return {
    x: (x - origin.x) * zoom + pan.x,
    y: (y - origin.y) * zoom + pan.y,
  }
}

export function toWorld(x, y, origin, pan, zoom) {
  return {
    x: (x - pan.x) / zoom + origin.x,
    y: (y - pan.y) / zoom + origin.y,
  }
}

export function getDoorSegmentWorld(door, wall) {
  const p1 = wall.points[door.segmentIndex]
  const p2 = wall.points[(door.segmentIndex + 1) % wall.points.length]
  const hingeT = door.hingeSide === 'left' ? door.t1 : door.t2
  const startT = door.hingeSide === 'left' ? door.t2 : door.t1
  const hinge = {
    x: p1.x + (p2.x - p1.x) * hingeT,
    y: p1.y + (p2.y - p1.y) * hingeT,
  }
  const start = {
    x: p1.x + (p2.x - p1.x) * startT,
    y: p1.y + (p2.y - p1.y) * startT,
  }
  const wallAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
  const rel = ((door.rotation * Math.PI) / 180) - wallAngle
  const vx = start.x - hinge.x
  const vy = start.y - hinge.y
  const rx = vx * Math.cos(rel) - vy * Math.sin(rel)
  const ry = vx * Math.sin(rel) + vy * Math.cos(rel)

  return {
    start: hinge,
    end: { x: hinge.x + rx, y: hinge.y + ry },
  }
}

export function drawFovShape(ctx, cam, origin, pan, zoom, walls, objects, extraWalls, skipContaining, ghostWalls, ghostHull) {
  const start = toCanvas(cam.x, cam.y, origin, pan, zoom)
  const hFovRad = (cam.hFov * Math.PI) / 180
  const dist = cam.distance * PIXELS_PER_METER * zoom
  const rot = (cam.rotation * Math.PI) / 180

  const leftAngle = rot - hFovRad / 2
  const rightAngle = rot + hFovRad / 2

  ctx.beginPath()
  ctx.moveTo(start.x, start.y)

  const rayCount = 72
  const camOutsideHull = !(ghostHull && ghostHull.length >= 3 && isPointInPolygon(cam.x, cam.y, ghostHull))
  const allWalls = [...walls, ...(extraWalls || [])]
  const wallWindows = new Map()
  const wallDoors = new Map()
  for (const obj of objects) {
    if (obj.presetId === 'window' && obj.wallId != null) {
      if (!wallWindows.has(obj.wallId)) wallWindows.set(obj.wallId, [])
      wallWindows.get(obj.wallId).push(obj)
    }
    if (obj.presetId === 'door' && obj.wallId != null) {
      if (!wallDoors.has(obj.wallId)) wallDoors.set(obj.wallId, [])
      wallDoors.get(obj.wallId).push(obj)
    }
  }

  for (let i = 0; i <= rayCount; i++) {
    const angle = leftAngle + (rightAngle - leftAngle) * (i / rayCount)
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)
    let nearest = dist
    for (const wall of allWalls) {
      const windows = wallWindows.get(wall.id) || []
      const doors = wallDoors.get(wall.id) || []
      const closed = wall.closed !== false
      if (skipContaining && closed && wall.points.length >= 3 && isPointInPolygon(cam.x, cam.y, wall.points)) {
        continue
      }
      for (let j = 0; j < wall.points.length; j++) {
        const nextJ = closed ? (j + 1) % wall.points.length : j + 1
        if (nextJ >= wall.points.length) break
        const p1World = wall.points[j]
        const p2World = wall.points[nextJ]
        const p1 = toCanvas(p1World.x, p1World.y, origin, pan, zoom)
        const p2 = toCanvas(p2World.x, p2World.y, origin, pan, zoom)
        const segDx = p2.x - p1.x
        const segDy = p2.y - p1.y
        const segLen = Math.hypot(segDx, segDy) || 1
        const ext = 0.005 * PIXELS_PER_METER * zoom
        const extX = (segDx / segLen) * ext
        const extY = (segDy / segLen) * ext
        const ep1x = p1.x - extX
        const ep1y = p1.y - extY
        const ep2x = p2.x + extX
        const ep2y = p2.y + extY
        const eSegDx = ep2x - ep1x
        const eSegDy = ep2y - ep1y
        const denom = dx * eSegDy - dy * eSegDx
        if (Math.abs(denom) < 1e-8) continue
        const t = ((ep1x - start.x) * eSegDy - (ep1y - start.y) * eSegDx) / denom
        const u = ((ep1x - start.x) * dy - (ep1y - start.y) * dx) / denom
        if (t > 0 && u >= -0.01 && u <= 1.01) {
          const segWindows = windows.filter((w) => w.segmentIndex === j)
          const segDoors = doors.filter((d) => d.segmentIndex === j)
          const hitInWindow = segWindows.some((w) => u >= w.t1 && u <= w.t2)
          const hitInDoorOpening = segDoors.some((door) => u >= door.t1 && u <= door.t2)

          // Windows and doors replace this part of the wall. The door leaf is
          // tested independently below, so the opening itself must not keep
          // the original wall segment in the ray path.
          if (!hitInWindow && !hitInDoorOpening && t < nearest) {
            nearest = t
          }
        }

        // A swung door can extend away from its wall, so test the door leaf
        // independently of the wall intersection. This makes the visible door
        // geometry the thing that blocks the FOV ray.
        for (const door of doors.filter((d) => d.segmentIndex === j)) {
          const doorSeg = getDoorSegmentWorld(door, wall)
          const d1 = toCanvas(doorSeg.start.x, doorSeg.start.y, origin, pan, zoom)
          const d2 = toCanvas(doorSeg.end.x, doorSeg.end.y, origin, pan, zoom)
          const dSegDx = d2.x - d1.x
          const dSegDy = d2.y - d1.y
          const dDenom = dx * dSegDy - dy * dSegDx
          if (Math.abs(dDenom) < 1e-8) continue
          const dT = ((d1.x - start.x) * dSegDy - (d1.y - start.y) * dSegDx) / dDenom
          const dU = ((d1.x - start.x) * dy - (d1.y - start.y) * dx) / dDenom
          if (dT > 0 && dU >= 0 && dU <= 1 && dT < nearest) {
            nearest = dT
          }
        }
      }
    }

    if (camOutsideHull && ghostWalls && ghostWalls.length) {
      for (const ghost of ghostWalls) {
        const closedG = ghost.closed !== false
        for (let j = 0; j < ghost.points.length; j++) {
          const nextJ = closedG ? (j + 1) % ghost.points.length : j + 1
          if (nextJ >= ghost.points.length) break
          const p1W = ghost.points[j]
          const p2W = ghost.points[nextJ]
          const p1 = toCanvas(p1W.x, p1W.y, origin, pan, zoom)
          const p2 = toCanvas(p2W.x, p2W.y, origin, pan, zoom)
          const segDx = p2.x - p1.x
          const segDy = p2.y - p1.y
          const segLen = Math.hypot(segDx, segDy) || 1
          const ext = 0.005 * PIXELS_PER_METER * zoom
          const ep1x = p1.x - (segDx / segLen) * ext
          const ep1y = p1.y - (segDy / segLen) * ext
          const ep2x = p2.x + (segDx / segLen) * ext
          const ep2y = p2.y + (segDy / segLen) * ext
          const eSegDx = ep2x - ep1x
          const eSegDy = ep2y - ep1y
          const denom = dx * eSegDy - dy * eSegDx
          if (Math.abs(denom) < 1e-8) continue
          const t = ((ep1x - start.x) * eSegDy - (ep1y - start.y) * eSegDx) / denom
          const u = ((ep1x - start.x) * dy - (ep1y - start.y) * dx) / denom
          if (t > 0 && u >= -0.01 && u <= 1.01 && t < nearest) {
            nearest = t
          }
        }
      }
    }

    for (const obj of objects) {
      // Wall-attached doors are handled as their swung leaf above; they do not
      // have a free-standing x/y rectangle to test here.
      if (obj.presetId === 'door' && obj.wallId != null) continue
      if (!obj.blocksVision) continue
      const preset = OBJECT_PRESETS.find((p) => p.id === obj.presetId)
      if (!preset) continue
      const w = (obj.width || preset.width) * PIXELS_PER_METER * zoom
      const h = (obj.height || preset.height) * PIXELS_PER_METER * zoom
      const hw = w / 2
      const hh = h / 2
      const ox = toCanvas(obj.x, obj.y, origin, pan, zoom).x
      const oy = toCanvas(obj.x, obj.y, origin, pan, zoom).y
      const box = [
        { x: ox - hw, y: oy - hh },
        { x: ox + hw, y: oy - hh },
        { x: ox + hw, y: oy + hh },
        { x: ox - hw, y: oy + hh },
      ]
      for (let j = 0; j < box.length; j++) {
        const p1 = box[j]
        const p2 = box[(j + 1) % box.length]
        const segDx = p2.x - p1.x
        const segDy = p2.y - p1.y
        const denom = dx * segDy - dy * segDx
        if (Math.abs(denom) < 1e-8) continue
        const t = ((p1.x - start.x) * segDy - (p1.y - start.y) * segDx) / denom
        const u = ((p1.x - start.x) * dy - (p1.y - start.y) * dx) / denom
        if (t > 0 && u >= 0 && u <= 1) {
          const hitDist = t
          if (hitDist < nearest && hitDist > 0) {
            nearest = hitDist
          }
        }
      }
    }

    const endX = start.x + nearest * dx
    const endY = start.y + nearest * dy
    ctx.lineTo(endX, endY)
  }

  ctx.closePath()
  ctx.fillStyle = cam.color + '88'
  ctx.fill()
  ctx.strokeStyle = cam.color
  ctx.lineWidth = 1
  ctx.stroke()
}

export function drawGhostFloor(ctx, walls, origin, pan, zoom, color) {
  if (!walls || walls.length === 0) return
  ctx.save()
  ctx.setLineDash([6, 5])
  ctx.lineCap = 'round'
  ctx.globalAlpha = 0.45
  for (const wall of walls) {
    const closed = wall.closed !== false
    for (let i = 0; i < wall.points.length; i++) {
      const p1 = wall.points[i]
      const nextI = closed ? (i + 1) % wall.points.length : i + 1
      if (nextI >= wall.points.length) break
      const p2 = wall.points[nextI]
      const c1 = toCanvas(p1.x, p1.y, origin, pan, zoom)
      const c2 = toCanvas(p2.x, p2.y, origin, pan, zoom)
      ctx.beginPath()
      ctx.moveTo(c1.x, c1.y)
      ctx.lineTo(c2.x, c2.y)
      ctx.strokeStyle = color || '#6366f1'
      ctx.lineWidth = 2.5 * zoom
      ctx.stroke()
    }
  }
  ctx.restore()
}

export function drawSegmentLine(ctx, p1, p2, origin, pan, zoom) {
  const c1 = toCanvas(p1.x, p1.y, origin, pan, zoom)
  const c2 = toCanvas(p2.x, p2.y, origin, pan, zoom)
  ctx.beginPath()
  ctx.moveTo(c1.x, c1.y)
  ctx.lineTo(c2.x, c2.y)
  ctx.strokeStyle = '#111827'
  ctx.lineWidth = 3 * zoom
  ctx.lineCap = 'round'
  ctx.stroke()
}

export function formatMeasurement(meters) {
  const rounded = Math.round(meters * 100) / 100
  return `${rounded.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')} m`
}

export function drawMeasurementLabel(ctx, text, x, y, zoom) {
  ctx.save()
  ctx.font = `${Math.max(10, 12 * zoom)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 4
  ctx.strokeStyle = 'rgba(248, 250, 252, 0.95)'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = '#334155'
  ctx.fillText(text, x, y)
  ctx.restore()
}

export function drawSegmentMeasurement(ctx, p1, p2, origin, pan, zoom) {
  const worldLength = Math.hypot(p2.x - p1.x, p2.y - p1.y)
  if (worldLength < 0.05) return
  const c1 = toCanvas(p1.x, p1.y, origin, pan, zoom)
  const c2 = toCanvas(p2.x, p2.y, origin, pan, zoom)
  const dx = c2.x - c1.x
  const dy = c2.y - c1.y
  const canvasLength = Math.hypot(dx, dy)
  if (canvasLength < 8) return
  const offset = Math.max(12, 14 * zoom)
  const midX = (c1.x + c2.x) / 2 - (dy / canvasLength) * offset
  const midY = (c1.y + c2.y) / 2 + (dx / canvasLength) * offset
  drawMeasurementLabel(ctx, formatMeasurement(worldLength / PIXELS_PER_METER), midX, midY, zoom)
}

export function drawRoomLabel(ctx, wall, origin, pan, zoom) {
  if (wall.points.length < 3) return
  let cx = 0, cy = 0
  for (const p of wall.points) {
    const c = toCanvas(p.x, p.y, origin, pan, zoom)
    cx += c.x
    cy += c.y
  }
  cx /= wall.points.length
  cy /= wall.points.length
  ctx.fillStyle = '#374151'
  ctx.font = `${12 * zoom}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(wall.label || 'Room', cx, cy)
}

export function drawRectangle(ctx, x1, y1, x2, y2, zoom, widthMeters, heightMeters) {
  ctx.beginPath()
  ctx.rect(x1, y1, x2 - x1, y2 - y1)
  ctx.strokeStyle = '#111827'
  ctx.lineWidth = 3 * zoom
  ctx.stroke()
  ctx.fillStyle = 'rgba(17, 24, 39, 0.05)'
  ctx.fill()

  if (widthMeters != null && heightMeters != null) {
    const offset = Math.max(14, 16 * zoom)
    drawMeasurementLabel(ctx, formatMeasurement(widthMeters), (x1 + x2) / 2, Math.min(y1, y2) - offset, zoom)
    drawMeasurementLabel(ctx, formatMeasurement(heightMeters), Math.max(x1, x2) + offset, (y1 + y2) / 2, zoom)
  }
}

export function drawGrid(ctx, width, height, pan, zoom) {
  // One visible grid square represents one metre.
  const step = PIXELS_PER_METER * zoom
  if (step < 8) return
  ctx.strokeStyle = '#e5e7eb'
  ctx.lineWidth = 1
  const startX = (pan.x % step + step) % step
  const startY = (pan.y % step + step) % step
  for (let x = startX; x < width; x += step) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }
  for (let y = startY; y < height; y += step) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }
}

export function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

export function projectPointOnSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return { t: 0, x: x1, y: y1 }
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return { t, x: x1 + t * dx, y: y1 + t * dy }
}

export function rotatePoint(dx, dy, deg) {
  const rad = (deg * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return { x: dx * c - dy * s, y: dx * s + dy * c }
}

export function isOnDoorHandle(canvasX, canvasY, obj, walls, origin, pan, zoom) {
  const preset = OBJECT_PRESETS.find((p) => p.id === obj.presetId)
  if (!preset) return false
  const rot = (obj.rotation * Math.PI) / 180
  const w = (obj.width || preset.width) * PIXELS_PER_METER * zoom
  // Use the hinge (right side) as the arc center so handle hit-test matches pivot.
  const half = w / 2
  let hingeCanvasX, hingeCanvasY
  if (obj.wallId != null) {
    const wall = walls.find((w) => w.id === obj.wallId)
    if (!wall) return false
    const p1 = wall.points[obj.segmentIndex]
    const p2 = wall.points[(obj.segmentIndex + 1) % wall.points.length]
    const hingeT = obj.hingeSide === 'left' ? obj.t1 : obj.t2
    const hx = p1.x + (p2.x - p1.x) * hingeT
    const hy = p1.y + (p2.y - p1.y) * hingeT
    const cp = toCanvas(hx, hy, origin, pan, zoom)
    hingeCanvasX = cp.x
    hingeCanvasY = cp.y
  } else {
    const cp = toCanvas(obj.x, obj.y, origin, pan, zoom)
    hingeCanvasX = cp.x + Math.cos((obj.rotation * Math.PI) / 180) * half
    hingeCanvasY = cp.y + Math.sin((obj.rotation * Math.PI) / 180) * half
  }
  const hingeDirection = obj.hingeSide === 'left' ? -1 : 1
  const handleAngle = (obj.rotation * Math.PI) / 180 + hingeDirection * Math.PI / 2
  const handleX = hingeCanvasX + half * Math.cos(handleAngle)
  const handleY = hingeCanvasY + half * Math.sin(handleAngle)
  // allow clicking either the handle on the arc or the hinge pivot itself
  const handleHit = Math.hypot(canvasX - handleX, canvasY - handleY) < Math.max(18, 18 * zoom)
  const hingeHit = Math.hypot(canvasX - hingeCanvasX, canvasY - hingeCanvasY) < Math.max(12, 12 * zoom)
  return handleHit || hingeHit
}

export function findNearestWallSegment(world, walls, origin, pan, zoom, maxPx = 12) {
  const px = toCanvas(world.x, world.y, origin, pan, zoom).x
  const py = toCanvas(world.x, world.y, origin, pan, zoom).y
  let best = null
  let bestDist = maxPx
  for (const wall of walls) {
    const closed = wall.closed !== false
    for (let i = 0; i < wall.points.length; i++) {
      const nextI = closed ? (i + 1) % wall.points.length : i + 1
      if (nextI >= wall.points.length) break
      const p1 = toCanvas(wall.points[i].x, wall.points[i].y, origin, pan, zoom)
      const p2 = toCanvas(wall.points[nextI].x, wall.points[nextI].y, origin, pan, zoom)
      const dist = distanceToSegment(px, py, p1.x, p1.y, p2.x, p2.y)
      if (dist < bestDist) {
        const proj = projectPointOnSegment(px, py, p1.x, p1.y, p2.x, p2.y)
        best = {
          wallId: wall.id,
          segmentIndex: i,
          t: proj.t,
          p1,
          p2,
        }
        bestDist = dist
      }
    }
  }
  return best
}

export function drawWindowOnWallSegment(ctx, x1, y1, x2, y2, origin, pan, zoom) {
  const start = toCanvas(x1, y1, origin, pan, zoom)
  const end = toCanvas(x2, y2, origin, pan, zoom)
  const dx = end.x - start.x
  const dy = end.y - start.y
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len * 4 * zoom
  const ny = dx / len * 4 * zoom
  ctx.beginPath()
  ctx.moveTo(start.x + nx, start.y + ny)
  ctx.lineTo(end.x + nx, end.y + ny)
  ctx.lineTo(end.x - nx, end.y - ny)
  ctx.lineTo(start.x - nx, start.y - ny)
  ctx.closePath()
  ctx.fillStyle = 'rgba(59, 130, 246, 0.35)'
  ctx.fill()
  ctx.strokeStyle = '#93c5fd'
  ctx.lineWidth = 1.5 * zoom
  ctx.stroke()
}

export function drawDoorOnWallSegment(ctx, x1, y1, x2, y2, rotation, origin, pan, zoom, hingeSide = 'right') {
  const start = toCanvas(x1, y1, origin, pan, zoom)
  const end = toCanvas(x2, y2, origin, pan, zoom)
  const wallAngle = Math.atan2(y2 - y1, x2 - x1)
  const doorAngle = (rotation * Math.PI) / 180

  const dx = end.x - start.x
  const dy = end.y - start.y
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len * 4 * zoom
  const ny = dx / len * 4 * zoom

  // The default hinge is on the segment's right/end side. For a left hinge,
  // pivot at the opposite end and swing toward the other door endpoint.
  const pivotX = hingeSide === 'left' ? start.x : end.x
  const pivotY = hingeSide === 'left' ? start.y : end.y
  const closedStartX = hingeSide === 'left' ? end.x : start.x
  const closedStartY = hingeSide === 'left' ? end.y : start.y
  const vx = closedStartX - pivotX
  const vy = closedStartY - pivotY
  const rel = doorAngle - wallAngle
  const cosR = Math.cos(rel)
  const sinR = Math.sin(rel)
  const rx = vx * cosR - vy * sinR
  const ry = vx * sinR + vy * cosR
  const sx = pivotX + rx
  const sy = pivotY + ry

  // draw a thick line representing the swung door edge
  ctx.beginPath()
  ctx.moveTo(pivotX, pivotY)
  ctx.lineTo(sx, sy)
  ctx.strokeStyle = '#f59e0b'
  ctx.lineWidth = 6 * zoom
  ctx.lineCap = 'round'
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(pivotX, pivotY)
  ctx.lineTo(sx, sy)
  ctx.strokeStyle = '#fbbf24'
  ctx.lineWidth = 2 * zoom
  ctx.stroke()
}

export function drawWall(ctx, wall, origin, pan, zoom, objects) {
  if (wall.points.length < 2) return
  const windows = objects.filter((obj) => obj.presetId === 'window' && obj.wallId === wall.id)
  const doors = objects.filter((obj) => obj.presetId === 'door' && obj.wallId === wall.id)
  const closed = wall.closed !== false
  for (let i = 0; i < wall.points.length; i++) {
    const p1 = wall.points[i]
    const nextI = closed ? (i + 1) % wall.points.length : i + 1
    if (nextI >= wall.points.length) break
    const p2 = wall.points[nextI]
    drawSegmentMeasurement(ctx, p1, p2, origin, pan, zoom)
    const segmentWindows = windows
      .filter((obj) => obj.segmentIndex === i)
      .sort((a, b) => a.t1 - b.t1)
    const segmentDoors = doors
      .filter((obj) => obj.segmentIndex === i)
      .sort((a, b) => a.t1 - b.t1)

    let lastT = 0
    const allSegments = [...segmentWindows, ...segmentDoors]
    for (const segObj of allSegments) {
      const segStart = { x: p1.x + (p2.x - p1.x) * lastT, y: p1.y + (p2.y - p1.y) * lastT }
      const segEnd = { x: p1.x + (p2.x - p1.x) * segObj.t1, y: p1.y + (p2.y - p1.y) * segObj.t1 }
      if (Math.hypot(segEnd.x - segStart.x, segEnd.y - segStart.y) > 0.001) {
        drawSegmentLine(ctx, segStart, segEnd, origin, pan, zoom)
      }
      if (segObj.presetId === 'window') {
        drawWindowOnWallSegment(ctx, p1.x + (p2.x - p1.x) * segObj.t1, p1.y + (p2.y - p1.y) * segObj.t1,
          p1.x + (p2.x - p1.x) * segObj.t2, p1.y + (p2.y - p1.y) * segObj.t2,
          origin, pan, zoom)
      } else if (segObj.presetId === 'door') {
        drawDoorOnWallSegment(ctx, p1.x + (p2.x - p1.x) * segObj.t1, p1.y + (p2.y - p1.y) * segObj.t1,
          p1.x + (p2.x - p1.x) * segObj.t2, p1.y + (p2.y - p1.y) * segObj.t2,
          segObj.rotation, origin, pan, zoom, segObj.hingeSide)
      }
      lastT = segObj.t2
    }

    if (lastT < 1) {
      const segStart = { x: p1.x + (p2.x - p1.x) * lastT, y: p1.y + (p2.y - p1.y) * lastT }
      const segEnd = p2
      if (Math.hypot(segEnd.x - segStart.x, segEnd.y - segStart.y) > 0.001) {
        drawSegmentLine(ctx, segStart, segEnd, origin, pan, zoom)
      }
    }
  }
}

// ── AI blind-spot detection ──────────────────────────────────────────────────
// Samples a grid across every closed room and reports rooms (or areas) that no
// camera FOV reaches, treating walls and vision-blocking objects as opaque.
export function computeBlindSpots(walls, cameras, objects) {
  const closed = walls.filter((w) => w.closed !== false && w.points.length >= 3)
  if (closed.length === 0) return []
  const CELL = 60
  const blind = []
  for (const wall of closed) {
    const xs = wall.points.map((pt) => pt.x)
    const ys = wall.points.map((pt) => pt.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const cells = []
    for (let x = minX + CELL / 2; x < maxX; x += CELL) {
      for (let y = minY + CELL / 2; y < maxY; y += CELL) {
        if (!isPointInPolygon(x, y, wall.points)) continue
        const visible = cameras.some((cam) => {
          const dx = x - cam.x, dy = y - cam.y
          const dist = Math.hypot(dx, dy)
          if (dist > (cam.distance || 10) * 40) return false
          const ang = (Math.atan2(dy, dx) * 180) / Math.PI
          const rel = ((ang - cam.rotation) % 360 + 540) % 360 - 180
          if (Math.abs(rel) > (cam.hFov || 90) / 2) return false
          // occlusion by walls (excluding the camera's own boundary crossing) and solid objects
          for (const w of closed) {
            const pts = w.points
            for (let i = 0; i < pts.length; i++) {
              const a1 = pts[i], a2 = pts[(i + 1) % pts.length]
              if (segRayBlocked(cam.x, cam.y, x, y, a1, a2, wall, w)) return false
            }
          }
          for (const o of objects) {
            if (!o.blocksVision) continue
            // A door or a safe on a wall has no x/y of its own — its centre has to be
            // resolved from the wall it sits on, or it never blocks anything.
            const c = objectCentre(o, closed)
            if (!c) continue
            const halfW = ((o.width || 1) * 40) / 2, halfH = ((o.height || 1) * 40) / 2
            if (Math.abs(c.x - x) < halfW + 8 && Math.abs(c.y - y) < halfH + 8 && Math.abs(c.x - cam.x) < Math.abs(dx) && Math.abs(c.y - cam.y) < Math.abs(dy)) return false
          }
          return true
        })
        if (!visible) cells.push({ x, y })
      }
    }
    if (cells.length > 0) blind.push({ wall, label: wall.label || 'Room', cells, area: cells.length * (CELL / 40) * (CELL / 40) })
  }
  return blind
}

/**
 * Does the segment from the camera to the target cross this wall segment?
 *
 * Takes plain coordinates, which is how the blind-spot sampler calls it. (It used to
 * take two point objects while every caller passed numbers, so the arithmetic came
 * out NaN and no wall ever blocked anything — blind spots were reported as covered
 * whenever the angle and the range happened to fit, walls or no walls.)
 */
export function segRayBlocked(camX, camY, targetX, targetY, a1, a2, camWall, segWall) {
  const d = (targetX - camX) * (a2.y - a1.y) - (targetY - camY) * (a2.x - a1.x)
  if (Math.abs(d) < 1e-9) return false
  const t = ((a1.x - camX) * (a2.y - a1.y) - (a1.y - camY) * (a2.x - a1.x)) / d
  const u = ((a1.x - camX) * (targetY - camY) - (a1.y - camY) * (targetX - camX)) / d
  if (!(t > 0.02 && t < 0.98 && u > 0 && u < 1)) return false
  // A camera inside a room isn't occluded by that room's own boundary for
  // targets in the same room; it IS blocked by other rooms' walls.
  return segWall !== camWall
}

export function isPointInPolygon(x, y, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y
    const xj = polygon[j].x, yj = polygon[j].y
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

export function drawObject(ctx, obj, origin, pan, zoom, walls) {
  const preset = OBJECT_PRESETS.find((p) => p.id === obj.presetId)
  if (!preset) return

  if (preset.id === 'window' && obj.wallId != null) {
    const wall = walls.find((w) => w.id === obj.wallId)
    if (!wall || wall.points.length < 2) return
    const closed = wall.closed !== false
    const segIndex = obj.segmentIndex % wall.points.length
    const nextI = closed ? (segIndex + 1) % wall.points.length : segIndex + 1
    if (nextI >= wall.points.length) return
    const p1 = wall.points[segIndex]
    const p2 = wall.points[nextI]
    const x1 = p1.x + (p2.x - p1.x) * obj.t1
    const y1 = p1.y + (p2.y - p1.y) * obj.t1
    const x2 = p1.x + (p2.x - p1.x) * obj.t2
    const y2 = p1.y + (p2.y - p1.y) * obj.t2
    drawWindowOnWallSegment(ctx, x1, y1, x2, y2, origin, pan, zoom)
    return
  }

  if (preset.id === 'door' && obj.wallId != null) {
    const wall = walls.find((w) => w.id === obj.wallId)
    if (!wall || wall.points.length < 2) return
    const closed = wall.closed !== false
    const segIndex = obj.segmentIndex % wall.points.length
    const nextI = closed ? (segIndex + 1) % wall.points.length : segIndex + 1
    if (nextI >= wall.points.length) return
    const p1 = wall.points[segIndex]
    const p2 = wall.points[nextI]
    const x1 = p1.x + (p2.x - p1.x) * obj.t1
    const y1 = p1.y + (p2.y - p1.y) * obj.t1
    const x2 = p1.x + (p2.x - p1.x) * obj.t2
    const y2 = p1.y + (p2.y - p1.y) * obj.t2
    drawDoorOnWallSegment(ctx, x1, y1, x2, y2, obj.rotation, origin, pan, zoom, obj.hingeSide)
    return
  }

  const cp = toCanvas(obj.x, obj.y, origin, pan, zoom)
  const w = (obj.width || preset.width) * PIXELS_PER_METER * zoom
  const h = (obj.height || preset.height) * PIXELS_PER_METER * zoom
  const rot = (obj.rotation * Math.PI) / 180

  ctx.save()
  ctx.translate(cp.x, cp.y)
  ctx.rotate(rot)
  // some object types (doors) need custom hinge-based drawing; keep cp/rot available

  ctx.fillStyle = preset.color + '33'
  ctx.strokeStyle = preset.color
  ctx.lineWidth = 2
  ctx.fillRect(-w / 2, -h / 2, w, h)
  ctx.strokeRect(-w / 2, -h / 2, w, h)

  if (preset.id === 'safe') {
    ctx.fillStyle = '#ef4444'
    ctx.font = '10px system-ui'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('S', 0, 0)
  } else if (preset.id === 'window') {
    ctx.strokeStyle = '#3b82f6'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(-w / 2, 0)
    ctx.lineTo(w / 2, 0)
    ctx.stroke()
  } else if (preset.id === 'door') {
    // restore global save and draw door pivoting around its right-side hinge in world coords
    ctx.restore()
    const hingeX = cp.x + Math.cos(rot) * (w / 2)
    const hingeY = cp.y + Math.sin(rot) * (w / 2)
    ctx.save()
    ctx.translate(hingeX, hingeY)
    ctx.rotate(rot)
    ctx.fillStyle = preset.color + '33'
    ctx.strokeStyle = preset.color
    ctx.lineWidth = 1
    // draw rect extending left from hinge
    ctx.fillRect(-w, -h / 2, w, h)
    ctx.strokeRect(-w, -h / 2, w, h)
    ctx.restore()
    // (removed rotating semicircle here; rotation handle is drawn as the fixed big arc when selected)
  } else if (preset.id === 'stairs-straight') {
    ctx.strokeStyle = preset.color
    ctx.lineWidth = 1.5
    const treads = 6
    for (let i = 1; i < treads; i++) {
      const t = i / treads
      ctx.beginPath()
      ctx.moveTo(-w / 2 + w * t, -h / 2)
      ctx.lineTo(-w / 2 + w * t, h / 2)
      ctx.stroke()
    }
    ctx.fillStyle = preset.color
    ctx.beginPath()
    ctx.moveTo(0, -h * 0.18)
    ctx.lineTo(-3.5, h * 0.04)
    ctx.lineTo(3.5, h * 0.04)
    ctx.closePath()
    ctx.fill()
  } else if (preset.id === 'stairs-curved') {
    ctx.strokeStyle = preset.color
    ctx.lineWidth = 1.5
    const r = Math.min(w, h) * 0.42
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath()
      ctx.arc(-r * 0.15, 0, (i / 4) * r, Math.PI * 0.5, Math.PI * 1.95)
      ctx.stroke()
    }
    ctx.fillStyle = preset.color
    ctx.beginPath()
    ctx.arc(-r * 0.15, 0, 2.5, 0, Math.PI * 2)
    ctx.fill()
  }

  // ensure we end in a clean state
  try { ctx.restore() } catch (e) { }
}

export function drawWire(ctx, wire, origin, pan, zoom) {
  if (!wire.points || wire.points.length < 2) return
  ctx.save()
  ctx.strokeStyle = '#f97316'
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([8, 4])
  ctx.beginPath()
  const first = toCanvas(wire.points[0].x, wire.points[0].y, origin, pan, zoom)
  ctx.moveTo(first.x, first.y)
  for (let i = 1; i < wire.points.length; i++) {
    const p = toCanvas(wire.points[i].x, wire.points[i].y, origin, pan, zoom)
    ctx.lineTo(p.x, p.y)
  }
  ctx.stroke()
  ctx.setLineDash([])
  for (const idx of [0, wire.points.length - 1]) {
    const p = toCanvas(wire.points[idx].x, wire.points[idx].y, origin, pan, zoom)
    ctx.beginPath()
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
    ctx.fillStyle = '#f97316'
    ctx.fill()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
  ctx.restore()
}

export function convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  if (pts.length <= 1) return pts
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

export function scalePolygon(poly, cx, cy, factor) {
  return poly.map((p) => ({ x: cx + (p.x - cx) * factor, y: cy + (p.y - cy) * factor }))
}

// Isometric exterior view: the ground-floor footprint extruded into walls, a hip roof,
// and the surrounding lot (lawn, boundary, driveway and trees).
export function drawRoofBackdrop(ctx, pts, floorInfo, origin, pan, zoom) {
  // The roof floor stays clean like the other floors: no enclosing squares.
  // Only a small legend explaining the coloured ghost lines of the floors below.
  ctx.font = '12px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = 'rgba(15, 23, 42, 0.75)'
  ctx.fillText('Roof — below floors shown faint; edit the roof here', 14, 14)
  let ly = 34
  for (let i = 0; i < floorInfo.length; i++) {
    ctx.fillStyle = FLOOR_COLORS[i] || '#64748b'
    ctx.fillRect(14, ly, 14, 8)
    ctx.fillStyle = 'rgba(15, 23, 42, 0.8)'
    ctx.fillText(floorInfo[i].name + (floorInfo[i].hasWalls ? '' : ' (empty)'), 34, ly - 1)
    ly += 18
  }
}

export function drawRotationArc(ctx, cam, origin, pan, zoom) {
  const cp = toCanvas(cam.x, cam.y, origin, pan, zoom)
  const arcCX = cp.x
  const arcCY = cp.y
  const radius = 35 * zoom

  ctx.beginPath()
  ctx.arc(arcCX, arcCY, radius, 0, Math.PI * 2)
  ctx.strokeStyle = '#3b82f6'
  ctx.lineWidth = 2
  ctx.setLineDash([4 * zoom, 4 * zoom])
  ctx.stroke()
  ctx.setLineDash([])

  const handleAngle = (cam.rotation * Math.PI) / 180
  const handleX = arcCX + radius * Math.cos(handleAngle)
  const handleY = arcCY + radius * Math.sin(handleAngle)

  ctx.beginPath()
  ctx.arc(handleX, handleY, 6 * zoom, 0, Math.PI * 2)
  ctx.fillStyle = '#3b82f6'
  ctx.fill()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.stroke()

  const arrowLen = 10 * zoom
  const arrowAngle1 = handleAngle + Math.PI / 2
  const arrowAngle2 = handleAngle - Math.PI / 2
  ctx.beginPath()
  ctx.moveTo(handleX, handleY)
  ctx.lineTo(handleX + arrowLen * Math.cos(arrowAngle1), handleY + arrowLen * Math.sin(arrowAngle1))
  ctx.moveTo(handleX, handleY)
  ctx.lineTo(handleX + arrowLen * Math.cos(arrowAngle2), handleY + arrowLen * Math.sin(arrowAngle2))
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.stroke()
}

export function isOnRotationHandle(canvasX, canvasY, cam, origin, pan, zoom) {
  const cp = toCanvas(cam.x, cam.y, origin, pan, zoom)
  const arcCX = cp.x
  const arcCY = cp.y
  const radius = 35 * zoom

  const handleAngle = (cam.rotation * Math.PI) / 180
  const handleX = arcCX + radius * Math.cos(handleAngle)
  const handleY = arcCY + radius * Math.sin(handleAngle)

  return Math.hypot(canvasX - handleX, canvasY - handleY) < 12
}

// ── AI camera placement heuristic ────────────────────────────────────────────
// Places cameras near room corners: for each closed wall polygon, find its
// bounding box and put a camera at opposite corners with a wide FOV aimed at
// the room centre. Skips spots already covered by an existing camera.
export function aiSuggestSpots(walls, existingCameras) {
  const closed = walls.filter((w) => w.closed !== false && w.points.length >= 3)
  if (closed.length === 0) return []
  const ppm = 40 // PIXELS_PER_METER
  const RAY_COUNT = 48

  // Sample points inside each room (grid) as the coverage targets
  const targets = []
  for (const wall of closed) {
    const xs = wall.points.map((pt) => pt.x)
    const ys = wall.points.map((pt) => pt.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const step = 60
    for (let x = minX + step / 2; x < maxX; x += step) {
      for (let y = minY + step / 2; y < maxY; y += step) {
        if (isPointInPolygon(x, y, wall.points)) targets.push({ x, y, wall })
      }
    }
  }
  if (targets.length === 0) return []

  // Candidate camera positions: inset corners of every room
  const candidates = []
  for (const wall of closed) {
    const xs = wall.points.map((pt) => pt.x)
    const ys = wall.points.map((pt) => pt.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const inset = 12
    for (const [x, y] of [[minX + inset, minY + inset], [maxX - inset, minY + inset], [minX + inset, maxY - inset], [maxX - inset, maxY - inset]]) {
      const cx = Math.max(minX + 4, Math.min(maxX - 4, x))
      const cy = Math.max(minY + 4, Math.min(maxY - 4, y))
      const room = closed.find((w) => isPointInPolygon(cx, cy, w.points))
      if (room) candidates.push({ x: cx, y: cy, wall: room })
    }
  }

  // What each candidate can see (FOV rays vs the same wall geometry the renderer uses)
  function seesFrom(camPos) {
    const seen = new Set()
    const roomPts = camPos.wall.points
    const xs = roomPts.map((pt) => pt.x), ys = roomPts.map((pt) => pt.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
    const maxDist = Math.hypot(maxX - minX, maxY - minY) + 40
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    const rot = (Math.atan2(cy - camPos.y, cx - camPos.x) * 180) / Math.PI
    const hFov = Math.min(120, maxDist > 600 ? 90 : 120)
    const leftA = ((rot - hFov / 2) * Math.PI) / 180
    const rightA = ((rot + hFov / 2) * Math.PI) / 180
    for (const t of targets) {
      const dx = t.x - camPos.x, dy = t.y - camPos.y
      const ang = Math.atan2(dy, dx)
      const relA = ang - leftA
      const span = rightA - leftA
      let norm = Math.atan2(Math.sin(relA), Math.cos(relA))
      if (norm < 0 || norm > span) continue
      if (Math.hypot(dx, dy) > maxDist) continue
      // ray-cast: blocked by other walls (not its own room walls beyond the boundary)
      let blocked = false
      for (const w of closed) {
        if (w === t.wall && w === camPos.wall) continue
        const pts = w.points
        for (let i = 0; i < pts.length; i++) {
          const a1 = pts[i], a2 = pts[(i + 1) % pts.length]
          if (segIntersect(camPos.x, camPos.y, t.x, t.y, a1.x, a1.y, a2.x, a2.y)) { blocked = true; break }
        }
        if (blocked) break
      }
      if (!blocked) seen.add(t)
    }
    return seen
  }

  function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx)
    if (Math.abs(d) < 1e-9) return false
    const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d
    const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d
    return t > 0.02 && t < 0.98 && u > 0 && u < 1
  }

  // Greedy set cover: repeatedly take the candidate that covers the most
  // still-uncovered targets — yields close to the minimum camera count.
  const uncovered = new Set(targets)
  const chosen = []
  const coveredByExisting = new Set()
  for (const t of targets) {
    for (const c of existingCameras) {
      if (Math.hypot(c.x - t.x, c.y - t.y) < (c.distance || 10) * ppm) { coveredByExisting.add(t); break }
    }
  }
  for (const t of coveredByExisting) uncovered.delete(t)

  const evaluated = candidates.map((c) => ({ pos: c, seen: seesFrom(c) }))
  while (uncovered.size > 0) {
    let best = null, bestGain = 0
    for (const ev of evaluated) {
      let gain = 0
      for (const t of ev.seen) if (uncovered.has(t)) gain++
      if (gain > bestGain) { bestGain = gain; best = ev }
    }
    if (!best || bestGain === 0) break
    chosen.push(best)
    for (const t of best.seen) uncovered.delete(t)
  }

  return chosen.map((ev, i) => {
    const { pos, seen } = ev
    const roomPts = pos.wall.points
    const xs = roomPts.map((pt) => pt.x), ys = roomPts.map((pt) => pt.y)
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2
    const farthest = Math.max(...[...seen].map((t) => Math.hypot(t.x - pos.x, t.y - pos.y)), 120)
    return {
      id: 'ai_' + Math.random().toString(36).slice(2, 9),
      x: pos.x, y: pos.y,
      rotation: Math.round((Math.atan2(cy - pos.y, cx - pos.x) * 180) / Math.PI),
      hFov: 120,
      distance: Math.max(4, Math.round(farthest / ppm) + 1),
      color: '#38bdf8',
      label: 'AI Cam ' + (i + 1),
    }
  })
}

/**
 * Does this camera's field of view reach a point?
 *
 * Used by the security score, which is a summary rather than a measurement: it
 * checks the angle and the throw distance and ignores walls in between, which is
 * what the blind-spot sampler is for.
 */
export function cameraSeesPoint(cam, point) {
  const dx = point.x - cam.x
  const dy = point.y - cam.y
  const metres = Math.hypot(dx, dy) / PIXELS_PER_METER
  if (metres > (cam.distance || 10)) return false
  const rel = ((Math.atan2(dy, dx) * 180 / Math.PI) - (cam.rotation || 0) + 540) % 360 - 180
  return Math.abs(rel) <= (cam.hFov || 90) / 2
}

/** The centre of an object, whether it sits on a wall or free on the plan. */
export function objectCentre(obj, walls) {
  if (obj.wallId != null) {
    const wall = walls.find((w) => w.id === obj.wallId)
    if (wall) {
      const p1 = wall.points[obj.segmentIndex]
      const p2 = wall.points[(obj.segmentIndex + 1) % wall.points.length]
      const t = ((obj.t1 ?? 0) + (obj.t2 ?? 1)) / 2
      return { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t }
    }
  }
  if (typeof obj.x === 'number' && typeof obj.y === 'number') return { x: obj.x, y: obj.y }
  return null
}

/**
 * A security score for the plan, 0–100, with the reasons behind it.
 *
 * Four checks, each worth 20 and each something the customer can act on:
 *   coverage — a camera reaches every room (blind spots eat into this)
 *   entry    — at least one door or window is watched
 *   power    — every camera has a route back to an outlet
 *   overlap  — at least one room is watched by two cameras
 *
 * The last 20 are for the room with the most blind space not being the whole
 * house: a plan that only half-covers is worth less than one that is close.
 */
export function computeHealthScore(walls, cameras, objects, wires) {
  const rooms = walls.filter((w) => w.closed !== false && w.points.length >= 3)
  const checks = []
  let score = 0

  // Coverage (20)
  if (rooms.length === 0) {
    checks.push({ key: 'coverage', label: 'Rooms drawn', earned: 0, max: 20, advice: 'Close a room with the Wall or Rectangle tool to score coverage.' })
  } else {
    const blind = computeBlindSpots(walls, cameras, objects)
    const blindArea = blind.reduce((sum, b) => sum + b.area, 0)
    const covered = blind.length === 0
    const earned = covered ? 20 : blind.length >= rooms.length ? 0 : Math.round(20 * (1 - blind.length / rooms.length))
    score += earned
    checks.push({
      key: 'coverage',
      label: 'Every room watched',
      earned, max: 20,
      advice: blind.length === 0
        ? 'Every room has camera coverage.'
        : `No camera reaches ${blind.map((b) => b.label).join(', ')} (${blindArea.toFixed(1)} m² blind).`,
    })
  }

  // Entry points (20)
  const entries = objects.filter((o) => o.presetId === 'door' || o.presetId === 'window')
  if (entries.length === 0) {
    checks.push({ key: 'entry', label: 'Doors and windows watched', earned: 0, max: 20, advice: 'Place a door or window, then aim a camera at it.' })
  } else {
    const watched = entries.filter((entry) => {
      const centre = objectCentre(entry, walls)
      return centre && cameras.some((cam) => cameraSeesPoint(cam, centre))
    }).length
    const earned = Math.round(20 * (watched / entries.length))
    score += earned
    checks.push({
      key: 'entry',
      label: 'Doors and windows watched',
      earned, max: 20,
      advice: watched === entries.length
        ? `All ${entries.length} entry points are in view.`
        : `${entries.length - watched} of ${entries.length} entry points are not in any camera's field of view.`,
    })
  }

  // Power (20)
  if (cameras.length === 0) {
    checks.push({ key: 'power', label: 'Cameras have power', earned: 0, max: 20, advice: 'Place a camera, an outlet and a wire between them.' })
  } else {
    const powered = computePoweredCameraIds(cameras, objects, wires)
    const earned = Math.round(20 * (powered.size / cameras.length))
    score += earned
    checks.push({
      key: 'power',
      label: 'Cameras have power',
      earned, max: 20,
      advice: powered.size === cameras.length
        ? `All ${cameras.length} cameras are wired to an outlet.`
        : `${cameras.length - powered.size} of ${cameras.length} cameras are not wired to an outlet.`,
    })
  }

  // Overlap (20)
  const doorCentres = objects
    .filter((o) => o.presetId === 'door')
    .map((door) => objectCentre(door, walls))
    .filter(Boolean)
  const overlapping = doorCentres.some((centre) => cameras.filter((cam) => cameraSeesPoint(cam, centre)).length >= 2)
  const earned = overlapping ? 20 : 0
  score += earned
  checks.push({
    key: 'overlap',
    label: 'Two cameras on the main entrance',
    earned, max: 20,
    advice: overlapping
      ? 'At least one door is covered twice, so one camera failing leaves the view.'
      : 'Aim a second camera at a door so a single failure does not open the house up.',
  })

  return { score, checks, blindSpots: computeBlindSpots(walls, cameras, objects) }
}

/** The score in words, for the panel heading. */
export function scoreBand(score) {
  if (score >= 85) return { label: 'Well covered', tone: 'good' }
  if (score >= 60) return { label: 'Reasonable, with gaps', tone: 'fair' }
  if (score >= 30) return { label: 'Significant blind spots', tone: 'poor' }
  return { label: 'Barely covered', tone: 'bad' }
}
