import { useState, useRef, useEffect } from 'react'
import './App.css'

const PIXELS_PER_METER = 40
const PRESETS = [
  { id: 'indoor-wide', label: 'Indoor Wide', hFov: 90, distance: 8, color: '#4ade80' },
  { id: 'outdoor-bullet', label: 'Outdoor Bullet', hFov: 70, distance: 20, color: '#60a5fa' },
  { id: 'dome', label: 'Dome', hFov: 110, distance: 10, color: '#f472b6' },
  { id: 'ptz', label: 'PTZ', hFov: 30, distance: 50, color: '#fbbf24' },
]

const OBJECT_PRESETS = [
  { id: 'safe', label: 'Safe', width: 0.6, height: 0.5, blocksVision: true, color: '#ef4444' },
  { id: 'window', label: 'Window', width: 1.2, height: 0.1, blocksVision: false, color: '#3b82f6', resizable: true },
  { id: 'door', label: 'Door', width: 1, blocksVision: true, color: '#f59e0b', resizable: false },
]

let nextId = 1

function toCanvas(x, y, origin, pan, zoom) {
  return {
    x: (x - origin.x) * zoom + pan.x,
    y: (y - origin.y) * zoom + pan.y,
  }
}

function toWorld(x, y, origin, pan, zoom) {
  return {
    x: (x - pan.x) / zoom + origin.x,
    y: (y - pan.y) / zoom + origin.y,
  }
}

function drawFovShape(ctx, cam, origin, pan, zoom, walls, objects, extraWalls) {
  const start = toCanvas(cam.x, cam.y, origin, pan, zoom)
  const hFovRad = (cam.hFov * Math.PI) / 180
  const dist = cam.distance * PIXELS_PER_METER * zoom
  const rot = (cam.rotation * Math.PI) / 180

  const leftAngle = rot - hFovRad / 2
  const rightAngle = rot + hFovRad / 2

  ctx.beginPath()
  ctx.moveTo(start.x, start.y)

  const rayCount = 72
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
          const hitInWindow = segWindows.some((w) => u >= w.t1 && u <= w.t2)
          if (hitInWindow) continue
          const segDoors = doors.filter((d) => d.segmentIndex === j)
          const wallAngle = Math.atan2(p2World.y - p1World.y, p2World.x - p1World.x)
          const hitInClosedDoor = segDoors.some((d) => {
            const doorAngle = (d.rotation * Math.PI) / 180
            const relAngle = ((doorAngle - wallAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI
            const isClosed = Math.abs(relAngle) < Math.PI / 4 || Math.abs(relAngle) > Math.PI * 3 / 4
            return isClosed && u >= d.t1 && u <= d.t2
          })
          if (hitInClosedDoor) continue
          const hitDist = t
          if (hitDist < nearest && hitDist > 0) {
            nearest = hitDist
          }
        }
      }
    }

    for (const obj of objects) {
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

function drawSegmentLine(ctx, p1, p2, origin, pan, zoom) {
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

function drawRoomLabel(ctx, wall, origin, pan, zoom) {
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

function drawRectangle(ctx, x1, y1, x2, y2, zoom) {
  ctx.beginPath()
  ctx.rect(x1, y1, x2 - x1, y2 - y1)
  ctx.strokeStyle = '#111827'
  ctx.lineWidth = 3 * zoom
  ctx.stroke()
  ctx.fillStyle = 'rgba(17, 24, 39, 0.05)'
  ctx.fill()
}

function drawGrid(ctx, width, height, pan, zoom) {
  const step = 50 * zoom
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

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function projectPointOnSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return { t: 0, x: x1, y: y1 }
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return { t, x: x1 + t * dx, y: y1 + t * dy }
}

function rotatePoint(dx, dy, deg) {
  const rad = (deg * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return { x: dx * c - dy * s, y: dx * s + dy * c }
}

function isOnDoorHandle(canvasX, canvasY, obj, walls, origin, pan, zoom) {
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
    const hx = p1.x + (p2.x - p1.x) * obj.t2
    const hy = p1.y + (p2.y - p1.y) * obj.t2
    const cp = toCanvas(hx, hy, origin, pan, zoom)
    hingeCanvasX = cp.x
    hingeCanvasY = cp.y
  } else {
    const cp = toCanvas(obj.x, obj.y, origin, pan, zoom)
    hingeCanvasX = cp.x + Math.cos((obj.rotation * Math.PI) / 180) * half
    hingeCanvasY = cp.y + Math.sin((obj.rotation * Math.PI) / 180) * half
  }
  const handleAngle = (obj.rotation * Math.PI) / 180 + Math.PI / 2
  const handleX = hingeCanvasX + half * Math.cos(handleAngle)
  const handleY = hingeCanvasY + half * Math.sin(handleAngle)
  // allow clicking either the handle on the arc or the hinge pivot itself
  const handleHit = Math.hypot(canvasX - handleX, canvasY - handleY) < Math.max(18, 18 * zoom)
  const hingeHit = Math.hypot(canvasX - hingeCanvasX, canvasY - hingeCanvasY) < Math.max(12, 12 * zoom)
  return handleHit || hingeHit
}

function findNearestWallSegment(world, walls, origin, pan, zoom, maxPx = 12) {
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

function drawWindowOnWallSegment(ctx, x1, y1, x2, y2, origin, pan, zoom) {
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

function drawDoorOnWallSegment(ctx, x1, y1, x2, y2, rotation, origin, pan, zoom) {
  const start = toCanvas(x1, y1, origin, pan, zoom)
  const end = toCanvas(x2, y2, origin, pan, zoom)
  const wallAngle = Math.atan2(y2 - y1, x2 - x1)
  const doorAngle = (rotation * Math.PI) / 180

  const dx = end.x - start.x
  const dy = end.y - start.y
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len * 4 * zoom
  const ny = dx / len * 4 * zoom

  // pivot at the segment end (hinge)
  const pivotX = end.x
  const pivotY = end.y
  // vector from hinge to closed door start
  const vx = start.x - pivotX
  const vy = start.y - pivotY
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

function drawWall(ctx, wall, origin, pan, zoom, objects) {
  if (wall.points.length < 2) return
  const windows = objects.filter((obj) => obj.presetId === 'window' && obj.wallId === wall.id)
  const doors = objects.filter((obj) => obj.presetId === 'door' && obj.wallId === wall.id)
  const closed = wall.closed !== false
  for (let i = 0; i < wall.points.length; i++) {
    const p1 = wall.points[i]
    const nextI = closed ? (i + 1) % wall.points.length : i + 1
    if (nextI >= wall.points.length) break
    const p2 = wall.points[nextI]
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
          segObj.rotation, origin, pan, zoom)
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

function isPointInPolygon(x, y, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y
    const xj = polygon[j].x, yj = polygon[j].y
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

function drawObject(ctx, obj, origin, pan, zoom, walls) {
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
    drawDoorOnWallSegment(ctx, x1, y1, x2, y2, obj.rotation, origin, pan, zoom)
    return
  }

  const cp = toCanvas(obj.x, obj.y, origin, pan, zoom)
  const w = (obj.width || preset.width) * PIXELS_PER_METER * zoom
  const h = (obj.height || preset.height) * PIXELS_PER_METER * zoom
  const rot = (obj.rotation * Math.PI) / 180

  ctx.save()
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
  }

  // ensure we end in a clean state
  try { ctx.restore() } catch (e) { }
}

function drawRotationArc(ctx, cam, origin, pan, zoom) {
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

function isOnRotationHandle(canvasX, canvasY, cam, origin, pan, zoom) {
  const cp = toCanvas(cam.x, cam.y, origin, pan, zoom)
  const arcCX = cp.x
  const arcCY = cp.y
  const radius = 35 * zoom

  const handleAngle = (cam.rotation * Math.PI) / 180
  const handleX = arcCX + radius * Math.cos(handleAngle)
  const handleY = arcCY + radius * Math.sin(handleAngle)

  return Math.hypot(canvasX - handleX, canvasY - handleY) < 12
}

function App() {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const [mode, setMode] = useState('wall')
  const [selectedPreset, setSelectedPreset] = useState(PRESETS[0])
  const [walls, setWalls] = useState([])
  const [cameras, setCameras] = useState([])
  const [currentWall, setCurrentWall] = useState(null)
  const [rectStart, setRectStart] = useState(null)
  const [rectEnd, setRectEnd] = useState(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [origin, setOrigin] = useState({ x: 0, y: 0 })
  const [drag, setDrag] = useState(null)
  const [selectedCamera, setSelectedCamera] = useState(null)
  const [placingCamera, setPlacingCamera] = useState(null)
  const [rotateDrag, setRotateDrag] = useState(false)
  const [objects, setObjects] = useState([])
  const [placingObject, setPlacingObject] = useState(null)
  const [selectedObject, setSelectedObject] = useState(null)
  const [selectedRoom, setSelectedRoom] = useState(null)
  const [showObjectPanel, setShowObjectPanel] = useState(false)
  const [activeObjectPreset, setActiveObjectPreset] = useState(OBJECT_PRESETS[0])
  const [resizing, setResizing] = useState(null)
  const [hoveredPoint, setHoveredPoint] = useState(null)
  const [windowDrag, setWindowDrag] = useState(null)
  const [lastClick, setLastClick] = useState(null)

  const [size, setSize] = useState({ width: 800, height: 600 })

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const w = containerRef.current.clientWidth
    const h = containerRef.current.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)
    if (size.width !== w || size.height !== h) setSize({ width: w, height: h })

    ctx.fillStyle = '#f8fafc'
    ctx.fillRect(0, 0, w, h)
    drawGrid(ctx, w, h, pan, zoom)

    for (const wall of walls) {
      drawWall(ctx, wall, origin, pan, zoom, objects)
      drawRoomLabel(ctx, wall, origin, pan, zoom)
    }
    if (currentWall) {
      drawWall(ctx, currentWall, origin, pan, zoom, [])
    }

    if (hoveredPoint && mode === 'object' && (activeObjectPreset.id === 'window' || activeObjectPreset.id === 'door')) {
      ctx.beginPath()
      ctx.arc(hoveredPoint.x, hoveredPoint.y, 5 * zoom, 0, Math.PI * 2)
      ctx.fillStyle = '#60a5fa'
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
    }

    for (const cam of cameras) {
      const cp = toCanvas(cam.x, cam.y, origin, pan, zoom)
      drawFovShape(ctx, cam, origin, pan, zoom, walls, objects, currentWall ? [currentWall] : [])
      const rot = (cam.rotation * Math.PI) / 180
      const arrowLen = 12 * zoom
      const dirX = cp.x + arrowLen * Math.cos(rot)
      const dirY = cp.y + arrowLen * Math.sin(rot)
      ctx.beginPath()
      ctx.moveTo(cp.x, cp.y)
      ctx.lineTo(dirX, dirY)
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(cp.x, cp.y, 6 * zoom, 0, Math.PI * 2)
      ctx.fillStyle = cam.color
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.fillStyle = '#000'
      ctx.font = '10px system-ui, sans-serif'
      ctx.fillText(cam.label || 'Cam', cp.x + 9, cp.y + 3)
    }

    if (placingCamera) {
      const cp = toCanvas(placingCamera.x, placingCamera.y, origin, pan, zoom)
      ctx.beginPath()
      ctx.arc(cp.x, cp.y, 6 * zoom, 0, Math.PI * 2)
      ctx.fillStyle = placingCamera.preset.color + '88'
      ctx.fill()
      ctx.strokeStyle = placingCamera.preset.color
      ctx.lineWidth = 2
      ctx.stroke()
    }

    if (selectedCamera) {
      drawRotationArc(ctx, selectedCamera, origin, pan, zoom)
    }

    if (selectedObject && selectedObject.presetId === 'door' && selectedObject.wallId != null) {
      const wall = walls.find((w) => w.id === selectedObject.wallId)
      if (wall && wall.points.length >= 2) {
        const p1 = wall.points[selectedObject.segmentIndex]
        const p2 = wall.points[(selectedObject.segmentIndex + 1) % wall.points.length]
        // hinge is at t2 (right side of door)
        const hxWorld = p1.x + (p2.x - p1.x) * selectedObject.t2
        const hyWorld = p1.y + (p2.y - p1.y) * selectedObject.t2
        const hinge = toCanvas(hxWorld, hyWorld, origin, pan, zoom)
        const rot = (selectedObject.rotation * Math.PI) / 180
        const wpx = (selectedObject.width || OBJECT_PRESETS.find((p) => p.id === 'door').width) * PIXELS_PER_METER * zoom
        const radius = wpx / 2

        ctx.beginPath()
        ctx.setLineDash([4 * zoom, 4 * zoom])
        ctx.strokeStyle = '#3b82f6'
        ctx.lineWidth = 2
        // arc centered on hinge so swing visually matches pivot
        ctx.arc(hinge.x, hinge.y, radius, rot + Math.PI / 2, rot - Math.PI / 2)
        ctx.stroke()
        ctx.setLineDash([])

        const handleAngle = rot + Math.PI / 2
        const handleX = hinge.x + radius * Math.cos(handleAngle)
        const handleY = hinge.y + radius * Math.sin(handleAngle)

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
    }

    for (const obj of objects) {
      drawObject(ctx, obj, origin, pan, zoom, walls)
      if (selectedObject && selectedObject.id === obj.id) {
        const preset = OBJECT_PRESETS.find((p) => p.id === obj.presetId)
        if (preset && preset.resizable && obj.presetId !== 'window') {
          const cp = toCanvas(obj.x, obj.y, origin, pan, zoom)
          const w = (obj.width || preset.width) * PIXELS_PER_METER * zoom
          const h = (obj.height || preset.height) * PIXELS_PER_METER * zoom
          ctx.strokeStyle = '#3b82f6'
          ctx.lineWidth = 2
          ctx.setLineDash([4, 4])
          ctx.strokeRect(cp.x - w / 2, cp.y - h / 2, w, h)
          ctx.setLineDash([])
        }
        // door selection visuals are drawn separately above when `selectedObject` is a door
      }
    }

    // DEBUG: draw hinge markers for doors in select mode so pivots are visible
    if (mode === 'select') {
      for (const obj of objects) {
        if (obj.presetId !== 'door') continue
        let hxWorld, hyWorld
        if (obj.wallId != null) {
          const wall = walls.find((w) => w.id === obj.wallId)
          if (!wall) continue
          const p1 = wall.points[obj.segmentIndex]
          const p2 = wall.points[(obj.segmentIndex + 1) % wall.points.length]
          hxWorld = p1.x + (p2.x - p1.x) * obj.t2
          hyWorld = p1.y + (p2.y - p1.y) * obj.t2
        } else {
          const rot = (obj.rotation * Math.PI) / 180
          hxWorld = obj.x + (obj.width || OBJECT_PRESETS.find((p) => p.id === 'door').width) / 2 * Math.cos(rot)
          hyWorld = obj.y + (obj.width || OBJECT_PRESETS.find((p) => p.id === 'door').width) / 2 * Math.sin(rot)
        }
        const hinge = toCanvas(hxWorld, hyWorld, origin, pan, zoom)
        ctx.beginPath()
        ctx.arc(hinge.x, hinge.y, 6 * zoom, 0, Math.PI * 2)
        ctx.fillStyle = '#ef4444'
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }

    if (placingObject) {
      drawObject(ctx, placingObject, origin, pan, zoom, walls)
    }

    if (windowDrag) {
      const wall = walls.find((w) => w.id === windowDrag.wallId)
      if (wall && wall.points.length >= 2) {
        const p1 = wall.points[windowDrag.segmentIndex]
        const p2 = wall.points[(windowDrag.segmentIndex + 1) % wall.points.length]
        const t1 = Math.min(windowDrag.startT, windowDrag.currentT)
        const t2 = Math.max(windowDrag.startT, windowDrag.currentT)
        const x1 = p1.x + (p2.x - p1.x) * t1
        const y1 = p1.y + (p2.y - p1.y) * t1
        const x2 = p1.x + (p2.x - p1.x) * t2
        const y2 = p1.y + (p2.y - p1.y) * t2
        drawWindowOnWallSegment(ctx, x1, y1, x2, y2, origin, pan, zoom)
      }
    }

    if (selectedRoom !== null) {
      ctx.beginPath()
      const first = toCanvas(walls[selectedRoom].points[0].x, walls[selectedRoom].points[0].y, origin, pan, zoom)
      ctx.moveTo(first.x, first.y)
      for (let i = 1; i < walls[selectedRoom].points.length; i++) {
        const p = toCanvas(walls[selectedRoom].points[i].x, walls[selectedRoom].points[i].y, origin, pan, zoom)
        ctx.lineTo(p.x, p.y)
      }
      ctx.closePath()
      ctx.strokeStyle = '#ef4444'
      ctx.lineWidth = 3
      ctx.setLineDash([6, 4])
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(239, 68, 68, 0.1)'
      ctx.fill()
    }

    if (rectStart && rectEnd) {
      const p1 = toCanvas(rectStart.x, rectStart.y, origin, pan, zoom)
      const p2 = toCanvas(rectEnd.x, rectEnd.y, origin, pan, zoom)
      drawRectangle(ctx, p1.x, p1.y, p2.x, p2.y, zoom)
    }

    if (currentWall) {
      const last = currentWall.points[currentWall.points.length - 1]
      const lastC = toCanvas(last.x, last.y, origin, pan, zoom)
      ctx.beginPath()
      ctx.arc(lastC.x, lastC.y, 4, 0, Math.PI * 2)
      ctx.fillStyle = '#ef4444'
      ctx.fill()
    }
  }, [walls, currentWall, cameras, pan, zoom, origin, mode, size, placingCamera, selectedCamera, rectStart, rectEnd, objects, placingObject, selectedRoom, hoveredPoint, activeObjectPreset, selectedObject, windowDrag])

  function getMouseWorld(e) {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    return toWorld(x, y, origin, pan, zoom)
  }

  function getMouseCanvas(e) {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function handleMouseDown(e) {
    const world = getMouseWorld(e)
    const c = getMouseCanvas(e)
    // show a brief click marker for debugging selection
    setLastClick({ x: c.x, y: c.y })
    setTimeout(() => setLastClick(null), 800)

    const currentSelected = selectedCamera ? cameras.find((cam) => cam.id === selectedCamera.id) || selectedCamera : null

    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      setDrag({ type: 'pan', startX: e.clientX, startY: e.clientY, startPan: { ...pan } })
      setRotateDrag(false)
      setPlacingCamera(null)
      setRectStart(null)
      setRectEnd(null)
      setPlacingObject(null)
      setWindowDrag(null)
      setShowObjectPanel(false)
      return
    }

    // Allow selecting/rotating cameras and doors regardless of current mode (helps quick edits)
    if (e.button === 0) {
      if (currentSelected && isOnRotationHandle(c.x, c.y, currentSelected, origin, pan, zoom)) {
        setRotateDrag({ type: 'rotateCam', camId: currentSelected.id, centerX: currentSelected.x, centerY: currentSelected.y })
        return
      }

      for (const obj of objects) {
        if (obj.presetId !== 'door') continue
        // handle hit on rotation handle
        if (isOnDoorHandle(c.x, c.y, obj, walls, origin, pan, zoom)) {
          setSelectedObject(obj)
          setSelectedRoom(null)
          setSelectedCamera(null)
          const rot = (obj.rotation * Math.PI) / 180
          const half = (obj.width || OBJECT_PRESETS.find((p) => p.id === 'door').width) / 2
          let hingeX, hingeY
          if (obj.wallId != null) {
            const wall = walls.find((w) => w.id === obj.wallId)
            const p1 = wall.points[obj.segmentIndex]
            const p2 = wall.points[(obj.segmentIndex + 1) % wall.points.length]
            hingeX = p1.x + (p2.x - p1.x) * obj.t2
            hingeY = p1.y + (p2.y - p1.y) * obj.t2
          } else {
            hingeX = obj.x + half * Math.cos(rot)
            hingeY = obj.y + half * Math.sin(rot)
          }
          const startAngle = Math.atan2(world.y - hingeY, world.x - hingeX)
          setRotateDrag({ type: 'rotateDoor', objectId: obj.id, centerX: hingeX, centerY: hingeY, startAngle, startRotation: obj.rotation })
          return
        }
      }

      // Hit-test door bodies so clicks select them in any mode
      for (const obj of objects) {
        if (obj.presetId !== 'door') continue
        if (obj.wallId != null) {
          const wall = walls.find((w) => w.id === obj.wallId)
          if (!wall) continue
          const p1 = wall.points[obj.segmentIndex]
          const p2 = wall.points[(obj.segmentIndex + 1) % wall.points.length]
          const hx = p1.x + (p2.x - p1.x) * obj.t2
          const hy = p1.y + (p2.y - p1.y) * obj.t2
          const hingeCanvas = toCanvas(hx, hy, origin, pan, zoom)
          // use rotation relative to the wall so hit-test matches drawDoorOnWallSegment
          const wallAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
          const rot = (obj.rotation * Math.PI) / 180 - wallAngle
          const preset = OBJECT_PRESETS.find((p) => p.id === obj.presetId)
          const wpx = (obj.width || preset.width) * PIXELS_PER_METER * zoom
          const hpx = (obj.height || preset.height) * PIXELS_PER_METER * zoom
          const dxH = c.x - hingeCanvas.x
          const dyH = c.y - hingeCanvas.y
          const cosR = Math.cos(rot)
          const sinR = Math.sin(rot)
          const localX = dxH * cosR + dyH * sinR
          const localY = -dxH * sinR + dyH * cosR
          if (localX >= -wpx - 4 && localX <= 4 && localY >= -hpx / 2 - 4 && localY <= hpx / 2 + 4) {
            setSelectedObject(obj)
            setSelectedRoom(null)
            setSelectedCamera(null)
            // start rotation around hinge by default on body click
            const hingeX = hx
            const hingeY = hy
            const startAngle = Math.atan2(world.y - hingeY, world.x - hingeX)
            setRotateDrag({ type: 'rotateDoor', objectId: obj.id, centerX: hingeX, centerY: hingeY, startAngle, startRotation: obj.rotation })
            return
          }
        } else {
          const cp = toCanvas(obj.x, obj.y, origin, pan, zoom)
          const rot = (obj.rotation * Math.PI) / 180
          const preset = OBJECT_PRESETS.find((p) => p.id === obj.presetId)
          const wpx = (obj.width || preset.width) * PIXELS_PER_METER * zoom
          const hpx = (obj.height || preset.height) * PIXELS_PER_METER * zoom
          const hingeX = cp.x + Math.cos(rot) * (wpx / 2)
          const hingeY = cp.y + Math.sin(rot) * (wpx / 2)
          const dx = c.x - hingeX
          const dy = c.y - hingeY
          const cosR = Math.cos(rot)
          const sinR = Math.sin(rot)
          const localX = dx * cosR + dy * sinR
          const localY = -dx * sinR + dy * cosR
          if (localX >= -wpx - 4 && localX <= 4 && localY >= -hpx / 2 - 4 && localY <= hpx / 2 + 4) {
            objHit = obj
            break
          }
        }
      }
    }

    if (mode === 'object') {
      if (showObjectPanel && e.target !== e.currentTarget) return
      if (activeObjectPreset.id === 'window') {
        const hit = findNearestWallSegment(world, walls, origin, pan, zoom, 12)
        if (hit) {
          setWindowDrag({ wallId: hit.wallId, segmentIndex: hit.segmentIndex, startT: hit.t, currentT: hit.t })
        }
      } else if (activeObjectPreset.id === 'door') {
        const hit = findNearestWallSegment(world, walls, origin, pan, zoom, 12)
        if (hit) {
          const wall = walls.find((w) => w.id === hit.wallId)
          if (wall) {
            const p1 = wall.points[hit.segmentIndex]
            const p2 = wall.points[(hit.segmentIndex + 1) % wall.points.length]
            const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y)
            const doorWidthPx = 1 * PIXELS_PER_METER
            const halfDoor = doorWidthPx / 2 / segLen
            const t1 = Math.max(0, hit.t - halfDoor)
            const t2 = Math.min(1, hit.t + halfDoor)
            const wallAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI
            setObjects((prev) => [...prev, {
              id: nextId++,
              presetId: 'door',
              wallId: hit.wallId,
              segmentIndex: hit.segmentIndex,
              t1,
              t2,
              rotation: wallAngle,
            }])
          }
        }
      } else {
        setPlacingObject({ id: nextId++, presetId: activeObjectPreset.id, x: world.x, y: world.y, rotation: 0 })
      }
      return
    }

    if (mode === 'camera') {
      setPlacingCamera({ id: nextId++, x: world.x, y: world.y, preset: selectedPreset })
      return
    }

    if (mode === 'rectangle') {
      setRectStart({ x: world.x, y: world.y })
      setRectEnd({ x: world.x, y: world.y })
      setDrag({ type: 'rect', startX: world.x, startY: world.y })
      return
    }

    if (mode === 'wall') {
      setCurrentWall((prev) => {
        const points = prev ? [...prev.points, { x: world.x, y: world.y }] : [{ x: world.x, y: world.y }]
        return {
          id: prev?.id ?? nextId++,
          ...prev,
          points,
          label: prev?.label || `Room ${walls.length + 1}`,
        }
      })
      return
    }

    if (mode === 'select') {
      
      if (currentSelected && isOnRotationHandle(c.x, c.y, currentSelected, origin, pan, zoom)) {
        setRotateDrag({ type: 'rotateCam', camId: currentSelected.id, centerX: currentSelected.x, centerY: currentSelected.y })
        return
      }

      // Check door rotation handle clicks first
      for (const obj of objects) {
        if (obj.presetId === 'door') {
          const isHandle = isOnDoorHandle(c.x, c.y, obj, walls, origin, pan, zoom)
          
          if (isHandle) {
            setSelectedObject(obj)
            setSelectedRoom(null)
            setSelectedCamera(null)
            const rot = (obj.rotation * Math.PI) / 180
            const half = (obj.width || OBJECT_PRESETS.find((p) => p.id === 'door').width) / 2
            let hingeX, hingeY
            if (obj.wallId != null) {
              const wall = walls.find((w) => w.id === obj.wallId)
              const p1 = wall.points[obj.segmentIndex]
              const p2 = wall.points[(obj.segmentIndex + 1) % wall.points.length]
              hingeX = p1.x + (p2.x - p1.x) * obj.t2
              hingeY = p1.y + (p2.y - p1.y) * obj.t2
            } else {
              hingeX = obj.x + half * Math.cos(rot)
              hingeY = obj.y + half * Math.sin(rot)
            }
            const startAngle = Math.atan2(world.y - hingeY, world.x - hingeX)
            
            setRotateDrag({ type: 'rotateDoor', objectId: obj.id, centerX: hingeX, centerY: hingeY, startAngle, startRotation: obj.rotation })
            return
          }
        }
      }

      let hit = null
      for (const cam of cameras) {
        const cp = toCanvas(cam.x, cam.y, origin, pan, zoom)
        if (Math.hypot(c.x - cp.x, c.y - cp.y) < 12) {
          hit = cam
          break
        }
      }

      if (hit) {
        setSelectedCamera(hit)
        setSelectedRoom(null)
        setSelectedObject(null)
        setDrag({ type: 'move', camId: hit.id, startX: world.x, startY: world.y })
        return
      }

      let objHit = null
      for (const obj of objects) {
        if (obj.presetId === 'window' && obj.wallId != null) {
          const wall = walls.find((w) => w.id === obj.wallId)
          if (!wall) continue
          const p1 = wall.points[obj.segmentIndex]
          const p2 = wall.points[(obj.segmentIndex + 1) % wall.points.length]
          const c1 = toCanvas(p1.x, p1.y, origin, pan, zoom)
          const c2 = toCanvas(p2.x, p2.y, origin, pan, zoom)
          const dist = distanceToSegment(c.x, c.y, c1.x, c1.y, c2.x, c2.y)
          if (dist < 10) {
            const proj = projectPointOnSegment(world.x, world.y, p1.x, p1.y, p2.x, p2.y)
            if (proj.t >= obj.t1 - 0.05 && proj.t <= obj.t2 + 0.05) {
              objHit = obj
              break
            }
          }
        } else if (obj.presetId === 'door' && obj.wallId != null) {
          // Hit-test rotated door rectangle for wall-attached doors (hinge at segment t2)
          const wall = walls.find((w) => w.id === obj.wallId)
          if (!wall) continue
          const p1 = wall.points[obj.segmentIndex]
          const p2 = wall.points[(obj.segmentIndex + 1) % wall.points.length]
          const hx = p1.x + (p2.x - p1.x) * obj.t2
          const hy = p1.y + (p2.y - p1.y) * obj.t2
          const hingeCanvas = toCanvas(hx, hy, origin, pan, zoom)
          // rotation relative to the wall segment so hit-test matches drawn door
          const wallAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
          const rot = (obj.rotation * Math.PI) / 180 - wallAngle
          const preset = OBJECT_PRESETS.find((p) => p.id === obj.presetId)
          const wpx = (obj.width || preset.width) * PIXELS_PER_METER * zoom
          const hpx = (obj.height || preset.height) * PIXELS_PER_METER * zoom
          const dxH = c.x - hingeCanvas.x
          const dyH = c.y - hingeCanvas.y
          const cosR = Math.cos(rot)
          const sinR = Math.sin(rot)
          // inverse rotate to door-local coords
          const localX = dxH * cosR + dyH * sinR
          const localY = -dxH * sinR + dyH * cosR
          // allow a small padding for easier clicking
          if (localX >= -wpx - 12 && localX <= 12 && localY >= -hpx / 2 - 12 && localY <= hpx / 2 + 12) {
            objHit = obj
            break
          }
        } else {
          const preset = OBJECT_PRESETS.find((p) => p.id === obj.presetId)
          if (!preset) continue
          // Special-case free doors: hit-test against rotated rectangle using hinge-based drawing
          if (obj.presetId === 'door' && obj.wallId == null) {
            const cp = toCanvas(obj.x, obj.y, origin, pan, zoom)
            const rot = (obj.rotation * Math.PI) / 180
            const wpx = (obj.width || preset.width) * PIXELS_PER_METER * zoom
            const hpx = (obj.height || preset.height) * PIXELS_PER_METER * zoom
            const hingeX = cp.x + Math.cos(rot) * (wpx / 2)
            const hingeY = cp.y + Math.sin(rot) * (wpx / 2)
            const dx = c.x - hingeX
            const dy = c.y - hingeY
            const cosR = Math.cos(rot)
            const sinR = Math.sin(rot)
            const localX = dx * cosR + dy * sinR
            const localY = -dx * sinR + dy * cosR
            if (localX >= -wpx - 12 && localX <= 12 && localY >= -hpx / 2 - 12 && localY <= hpx / 2 + 12) {
              objHit = obj
              break
            }
          } else {
            const w = obj.width || preset.width
            const h = obj.height || preset.height
            if (
              world.x >= obj.x - w / 2 &&
              world.x <= obj.x + w / 2 &&
              world.y >= obj.y - h / 2 &&
              world.y <= obj.y + h / 2
            ) {
              objHit = obj
              break
            }
          }
        }
      }

      if (objHit) {
        setSelectedObject(objHit)
        setSelectedRoom(null)
        setSelectedCamera(null)

        if (objHit.presetId === 'window' && objHit.wallId != null) {
          const wall = walls.find((w) => w.id === objHit.wallId)
          if (wall) {
            const p1 = wall.points[objHit.segmentIndex]
            const p2 = wall.points[(objHit.segmentIndex + 1) % wall.points.length]
            const x1 = p1.x + (p2.x - p1.x) * objHit.t1
            const y1 = p1.y + (p2.y - p1.y) * objHit.t1
            const x2 = p1.x + (p2.x - p1.x) * objHit.t2
            const y2 = p1.y + (p2.y - p1.y) * objHit.t2
            const end = Math.hypot(world.x - x1, world.y - y1) < Math.hypot(world.x - x2, world.y - y2) ? 't1' : 't2'
            setDrag({
              type: 'resizeWindow',
              objectId: objHit.id,
              end,
              wallId: objHit.wallId,
              segmentIndex: objHit.segmentIndex,
              otherT: end === 't1' ? objHit.t2 : objHit.t1,
            })
          }
        } else if (objHit.presetId === 'door' && objHit.wallId != null) {
          const wall = walls.find((w) => w.id === objHit.wallId)
          if (wall) {
            const p1 = wall.points[objHit.segmentIndex]
            const p2 = wall.points[(objHit.segmentIndex + 1) % wall.points.length]
            const midT = (objHit.t1 + objHit.t2) / 2
            const cx = p1.x + (p2.x - p1.x) * midT
            const cy = p1.y + (p2.y - p1.y) * midT
            setSelectedObject(objHit)
            setSelectedRoom(null)
            setSelectedCamera(null)
            // Use hinge (segment end) as rotation center for door
            const hingeX = p1.x + (p2.x - p1.x) * objHit.t2
            const hingeY = p1.y + (p2.y - p1.y) * objHit.t2
            const startAngle = Math.atan2(world.y - hingeY, world.x - hingeX)
            
            setRotateDrag({ type: 'rotateDoor', objectId: objHit.id, centerX: hingeX, centerY: hingeY, startAngle, startRotation: objHit.rotation })
          }
        } else {
          const preset = OBJECT_PRESETS.find((p) => p.id === objHit.presetId)
          if (preset && preset.resizable) {
            setDrag({ type: 'resizeObject', objectId: objHit.id, startX: world.x, startY: world.y, origX: objHit.x, origY: objHit.y, origWidth: objHit.width || preset.width, origHeight: objHit.height || preset.height })
          } else {
            setDrag({ type: 'moveObject', objectId: objHit.id, startX: world.x, startY: world.y })
          }
        }
        return
      }

      for (let i = 0; i < walls.length; i++) {
        if (isPointInPolygon(world.x, world.y, walls[i].points)) {
          setSelectedRoom(i)
          setSelectedCamera(null)
          setSelectedObject(null)
          return
        }
      }

      setSelectedCamera(null)
      setSelectedObject(null)
      setSelectedRoom(null)
    }
  }

  function handleMouseMove(e) {
    if (placingCamera) {
      const world = getMouseWorld(e)
      setPlacingCamera((prev) => prev ? { ...prev, x: world.x, y: world.y } : null)
      return
    }

    if (placingObject) {
      const world = getMouseWorld(e)
      if (placingObject.presetId === 'window' && placingObject.wallId != null) {
        const wall = walls.find((w) => w.id === placingObject.wallId)
        if (wall) {
          const p1 = wall.points[placingObject.segmentIndex]
          const p2 = wall.points[(placingObject.segmentIndex + 1) % wall.points.length]
          const proj = projectPointOnSegment(world.x, world.y, p1.x, p1.y, p2.x, p2.y)
          let t1 = placingObject.t1
          let t2 = proj.t
          if (t1 > t2) [t1, t2] = [t2, t1]
          setPlacingObject((prev) => prev ? { ...prev, t1, t2 } : null)
        }
      } else {
        setPlacingObject((prev) => prev ? { ...prev, x: world.x, y: world.y } : null)
      }
      return
    }

    if (windowDrag) {
      const world = getMouseWorld(e)
      const wall = walls.find((w) => w.id === windowDrag.wallId)
      if (wall) {
        const p1 = wall.points[windowDrag.segmentIndex]
        const p2 = wall.points[(windowDrag.segmentIndex + 1) % wall.points.length]
        const proj = projectPointOnSegment(world.x, world.y, p1.x, p1.y, p2.x, p2.y)
        setWindowDrag((prev) => prev ? { ...prev, currentT: Math.max(0, Math.min(1, proj.t)) } : null)
      }
      return
    }

    if (mode === 'object' && (activeObjectPreset.id === 'window' || activeObjectPreset.id === 'door') && !placingObject) {
      const world = getMouseWorld(e)
      const hit = findNearestWallSegment(world, walls, origin, pan, zoom, 12)
      if (hit) {
        const px = hit.p1.x + (hit.p2.x - hit.p1.x) * hit.t
        const py = hit.p1.y + (hit.p2.y - hit.p1.y) * hit.t
        setHoveredPoint({ x: px, y: py })
      } else {
        setHoveredPoint(null)
      }
    } else {
      setHoveredPoint(null)
    }

    if (rotateDrag) {
      
      const world = getMouseWorld(e)
      const dx = world.x - rotateDrag.centerX
      const dy = world.y - rotateDrag.centerY
      let angle = Math.atan2(dy, dx)
      let rotation = angle * 180 / Math.PI
      rotation = ((rotation % 360) + 360) % 360
      if (rotateDrag.camId) {
        setCameras((prev) =>
          prev.map((c) => (c.id === rotateDrag.camId ? { ...c, rotation: Math.round(rotation) } : c))
        )
      }
      if (rotateDrag.objectId) {
        const door = objects.find((o) => o.id === rotateDrag.objectId)
        if (door) {
          // continuous rotation based on startAngle/startRotation to avoid jumps
          if (rotateDrag.startAngle != null && rotateDrag.startRotation != null) {
            const currentAngle = Math.atan2(world.y - rotateDrag.centerY, world.x - rotateDrag.centerX)
            const delta = currentAngle - rotateDrag.startAngle
            let newRot = rotateDrag.startRotation + (delta * 180 / Math.PI)
            // determine base angle for clamping: wall angle if attached, otherwise startRotation
            let baseAngle = rotateDrag.startRotation
            if (door && door.wallId != null) {
              const wall = walls.find((w) => w.id === door.wallId)
              if (wall) {
                const p1 = wall.points[door.segmentIndex]
                const p2 = wall.points[(door.segmentIndex + 1) % wall.points.length]
                baseAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI
              }
            }
            let rel = newRot - baseAngle
            rel = ((rel % 360) + 360) % 360
            if (rel > 180) rel -= 360
            const clamped = Math.max(-90, Math.min(90, rel))
            const finalRotation = ((baseAngle + clamped) % 360 + 360) % 360
            setObjects((prev) => prev.map((o) => (o.id === rotateDrag.objectId ? { ...o, rotation: finalRotation } : o)))
            setSelectedObject((prev) => prev && prev.id === rotateDrag.objectId ? { ...prev, rotation: finalRotation } : prev)
          } else if (door.wallId != null) {
            const wall = walls.find((w) => w.id === door.wallId)
            if (wall) {
              const p1 = wall.points[door.segmentIndex]
              const p2 = wall.points[(door.segmentIndex + 1) % wall.points.length]
              const wallAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI
              let relRotation = rotation - wallAngle
              relRotation = ((relRotation % 360) + 360) % 360
              if (relRotation > 180) relRotation -= 360
              const finalRotation = (wallAngle + relRotation) % 360
              setObjects((prev) => prev.map((o) => (o.id === rotateDrag.objectId ? { ...o, rotation: finalRotation } : o)))
              setSelectedObject((prev) => prev && prev.id === rotateDrag.objectId ? { ...prev, rotation: finalRotation } : prev)
            }
          }
        }
      }
      return
    }

    if (!drag) return
    if (drag.type === 'pan') {
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      setPan({ x: drag.startPan.x + dx, y: drag.startPan.y + dy })
    } else if (drag.type === 'move' && drag.camId) {
      const world = getMouseWorld(e)
      setCameras((prev) =>
        prev.map((c) => (c.id === drag.camId ? { ...c, x: world.x, y: world.y } : c))
      )
      setSelectedCamera((prev) => prev && prev.id === drag.camId ? { ...prev, x: world.x, y: world.y } : prev)
    } else if (drag.type === 'moveObject' && drag.objectId) {
      const world = getMouseWorld(e)
      const obj = objects.find((o) => o.id === drag.objectId)
      if (obj && obj.presetId === 'door' && obj.wallId != null) {
        const wall = walls.find((w) => w.id === obj.wallId)
        if (wall) {
          const p1 = wall.points[obj.segmentIndex]
          const p2 = wall.points[(obj.segmentIndex + 1) % wall.points.length]
          const proj = projectPointOnSegment(world.x, world.y, p1.x, p1.y, p2.x, p2.y)
          const doorWidth = obj.t2 - obj.t1
          let newT1 = proj.t - doorWidth / 2
          let newT2 = proj.t + doorWidth / 2
          if (newT1 < 0) {
            newT1 = 0
            newT2 = doorWidth
          }
          if (newT2 > 1) {
            newT2 = 1
            newT1 = 1 - doorWidth
          }
          setObjects((prev) => prev.map((o) => (o.id === drag.objectId ? { ...o, t1: newT1, t2: newT2 } : o)))
          setSelectedObject((prev) => prev && prev.id === drag.objectId ? { ...prev, t1: newT1, t2: newT2 } : prev)
        }
      } else {
        setObjects((prev) =>
          prev.map((o) => (o.id === drag.objectId ? { ...o, x: world.x, y: world.y } : o))
        )
        setSelectedObject((prev) => prev && prev.id === drag.objectId ? { ...prev, x: world.x, y: world.y } : prev)
      }
    } else if (drag.type === 'resizeWindow' && drag.objectId) {
      const world = getMouseWorld(e)
      const obj = objects.find((o) => o.id === drag.objectId)
      const wall = walls.find((w) => w.id === drag.wallId)
      if (obj && wall) {
        const p1 = wall.points[drag.segmentIndex]
        const p2 = wall.points[(drag.segmentIndex + 1) % wall.points.length]
        const proj = projectPointOnSegment(world.x, world.y, p1.x, p1.y, p2.x, p2.y)
        if (drag.end === 't1') {
          const newT1 = Math.min(Math.max(proj.t, 0), drag.otherT - 0.02)
          setObjects((prev) => prev.map((o) => (o.id === drag.objectId ? { ...o, t1: newT1 } : o)))
          setSelectedObject((prev) => prev && prev.id === drag.objectId ? { ...prev, t1: newT1 } : prev)
        } else {
          const newT2 = Math.max(Math.min(proj.t, 1), drag.otherT + 0.02)
          setObjects((prev) => prev.map((o) => (o.id === drag.objectId ? { ...o, t2: newT2 } : o)))
          setSelectedObject((prev) => prev && prev.id === drag.objectId ? { ...prev, t2: newT2 } : prev)
        }
      }
    } else if (drag.type === 'resizeObject' && drag.objectId) {
      const world = getMouseWorld(e)
      const obj = objects.find((o) => o.id === drag.objectId)
      const preset = OBJECT_PRESETS.find((p) => p.id === obj.presetId)
      if (obj && preset) {
        const newWidth = Math.max(0.3, Math.abs(world.x - drag.origX) * 2)
        const newHeight = Math.max(0.2, Math.abs(world.y - drag.origY) * 2)
        setObjects((prev) => prev.map((o) => (o.id === drag.objectId ? { ...o, width: newWidth, height: newHeight } : o)))
        setSelectedObject((prev) => prev && prev.id === drag.objectId ? { ...prev, width: newWidth, height: newHeight } : prev)
      }
    } else if (drag.type === 'rect') {
      const world = getMouseWorld(e)
      setRectEnd({ x: world.x, y: world.y })
    }
  }

  function handleMouseUp() {
    if (placingCamera) {
      const preset = placingCamera.preset
      setCameras((prev) => [
        ...prev,
        {
          id: placingCamera.id,
          x: placingCamera.x,
          y: placingCamera.y,
          rotation: 0,
          hFov: preset.hFov,
          distance: preset.distance,
          color: preset.color,
          label: `Cam ${prev.length + 1}`,
        },
      ])
      setPlacingCamera(null)
      setMode('select')
    }

    if (windowDrag) {
      const t1 = Math.min(windowDrag.startT, windowDrag.currentT)
      const t2 = Math.max(windowDrag.startT, windowDrag.currentT)
      if (Math.abs(t2 - t1) > 0.02) {
        setObjects((prev) => [...prev, {
          id: nextId++,
          presetId: 'window',
          wallId: windowDrag.wallId,
          segmentIndex: windowDrag.segmentIndex,
          t1,
          t2,
        }])
      }
      setWindowDrag(null)
    }

    if (placingObject) {
      if (placingObject.presetId === 'window' && placingObject.wallId != null) {
        if (Math.abs(placingObject.t2 - placingObject.t1) > 0.02) {
          setObjects((prev) => [...prev, placingObject])
        }
      } else {
        const preset = OBJECT_PRESETS.find((p) => p.id === placingObject.presetId)
        setObjects((prev) => [...prev, {
          ...placingObject,
          width: preset.width,
          height: preset.height,
        }])
      }
      setPlacingObject(null)
    }

    if (drag && drag.type === 'rect' && rectStart && rectEnd) {
      const x = Math.min(rectStart.x, rectEnd.x)
      const y = Math.min(rectStart.y, rectEnd.y)
      const w = Math.abs(rectEnd.x - rectStart.x)
      const h = Math.abs(rectEnd.y - rectStart.y)
      if (w > 5 && h > 5) {
        const label = `Room ${walls.length + 1}`
        setWalls((prev) => [
          ...prev,
          {
            id: nextId++,
            points: [
              { x, y },
              { x: x + w, y },
              { x: x + w, y: y + h },
              { x, y: y + h },
            ],
            label,
            closed: true,
          },
        ])
      }
      setRectStart(null)
      setRectEnd(null)
    }

    setDrag(null)
    setRotateDrag(false)
  }

  function handleWheel(e) {
    e.preventDefault()
    const dx = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : 0
    const dy = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : 0
    setPan((prev) => ({ x: prev.x - dx * 0.4 * zoom, y: prev.y - dy * 0.4 * zoom }))
  }

  function finishWall() {
    if (currentWall && currentWall.points.length >= 2) {
      setWalls((prev) => [...prev, { ...currentWall, closed: false }])
      setCurrentWall(null)
    }
  }

  function cancelWall() {
    setCurrentWall(null)
  }

  function exportImage() {
    const canvas = canvasRef.current
    const link = document.createElement('a')
    link.download = 'floorplan.png'
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  function printPlan() {
    window.print()
  }

  function deleteSelected() {
    if (selectedCamera) {
      setCameras((prev) => prev.filter((c) => c.id !== selectedCamera.id))
      setSelectedCamera(null)
    } else if (selectedObject) {
      setObjects((prev) => prev.filter((o) => o.id !== selectedObject.id))
      setSelectedObject(null)
    }
  }

  function deleteSelectedRoom() {
    if (selectedRoom === null) return
    setWalls((prev) => prev.filter((_, i) => i !== selectedRoom))
    setSelectedRoom(null)
  }

  function resetView() {
    setPan({ x: size.width / 2, y: size.height / 2 })
    setZoom(1)
    setOrigin({ x: 0, y: 0 })
  }

  function zoomIn() {
    setZoom((prev) => {
      const newZoom = Math.min(5, prev * 1.2)
      const cx = size.width / 2
      const cy = size.height / 2
      setPan((p) => ({
        x: cx - (cx - p.x) * (newZoom / prev),
        y: cy - (cy - p.y) * (newZoom / prev),
      }))
      return newZoom
    })
  }

  function zoomOut() {
    setZoom((prev) => {
      const newZoom = Math.max(0.1, prev / 1.2)
      const cx = size.width / 2
      const cy = size.height / 2
      setPan((p) => ({
        x: cx - (cx - p.x) * (newZoom / prev),
        y: cy - (cy - p.y) * (newZoom / prev),
      }))
      return newZoom
    })
  }

  useEffect(() => {
    resetView()
  }, [])

  return (
    <div className="app">
      <div className="toolbar">
        <div className="tools">
          <button className={mode === 'wall' ? 'active' : ''} onClick={() => { setMode('wall'); setSelectedCamera(null); setSelectedRoom(null); setPlacingObject(null); setWindowDrag(null); setShowObjectPanel(false) }}>
            Wall
          </button>
          <button className={mode === 'rectangle' ? 'active' : ''} onClick={() => { setMode('rectangle'); setSelectedCamera(null); setSelectedRoom(null); setCurrentWall(null); setPlacingObject(null); setWindowDrag(null); setShowObjectPanel(false) }}>
            Rectangle
          </button>
          <button className={mode === 'camera' ? 'active' : ''} onClick={() => { setMode('camera'); setSelectedCamera(null); setSelectedRoom(null); setPlacingObject(null); setWindowDrag(null); setShowObjectPanel(false) }}>
            Camera
          </button>
          <button className={mode === 'object' ? 'active' : ''} onClick={() => { setMode('object'); setSelectedCamera(null); setSelectedRoom(null); setPlacingObject(null); setWindowDrag(null); setShowObjectPanel((prev) => !prev) }}>
            Objects
          </button>
          <button className={mode === 'select' ? 'active' : ''} onClick={() => { setMode('select'); setCurrentWall(null); setRectStart(null); setRectEnd(null); setPlacingObject(null); setWindowDrag(null); setShowObjectPanel(false) }}>
            Select
          </button>
        </div>
        <div className="controls">
          {mode === 'wall' && (
            <>
              <span className="hint">Click to add wall points</span>
              <button onClick={finishWall}>Finish Wall</button>
              <button onClick={cancelWall}>Cancel</button>
            </>
          )}
          {mode === 'rectangle' && (
            <>
              <span className="hint">Click and drag to draw a room</span>
              <button onClick={() => { setRectStart(null); setRectEnd(null) }}>Cancel</button>
            </>
          )}
          {mode === 'camera' && (
            <>
              <label>
                Preset:
                <select value={selectedPreset.id} onChange={(e) => setSelectedPreset(PRESETS.find((p) => p.id === e.target.value))}>
                  {PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          {mode === 'object' && showObjectPanel && (
            <div className="object-panel">
              {OBJECT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  className={`object-preset ${activeObjectPreset.id === preset.id ? 'active' : ''}`}
                  onClick={() => setActiveObjectPreset(preset)}
                >
                  <span className="object-swatch" style={{ backgroundColor: preset.color }}></span>
                  <span className="object-label">{preset.label}</span>
                </button>
              ))}
            </div>
          )}
          {mode === 'select' && selectedCamera && (
            <>
              <button onClick={deleteSelected}>Delete Camera</button>
            </>
          )}
          {mode === 'select' && selectedObject && (
            <>
              <button onClick={deleteSelected}>Delete Object</button>
            </>
          )}
          {mode === 'select' && selectedRoom !== null && (
            <>
              <button onClick={deleteSelectedRoom}>Delete Room</button>
            </>
          )}
          <button onClick={exportImage}>Export PNG</button>
          <button onClick={printPlan}>Print</button>
          <button onClick={resetView}>Reset View</button>
        </div>
      </div>
      <div className="canvas-wrap" ref={containerRef}>
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
        />
        <div className="zoom-controls">
          <button onClick={zoomIn}>+</button>
          <button onClick={zoomOut}>-</button>
        </div>
      </div>
    </div>
  )
}

export default App