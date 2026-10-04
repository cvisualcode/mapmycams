// ─── Resolution- and height-aware coverage ───────────────────────────────────
// "A camera sees it" is not the same as "the camera can make anything out". A
// sensor spreads its pixels over a wider scene the further away it is, so the
// same camera can spot movement at the end of a hall and read nobody's face at
// the front door. This module answers where the plan meets a chosen goal
// (Detect 25 px/m, Recognize 100 px/m, Identify 250 px/m), and keeps the
// genuinely blind area separate from the area that is visible but too grainy.
//
// Heights count too: a camera looking down from 2.5 m over a 0.45 m safe sees
// the far side of it, while a 2.2 m wardrobe blocks the sight line completely.
// See lineOfSightBlocked's options for the shared rule.
//
// Pure functions of the plan — no React, no DOM — like plan-drawing.js.

import {
  PIXELS_PER_METER, DETECTION_LEVELS, cameraSeesPoint, lineOfSightBlocked,
  isPointInPolygon, polygonArea, DEFAULT_CAMERA_HEIGHT_M, DEFAULT_TARGET_HEIGHT_M,
} from './plan-drawing.js'

export { DEFAULT_CAMERA_HEIGHT_M, DEFAULT_TARGET_HEIGHT_M }

/** What a camera without a stored resolution is assumed to be. Shown in the UI. */
export const DEFAULT_RESOLUTION_PIXELS = 1920

/** Pixel density a camera delivers at a distance, in px per metre of scene. */
export function pixelsPerMetreAt(cam, distanceMetres) {
  const pixels = Number(cam?.resolutionPixels) || DEFAULT_RESOLUTION_PIXELS
  const fov = (Number(cam?.hFov) || 90) * Math.PI / 180
  const metres = Number(distanceMetres)
  if (!(metres > 0)) return 0
  return pixels / (2 * metres * Math.tan(fov / 2))
}

/** The best tier this pixel density reaches, or null when even Detect fails. */
export function tierForDensity(pxPerM) {
  let reached = null
  for (const level of DETECTION_LEVELS) if (pxPerM >= level.pxPerM) reached = level
  return reached
}

/** 'blind' | 'below' | 'detect' | 'recognize' | 'identify' — worst to best. */
export function qualityAtPoint(cam, point, walls, objects, options = {}) {
  const targetHeightM = options.targetHeightM ?? DEFAULT_TARGET_HEIGHT_M
  const cameraHeightM = Number(cam?.mountingHeightM) || DEFAULT_CAMERA_HEIGHT_M
  const metres = Math.hypot(point.x - cam.x, point.y - cam.y) / PIXELS_PER_METER
  if (!cameraSeesPoint(cam, point)) return 'blind'
  if (lineOfSightBlocked(cam.x, cam.y, point.x, point.y, walls, objects, {
    cameraHeightM, targetHeightM,
  })) return 'blind'
  const tier = tierForDensity(pixelsPerMetreAt(cam, metres))
  return tier ? tier.id : 'below'
}

const ORDER = ['blind', 'below', 'detect', 'recognize', 'identify']

/** The best of several verdicts: whichever camera sees it best wins. */
export function bestQuality(verdicts) {
  return verdicts.reduce((best, v) => (ORDER.indexOf(v) > ORDER.indexOf(best) ? v : best), 'blind')
}

/**
 * Sample every closed room and report, per room and in total, where the plan
 * meets the goal. Blind area and visible-but-insufficient area are counted
 * separately: an amber cell is not a claim that no camera sees it.
 */
export function computeCoverageQuality(walls, cameras, objects, options = {}) {
  const goal = options.goal || DETECTION_LEVELS[0]
  const goalIndex = Math.max(0, DETECTION_LEVELS.findIndex((l) => l.id === goal.id))
  const closed = (walls || []).filter((w) => w && w.closed !== false && Array.isArray(w.points) && w.points.length >= 3)
  const cellMetres = options.cellMetres ?? 0.5
  const cell = cellMetres * PIXELS_PER_METER
  const cellArea = cellMetres * cellMetres
  const rooms = []
  let blindCells = 0, belowCells = 0, metCells = 0
  for (const wall of closed) {
    const xs = wall.points.map((p) => p.x), ys = wall.points.map((p) => p.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
    const cells = []
    for (let x = minX + cell / 2; x < maxX; x += cell) {
      for (let y = minY + cell / 2; y < maxY; y += cell) {
        if (!isPointInPolygon(x, y, wall.points)) continue
        const verdict = bestQuality((cameras || []).map((cam) => qualityAtPoint(cam, { x, y }, walls, objects, options)))
        // "Meets" is relative to the chosen goal: a cell that only reaches Detect is
        // a shortfall on an Identify goal, and both are visible — not blind.
        const tierIndex = DETECTION_LEVELS.findIndex((l) => l.id === verdict)
        const quality = verdict === 'blind' ? 'blind' : tierIndex >= goalIndex ? 'met' : 'below'
        cells.push({ x, y, quality, verdict })
      }
    }
    const blind = cells.filter((c) => c.quality === 'blind').length
    const below = cells.filter((c) => c.quality === 'below').length
    const met = cells.filter((c) => c.quality === 'met').length
    blindCells += blind; belowCells += below; metCells += met
    const area = polygonArea(wall.points) / (PIXELS_PER_METER * PIXELS_PER_METER)
    rooms.push({
      wall, label: wall.label, cells, cell,
      blindArea: blind * cellArea, belowArea: below * cellArea, metArea: met * cellArea,
      area,
    })
  }
  rooms.sort((a, b) => (b.blindArea + b.belowArea) - (a.blindArea + a.belowArea))
  return {
    goal: goal.id, goalIndex, cellMetres,
    blindArea: blindCells * cellArea,
    belowArea: belowCells * cellArea,
    metArea: metCells * cellArea,
    rooms,
    usedDefaultResolution: (cameras || []).some((c) => !Number(c?.resolutionPixels)),
  }
}

/** "72% meets Identify · 18% visible but too grainy · 10% blind" for toolbars. */
export function describeCoverageQuality(result) {
  const total = result.blindArea + result.belowArea + result.metArea
  if (!total) return ''
  const pct = (n) => `${Math.round((n / total) * 100)}%`
  return `${pct(result.metArea)} meets ${result.goal} · ${pct(result.belowArea)} visible but too grainy · ${pct(result.blindArea)} blind`
}
