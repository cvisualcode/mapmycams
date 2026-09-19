// ─── Floorplan editor ────────────────────────────────────────────────────────
// The interactive planner: all of the React state, the mouse handling and the
// panels around the canvas. Geometry, drawing, hit-testing and the security score
// are pure functions of the plan and live in src/editor/plan-drawing.js.

import { useState, useRef, useEffect } from 'react'
import { useEntitlements } from './monetisation/EntitlementsContext'
import { planShareUrl } from './monetisation/share'
import * as api from './monetisation/api'
import { planCameraPlacement } from './editor/coverage-plan'
import { MAX_ROOM_NAME, ensureRoomLabels, normalizeRoomName, renameRoom, roomDisplayName } from './editor/room-names'
import { createHistory, deserializePlan, serializePlan } from './editor/history'
import {
  createGestureTracker, pointerDown, pointerMove, pointerUp, pointerCancel,
  beginPinch, pinchTransform, trackedPoints,
} from './editor/pointer-gestures'
import { duplicateCamera, duplicateObject } from './editor/duplicate'
import { findPlacedObjectAt } from './editor/pick'
import './App.css'
import {
  PIXELS_PER_METER,
  DOOR_WIDTH_METERS,
  PRESETS,
  OBJECT_PRESETS,
  FLOOR_NAMES,
  FLOOR_COLORS,
  RESOLUTIONS,
  DETECTION_LEVELS,
  CAMERA_CATALOG,
  endpointId,
  findSnapTarget,
  computePoweredCameraIds,
  cameraSvg,
  toCanvas,
  toWorld,
  drawFovShape,
  drawGhostFloor,
  drawRoomLabel,
  drawRectangle,
  drawGrid,
  drawScaleBar,
  distanceToSegment,
  projectPointOnSegment,
  isOnDoorHandle,
  findNearestWallSegment,
  drawWindowOnWallSegment,
  drawWall,
  computeBlindSpots,
  describeBlindSpots,
  drawBlindSpots,
  scoreWithAreaCoverage,
  clickHitsWallShape,
  drawObject,
  drawWire,
  convexHull,
  drawRoofBackdrop,
  drawRotationArc,
  isOnRotationHandle,
  aiSuggestSpots,
  computeHealthScore,
  scoreBand,
  openingSpan,
  shouldDisarmAfterPlacement,
  objectRotateHandlePoint,
  isOnObjectRotateHandle,
  angleAbout,
  rotationFromDrag,
} from './editor/plan-drawing'

// Ids for cameras, objects, walls and wires. Module scope so two items placed in
// the same tick can never share one, and seeded past whatever a loaded plan used.
let nextId = 1

// Safe accessor: the editor also runs standalone (outside the shell) where no
// EntitlementsProvider exists — hooks must not throw in that case.
function useEntitlementsSafe() {
  try { return useEntitlements() } catch { return null }
}

// How close a click has to land to a room's wall, in canvas pixels, to select that
// room. Loose enough that the line never needs hitting exactly; tight enough that an
// outlet or a safe standing against the wall still wins the click for itself.
const WALL_CLICK_PX = 9

function App({ onExit, showUpgrade, initialSnapshot }) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  // Open in Select. A tool is something you pick on purpose, and an armed tool is
  // what swallows the click that was meant for an item already on the plan.
  const [mode, setMode] = useState('select')
  const [selectedPreset, setSelectedPreset] = useState(PRESETS[0])
  // A saved floorplan or a shared #plan= link arrives as a prop and is read once,
  // on mount: the shell remounts the editor with a new `key` for each plan.
  const snap = initialSnapshot || null
  const [walls, setWalls] = useState(() => (snap && Array.isArray(snap.walls) ? snap.walls : []))
  const [cameras, setCameras] = useState(() => (snap && Array.isArray(snap.cameras) ? snap.cameras : []))
  const [currentWall, setCurrentWall] = useState(null)
  const [rectStart, setRectStart] = useState(null)
  const [rectEnd, setRectEnd] = useState(null)
  const [wires, setWires] = useState(() => (snap && Array.isArray(snap.wires) ? snap.wires : []))
  const [currentWire, setCurrentWire] = useState(null)
  const [wireSnap, setWireSnap] = useState(null)
  const [activeFloor, setActiveFloor] = useState(0)
  const floorsRef = useRef({})
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [origin, setOrigin] = useState({ x: 0, y: 0 })
  const [drag, setDrag] = useState(null)
  const [selectedCamera, setSelectedCamera] = useState(null)
  const [placingCamera, setPlacingCamera] = useState(null)
  const [rotateDrag, setRotateDrag] = useState(false)
  const [objects, setObjects] = useState(() => (snap && Array.isArray(snap.objects) ? snap.objects : []))
  const [placingObject, setPlacingObject] = useState(null)
  const [selectedObject, setSelectedObject] = useState(null)
  const [selectedRoom, setSelectedRoom] = useState(null)
  const [showObjectPanel, setShowObjectPanel] = useState(false)
  const [activeObjectPreset, setActiveObjectPreset] = useState(OBJECT_PRESETS[0])
  const [resizing, setResizing] = useState(null)
  const [hoveredPoint, setHoveredPoint] = useState(null)
  const [windowDrag, setWindowDrag] = useState(null)
  const [lastClick, setLastClick] = useState(null)
  const [showSidebar, setShowSidebar] = useState(true)
  const [sideTab, setSideTab] = useState('cameras')
  const [doorHinge, setDoorHinge] = useState('right')
  const [sideSelection, setSideSelection] = useState(null)
  const [specFov, setSpecFov] = useState(90)
  const [specResolution, setSpecResolution] = useState(RESOLUTIONS[1])
  const [specGoal, setSpecGoal] = useState(DETECTION_LEVELS[0])

  // ── Monetisation hooks (provided by AppShell's EntitlementsProvider) ──
  // Every paid capability the tool offers is gated on the entitlement that sells
  // it, so a plan that has not been bought is a plan that cannot be used.
  const ent = useEntitlementsSafe()
  const aiLocked = !!ent && !ent.can('ai')
  const scoreLocked = !!ent && !ent.can('healthScore')
  const shareLocked = !!ent && !ent.can('shareLinks')
  const pdfLocked = !!ent && !ent.can('pdfReport')
  const watermarked = !!ent && !ent.isPremium
  const camLimit = ent ? (ent.user && ent.user.isAdmin ? Infinity : ent.limits.cameras) : Infinity
  const camLimitReached = cameras.length >= camLimit
  const [aiBlindSpots, setAiBlindSpots] = useState([])
  // Which engine answered the last AI suggestion, and whether the server is still
  // working on it. The model runs on the server (POST /ai/suggest) with the plan
  // geometry; the local solver in plan-drawing.js is the fallback, so an offline
  // browser or an exhausted quota still gets a layout.
  const [aiSource, setAiSource] = useState(null) // 'model' | 'local'
  const [aiBusy, setAiBusy] = useState(false)
  // One sentence from the model about the layout it chose, shown on hover.
  const [aiNote, setAiNote] = useState('')

  /**
   * Place cameras where they cover the most.
   *
   * The AI is asked for positions as a *proposal* — it has read the plan, so its
   * candidates are worth having — but the placement itself is decided by the
   * coverage solver in src/editor/coverage-plan.js: sample the floor, weigh doors,
   * windows, stairs, safes and outlets far above bare floor, then repeatedly take the
   * position that covers the most still-uncovered weight and stop as soon as another
   * camera is not worth having. That is what keeps the camera count down and the
   * coverage up, which a model choosing coordinates by eye cannot promise.
   */
  async function aiPlaceWithModel() {
    if (aiLocked) {
      if (showUpgrade) showUpgrade('AI camera placement', 'Let AI analyse your floorplan geometry and place cameras at the optimal spots.', 'ai_pack')
      return
    }
    setAiBusy(true)
    let proposals = []
    let usedModel = false
    try {
      const res = await api.aiSuggestSpots({ walls, cameras, objects })
      if (res?.source === 'model' && Array.isArray(res.spots) && res.spots.length > 0) {
        proposals = res.spots
        usedModel = true
      }
    } catch { /* offline, not entitled or over quota — coverage still answers */ }
    setAiBusy(false)

    let result
    try {
      result = planCameraPlacement({ walls, objects, cameras, proposals })
    } catch {
      // The optimiser is pure geometry, so this should not happen; if it ever does,
      // the older heuristic still places something rather than leaving a dead button.
      aiPlaceCameras()
      return
    }

    setAiSource(usedModel ? 'model' : 'local')
    setAiNote(result.summary)
    if (result.cameras.length === 0) return
    setCameras((prev) => [...prev, ...result.cameras])
    setAiBlindSpots(computeBlindSpots(walls, [...cameras, ...result.cameras], objects))
  }
  // Short-lived confirmation from the toolbar (link copied, pop-up blocked…).
  const [toolNotice, setToolNotice] = useState(null)

  // Observable-range estimate: at distance D the camera sees a horizontal width of
  // 2·D·tan(FOV/2). Divide the sensor's horizontal pixels by that width to get the
  // pixel density (px/m) and solve for the distance that meets the chosen goal.
  const fovRad = (specFov * Math.PI) / 180
  const tanHalf = Math.tan(fovRad / 2)
  const specRange = tanHalf > 0 ? specResolution.px / (2 * tanHalf * specGoal.pxPerM) : 0
  const specWidth = 2 * specRange * tanHalf

  // The score walks the whole plan, so it is only worked out while its tab is
  // open. It is shown out of the points actually on offer rather than a fixed 100,
  // so a floor that passes every check reads as a full house.
  // The object currently in your hand, if there is one. Tapping the same one in the
  // sidebar again puts it down, so a tap on the plan goes back to selecting what is
  // already on it rather than placing another.
  const loadedObjectId = sideSelection && sideSelection.type === 'object' ? sideSelection.id : null
  const loadedCameraId = sideSelection && sideSelection.type === 'camera' ? sideSelection.id : null

  // The coverage line is re-scored by area, from the sampler's own numbers, so the
  // score panel, the red patches and the toolbar summary cannot disagree.
  const health = showSidebar && sideTab === 'score' ? scoreWithAreaCoverage(computeHealthScore(walls, cameras, objects, wires), walls) : null
  const healthMax = health ? health.checks.reduce((sum, check) => sum + check.max, 0) : 0
  const healthBand = health ? scoreBand(healthMax > 0 ? Math.round((health.score / healthMax) * 100) : 0) : null

  // The hinge switch beside the Door preset reads the selected door when there is
  // one, so it always shows what a click is about to change.
  const selectedDoor = selectedObject && selectedObject.presetId === 'door' ? selectedObject : null
  const hingeShown = selectedDoor ? selectedDoor.hingeSide || doorHinge : doorHinge

  // Keep the FOV slider in step with the camera currently selected on the plan
  useEffect(() => {
    if (selectedCamera) setSpecFov(Math.round(selectedCamera.hFov))
  }, [selectedCamera ? selectedCamera.id : null])

  function applySpecToSelected() {
    if (!selectedCamera) return
    const distance = Math.round(specRange * 10) / 10
    setCameras((prev) =>
      prev.map((c) => (c.id === selectedCamera.id ? { ...c, hFov: specFov, distance } : c)),
    )
    setSelectedCamera((prev) => (prev ? { ...prev, hFov: specFov, distance } : prev))
  }

  function placeCatalogCamera(presetId) {
    const preset = PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    // Tapping the camera already in your hand puts it down, the same way an object does.
    // With the camera tool armed every tap on the plan places another one, so this is how
    // you get back to moving the cameras you have already put down.
    if (loadedCameraId === presetId) {
      armSelect()
      setToolNotice(`${preset.label} put down — tap a camera on the plan to move it.`)
      return
    }
    setSelectedPreset(preset)
    setMode('camera')
    setSideSelection({ type: 'camera', id: presetId })
    setToolNotice(`${preset.label} in your hand — tap the plan to place it, or tap it again to put it down.`)
  }

  function placeCatalogObject(preset) {
    if (!preset) return
    // Tapping the object already in your hand puts it down. That is the way back to
    // selecting: with a tool armed every tap on the plan is a placement.
    if (loadedObjectId === preset.id) {
      armSelect()
      setToolNotice(`${preset.label} put down — tap something on the plan to select it.`)
      return
    }
    setActiveObjectPreset(preset)
    setMode('object')
    setShowObjectPanel(true)
    setSelectedCamera(null)
    setSelectedRoom(null)
    setPlacingObject(null)
    setWindowDrag(null)
    setSideSelection({ type: 'object', id: preset.id })
    setToolNotice(preset.singleShot
      ? `${preset.label}: tap the plan to place one. It is left selected so you can turn it, then tap the tool again for another.`
      : `${preset.label} in your hand — tap the plan to place it, or tap ${preset.label} again to put it down.`)
  }

  /**
   * Put the editor back into plain Select mode and drop whatever was armed. Every
   * sidebar tab calls this: the tool chosen a moment ago means "place another
   * one", which is exactly what stops a click on something already on the plan
   * from selecting it.
   */
  function armSelect() {
    setSideSelection(null)
    setPlacingCamera(null)
    setPlacingObject(null)
    setWindowDrag(null)
    setShowObjectPanel(false)
    setRectStart(null)
    setRectEnd(null)
    setMode('select')
  }

  /** Load a drawing tool from the sidebar (wall, rectangle or wire). */
  function activateTool(tool) {
    if (tool === 'select') { armSelect(); return }
    setSideSelection(null)
    setPlacingCamera(null)
    setPlacingObject(null)
    setWindowDrag(null)
    setShowObjectPanel(false)
    setCurrentWall(null)
    setRectStart(null)
    setRectEnd(null)
    setMode(tool)
  }

  /**
   * Choose the hinge side. It sets the next door to be placed, and — when a door
   * is already selected — swings that one too, so the switch beside the Door preset
   * is the only hinge control the editor needs.
   */
  function applyDoorHinge(side) {
    setDoorHinge(side)
    if (!selectedDoor) return
    setObjects((prev) => prev.map((o) => (o.id === selectedDoor.id ? { ...o, hingeSide: side } : o)))
    setSelectedObject({ ...selectedDoor, hingeSide: side })
  }

  /**
   * Name the room that is selected. The name lives on the wall as `label`, which is what
   * the canvas label, the blind-spot list and the PDF report all print — so naming a room
   * once improves all three. A blank name goes back to its position rather than leaving
   * the room nameless. Defined here rather than beside the other deletes so it sits with
   * the rest of the room logic; function declarations hoist, so the toolbar can call it.
   */
  function renameSelectedRoom(name) {
    if (selectedRoom === null) return
    setWalls((prev) => renameRoom(prev, selectedRoom, name))
  }

  // ── Undo / redo ──
  // The plan is observed rather than hooked: the mutations are spread across the whole
  // editor, so every time the plan settles it is serialized and offered to the timeline
  // in src/editor/history.js, which keeps it unless it is identical to what it holds.
  // Waiting for it to settle is what makes a drag one undo step instead of fifty — and
  // stepping back commits whatever is still inside that window first, so an undo pressed
  // straight after an edit still finds it.
  const historyRef = useRef(null)
  if (!historyRef.current) historyRef.current = createHistory()
  const historyTimerRef = useRef(null)
  const latestPlanRef = useRef(null)
  const [historyFlags, setHistoryFlags] = useState({ canUndo: false, canRedo: false })

  /** Every floor, as one string. What an undo step actually restores. */
  function planSnapshotNow() {
    return serializePlan({ floors: planFloors(), activeFloor })
  }

  function setHistoryFlagsFor(canUndo, canRedo) {
    setHistoryFlags((prev) => (prev.canUndo === canUndo && prev.canRedo === canRedo ? prev : { canUndo, canRedo }))
  }

  /** Store the plan as it stands, cancelling any pending settle first. */
  function commitHistory() {
    if (historyTimerRef.current) {
      clearTimeout(historyTimerRef.current)
      historyTimerRef.current = null
    }
    if (historyRef.current.record(planSnapshotNow())) {
      setHistoryFlagsFor(historyRef.current.canUndo(), historyRef.current.canRedo())
    }
  }

  /** Put a snapshot back on screen. Nothing half-finished survives a restore. */
  function applyPlan(plan) {
    setDrag(null)
    setRotateDrag(false)
    setResizing(null)
    setPlacingCamera(null)
    setPlacingObject(null)
    setWindowDrag(null)
    setCurrentWall(null)
    setCurrentWire(null)
    setWireSnap(null)
    setRectStart(null)
    setRectEnd(null)
    setHoveredPoint(null)
    setShowObjectPanel(false)
    setSelectedCamera(null)
    setSelectedObject(null)
    setSelectedRoom(null)
    // The floors that are not on screen come from the snapshot too, so undoing after a
    // floor switch puts every floor back rather than only the one you can see.
    floorsRef.current = {}
    plan.floors.forEach((floor, i) => {
      if (i === plan.activeFloor) return
      floorsRef.current[i] = { walls: floor.walls, cameras: floor.cameras, objects: floor.objects, wires: floor.wires }
    })
    const active = plan.floors[plan.activeFloor] || { walls: [], cameras: [], objects: [], wires: [] }
    setActiveFloor(plan.activeFloor)
    setWalls(active.walls)
    setCameras(active.cameras)
    setObjects(active.objects)
    setWires(active.wires)
  }

  function undoPlan() {
    commitHistory()
    const previous = historyRef.current.undo()
    if (previous) applyPlan(deserializePlan(previous))
    setHistoryFlagsFor(historyRef.current.canUndo(), historyRef.current.canRedo())
  }

  function redoPlan() {
    // Storing the plan first is also what ends the redo trail if an edit happened after
    // the undo: you cannot redo into a plan that has since moved somewhere else.
    commitHistory()
    const next = historyRef.current.redo()
    if (next) applyPlan(deserializePlan(next))
    setHistoryFlagsFor(historyRef.current.canUndo(), historyRef.current.canRedo())
  }

  // ── Touch and pen ──
  // The canvas used to listen for mouse events only, so on a tablet nothing could be
  // drawn at all — a finger dragged the page around instead. Pointer events cover a
  // finger, a stylus and a mouse with one set of handlers, which is why they *replace*
  // the mouse ones rather than sitting beside them (a tap would otherwise be handled
  // twice).
  //
  // A finger differs from a mouse in two ways the editor has to respect:
  //
  //  * A tap cannot become a click the instant it lands, because a second finger may be
  //    on its way and that is a pinch, not a placement. So the press waits for either a
  //    few pixels of travel or a lift, and a second finger throws it away.
  //  * Two fingers are a pinch: zoom about the point between them, and the same gesture
  //    pans the plan. Starting one abandons whatever the first finger was midway
  //    through — a half-drawn wall is safe to drop, which is why nothing is committed
  //    until a gesture ends.
  // What a press *means* is decided in src/editor/pointer-gestures.js, which is plain
  // functions and therefore testable; these handlers only carry the answer out.
  const touchRef = useRef(null)
  if (!touchRef.current) touchRef.current = createGestureTracker()
  // A finger's click has to reach the handlers from the render the press caused, so the
  // newest ones are kept here rather than being frozen in a closure from the last render.
  const latestHandlersRef = useRef({})
  useEffect(() => {
    latestHandlersRef.current.mouseDown = handleMouseDown
    latestHandlersRef.current.mouseMove = handleMouseMove
    latestHandlersRef.current.mouseUp = handleMouseUp
  })

  /** Drop everything a gesture was midway through, without committing any of it. */
  function abandonGesture() {
    setDrag(null)
    setRotateDrag(false)
    setResizing(null)
    setPlacingCamera(null)
    setPlacingObject(null)
    setWindowDrag(null)
    setCurrentWall(null)
    setCurrentWire(null)
    setWireSnap(null)
    setRectStart(null)
    setRectEnd(null)
    setHoveredPoint(null)
  }

  /** The mouse handlers read only these fields, so a plain object replays a press. */
  function asMouseEvent(event, point) {
    return {
      clientX: point.clientX,
      clientY: point.clientY,
      button: 0,
      buttons: 1,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      pointerType: event.pointerType,
      target: canvasRef.current,
      currentTarget: canvasRef.current,
      preventDefault() {},
      stopPropagation() {},
    }
  }

  /** The canvas box, so a finger's page position can be read as plan position. */
  function canvasRect() {
    return canvasRef.current ? canvasRef.current.getBoundingClientRect() : { left: 0, top: 0 }
  }

  /**
   * A press on something already on the plan selects it and lets the tool go, instead of
   * stacking another one on top of it.
   *
   * This is why a safe could feel impossible to pick up: with the object tool armed, every
   * press put another one down, so the thing under your finger was never the thing that
   * got selected. Windows and doors are deliberately left out — tapping near a wall is how
   * one of those is placed, and wanting two doors side by side is reasonable.
   *
   * Answers true when the press has been dealt with and must not reach the tool.
   */
  function selectPlacedObjectInstead(event, allowDrag) {
    if (mode !== 'object' || placingObject || windowDrag) return false
    const world = getMouseWorld(event)
    const hit = findPlacedObjectAt(world, objects, walls, zoom)
    if (!hit || hit.presetId === 'window' || hit.presetId === 'door') return false
    armSelect()
    setSelectedObject(hit)
    setSelectedRoom(null)
    setSelectedCamera(null)
    // The press that picks it up can also be the start of a drag, so the safe that was
    // impossible to grab is slid across the room in one gesture. Only where a release is
    // certain to follow: a tap replays no mouse-up, and a drag left open would carry on
    // following the pointer with nothing held down.
    const preset = OBJECT_PRESETS.find((p) => p.id === hit.presetId)
    if (allowDrag && !(preset && preset.resizable)) {
      setDrag({ type: 'moveObject', objectId: hit.id, startX: world.x, startY: world.y })
    }
    setToolNotice('Selected — drag it to move it, or use Rotate and Delete.')
    return true
  }

  /** The camera within the standard 12 px press radius of a canvas point, if any. */
  function cameraNearCanvas(c) {
    for (const cam of cameras) {
      const cp = toCanvas(cam.x, cam.y, origin, pan, zoom)
      if (Math.hypot(c.x - cp.x, c.y - cp.y) < 12) return cam
    }
    return null
  }

  /**
   * A press on the grip of the selected object starts turning it, to any angle.
   *
   * The 90° button is for squaring something to a wall; this is for lining a flight of
   * stairs up with a diagonal hall, which no number of right angles can do. Because the
   * grip is what is being grabbed, the press must not reach the editor — selecting,
   * moving or deselecting instead — so this runs before the press is delegated.
   *
   * Answers true when the press has been taken.
   */
  function startObjectTurn(event) {
    if (rotateDrag) return false
    // A right-click is not a press on the plan anywhere else either.
    if (event.pointerType === 'mouse' && event.button !== 0) return false
    const target = selectedObject
    if (!target || target.wallId != null) return false
    const c = getMouseCanvas(event)
    // A camera under the grip keeps the press: it is the smaller, harder target.
    if (cameraNearCanvas(c)) return false
    if (!isOnObjectRotateHandle(c.x, c.y, target, walls, origin, pan, zoom)) return false
    const world = getMouseWorld(event)
    setRotateDrag({
      type: 'rotateObject',
      objectId: target.id,
      centerX: target.x,
      centerY: target.y,
      startAngle: angleAbout(target, world),
      startRotation: target.rotation || 0,
    })
    setToolNotice('Turning — drag round to the angle you want, then let go. The Rotate button still steps a right angle.')
    return true
  }

  /**
   * The turn, driven from here rather than from the editor's own move handler.
   *
   * The handler that turns doors clamps them to 90° either way, which is right for a door
   * on a hinge and wrong for a stair, so this drag is deliberately kept away from it.
   */
  function applyObjectTurn(event) {
    if (!rotateDrag || rotateDrag.type !== 'rotateObject') return false
    const angleNow = angleAbout({ x: rotateDrag.centerX, y: rotateDrag.centerY }, getMouseWorld(event))
    const rotation = rotationFromDrag(rotateDrag.startRotation, rotateDrag.startAngle, angleNow)
    setObjects((prev) => prev.map((o) => (o.id === rotateDrag.objectId ? { ...o, rotation } : o)))
    setSelectedObject((prev) => (prev && prev.id === rotateDrag.objectId ? { ...prev, rotation } : prev))
    return true
  }

  /**
   * A press on a *turned* object selects it, which the editor's own upright rectangle test
   * cannot do.
   *
   * A stair is 1.1 m by 0.35 m; turned on its side it stands 0.35 m by 1.1 m on the plan,
   * and the old test went on looking for it lying down — so after turning one it could not
   * be selected, dragged or turned again, which is the same as not being turnable at all.
   * A camera within 12 px still wins, and an object lying at 0° or 180° is left to the
   * ordinary test, which is already right about it.
   */
  function selectTurnedObject(event) {
    if (mode !== 'select') return false
    if (event.pointerType === 'mouse' && event.button !== 0) return false
    const c = getMouseCanvas(event)
    if (cameraNearCanvas(c)) return false
    const world = getMouseWorld(event)
    const hit = findPlacedObjectAt(world, objects, walls, zoom, 0)
    if (!hit || hit.wallId != null) return false
    if (hit.presetId === 'window' || hit.presetId === 'door') return false
    if (((hit.rotation || 0) % 180) === 0) return false
    setSelectedObject(hit)
    setSelectedRoom(null)
    setSelectedCamera(null)
    setDrag({ type: 'moveObject', objectId: hit.id, startX: world.x, startY: world.y })
    return true
  }

  function handlePointerDown(event) {
    const outcome = pointerDown(touchRef.current, event)
    if (outcome.action === 'mouseDown') {
      if (startObjectTurn(event)) return
      if (selectTurnedObject(event)) return
      if (selectPlacedObjectInstead(event, true)) return
      latestHandlersRef.current.mouseDown(event)
      return
    }
    if (event.pointerType !== 'touch') return
    const canvas = canvasRef.current
    // Capture the finger, so a gesture that wanders off the canvas still ends here.
    if (canvas && canvas.setPointerCapture) {
      try { canvas.setPointerCapture(event.pointerId) } catch { /* not capturable yet */ }
    }
    if (outcome.action === 'pinchStart') {
      abandonGesture()
      beginPinch(touchRef.current, trackedPoints(touchRef.current, canvasRect()), zoom, pan)
    }
  }

  function handlePointerMove(event) {
    const outcome = pointerMove(touchRef.current, event)
    if (outcome.action === 'mouseMove') {
      if (applyObjectTurn(event)) return
      latestHandlersRef.current.mouseMove(event)
      return
    }
    if (outcome.action === 'pinch') {
      const transform = pinchTransform(touchRef.current, trackedPoints(touchRef.current, canvasRect()))
      if (transform) {
        setZoom(transform.zoom)
        setPan(transform.pan)
      }
      return
    }
    if (outcome.action === 'pressThenMove') {
      // A finger that has travelled is a drag, so picking up what is under it beats
      // putting another one down on top of it. The lift that follows clears the drag.
      // The press is tested where the finger *landed*, not where it has got to, or a grip
      // that has already been left behind would never be grabbed.
      const press = asMouseEvent(event, outcome.point)
      if (startObjectTurn(press)) return
      if (selectTurnedObject(press)) return
      if (selectPlacedObjectInstead(press, true)) return
      latestHandlersRef.current.mouseDown(press)
      latestHandlersRef.current.mouseMove(event)
    }
  }

  function handlePointerUp(event) {
    const outcome = pointerUp(touchRef.current, event)
    if (outcome.action === 'mouseUp') {
      latestHandlersRef.current.mouseUp()
      return
    }
    if (outcome.action === 'tap') {
      // A press and a release in one spot. The press is replayed now and the release on
      // the next tick, so the release runs against the render the press caused — which is
      // what actually places the camera instead of only arming it.
      // A tap only selects: no drag is started, because nothing here replays the release
      // that would end it.
      if (selectPlacedObjectInstead(asMouseEvent(event, outcome.point), false)) return
      latestHandlersRef.current.mouseDown(asMouseEvent(event, outcome.point))
      setTimeout(() => latestHandlersRef.current.mouseUp(), 0)
    }
  }

  function handlePointerCancel(event) {
    // A cancelled gesture is abandoned rather than committed: the browser taking the
    // touch away (a system gesture, a call) is not the user letting go.
    pointerCancel(touchRef.current, event)
    abandonGesture()
  }

  // ── Copying what is selected ──
  /** Copy the selected camera, or the selected item, and select the copy. */
  function duplicateSelection() {
    if (selectedCamera) {
      if (camLimitReached) {
        if (showUpgrade) showUpgrade('Camera limit reached', `Free tier supports up to ${camLimit} cameras. Upgrade to Premium for unlimited cameras.`, 'premium_monthly')
        return
      }
      const copy = { ...duplicateCamera(selectedCamera), id: nextId++, label: `Cam ${cameras.length + 1}` }
      setCameras((prev) => [...prev, copy])
      setSelectedCamera(copy)
      return
    }
    if (!selectedObject) return
    // A copied camera preset is capped by the same limit, so a door or a window is the
    // only thing that can be copied freely.
    const copy = { ...duplicateObject(selectedObject), id: nextId++ }
    setObjects((prev) => [...prev, copy])
    setSelectedObject(copy)
  }

  /**
   * Step the selected item with the arrow keys.
   *
   * A camera or a free-standing object moves by its own coordinates. A door or a window
   * has none — it is placed along the wall it sits on — so it slides up and down that
   * wall instead, which is what the arrow keys should do to it anyway.
   */
  function nudgeSelection(dx, dy) {
    if (selectedCamera) {
      setCameras((prev) => prev.map((c) => (c.id === selectedCamera.id ? { ...c, x: c.x + dx, y: c.y + dy } : c)))
      setSelectedCamera((prev) => (prev ? { ...prev, x: prev.x + dx, y: prev.y + dy } : prev))
      return true
    }
    if (!selectedObject) return false
    const obj = selectedObject
    if (obj.wallId == null) {
      setObjects((prev) => prev.map((o) => (o.id === obj.id ? { ...o, x: o.x + dx, y: o.y + dy } : o)))
      setSelectedObject((prev) => (prev ? { ...prev, x: prev.x + dx, y: prev.y + dy } : prev))
      return true
    }
    const wall = walls.find((w) => w.id === obj.wallId)
    if (!wall) return false
    const p1 = wall.points[obj.segmentIndex]
    const p2 = wall.points[(obj.segmentIndex + 1) % wall.points.length]
    const length = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    if (length < 1e-6) return false
    const along = (dx * (p2.x - p1.x) + dy * (p2.y - p1.y)) / (length * length)
    const span = obj.t2 - obj.t1
    let t1 = obj.t1 + along
    let t2 = obj.t2 + along
    if (t1 < 0) { t1 = 0; t2 = span }
    if (t2 > 1) { t2 = 1; t1 = 1 - span }
    setObjects((prev) => prev.map((o) => (o.id === obj.id ? { ...o, t1, t2 } : o)))
    setSelectedObject((prev) => (prev && prev.id === obj.id ? { ...prev, t1, t2 } : prev))
    return true
  }

  function deleteAnythingSelected() {
    if (selectedRoom !== null) {
      deleteSelectedRoom()
      return
    }
    deleteSelected()
  }

  // ── Keyboard ──
  // A plan is drawn with one hand on the mouse and the other on the keyboard: Delete,
  // Escape, the arrow keys, Ctrl+Z and the letter of each tool. Anything typed into a
  // field is left alone, so the room-name box is never read as a shortcut.
  useEffect(() => {
    function onKeyDown(event) {
      const target = event.target
      const typing = !!target && (
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' || target.isContentEditable
      )
      const mod = event.metaKey || event.ctrlKey

      // A field in front of the user keeps its own keys — Ctrl+Z inside the room-name
      // box undoes the typing, not the plan, which is what anyone would expect.
      if (typing) return

      if (mod && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault()
        if (event.shiftKey) redoPlan()
        else undoPlan()
        return
      }
      if (mod && (event.key === 'y' || event.key === 'Y')) {
        event.preventDefault()
        redoPlan()
        return
      }
      if (mod) {
        if (event.key === 'd' || event.key === 'D') {
          event.preventDefault()
          duplicateSelection()
        }
        return
      }

      const step = (event.shiftKey ? 0.5 : 0.1) * PIXELS_PER_METER
      const nudges = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
      if (nudges[event.key]) {
        if (nudgeSelection(nudges[event.key][0], nudges[event.key][1])) event.preventDefault()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedCamera || selectedObject || selectedRoom !== null) {
          event.preventDefault()
          deleteAnythingSelected()
        }
        return
      }
      if (event.key === 'Escape') {
        if (currentWall) { cancelWall(); return }
        if (currentWire) { cancelWire(); return }
        if (selectedCamera || selectedObject || selectedRoom !== null || placingCamera || placingObject) {
          setSelectedCamera(null)
          setSelectedObject(null)
          setSelectedRoom(null)
          abandonGesture()
          return
        }
        if (mode !== 'select') armSelect()
        return
      }

      const tools = { v: 'select', w: 'wall', r: 'rectangle', l: 'wire' }
      const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
      if (tools[key]) {
        setSideTab('tools')
        setShowSidebar(true)
        activateTool(tools[key])
        return
      }
      if (key === 'c') {
        setSideTab('cameras')
        setShowSidebar(true)
        placeCatalogCamera(selectedPreset.id)
        return
      }
      if (key === 'o') {
        setSideTab('objects')
        setShowSidebar(true)
        placeCatalogObject(activeObjectPreset)
      }
    }

    // Registered on every render on purpose: the handler closes over the current plan,
    // and a stale copy would nudge a camera that has since been deleted.
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const [size, setSize] = useState({ width: 800, height: 600 })
  const previousMode = useRef(mode)
  // Placing a stair hands straight over to Select with the stair still selected, and the
  // mode change that follows would otherwise wipe the selection it was handed — leaving a
  // stair nobody could turn, because the thing you turn is the thing that is selected.
  const keepSelectionOnModeChange = useRef(false)

  useEffect(() => {
    if (previousMode.current === 'wall' && mode !== 'wall' && currentWall) {
      if (currentWall.points.length >= 2) {
        // Keep the shape that was on screen while drawing: the preview closes the
        // loop, so the wall it becomes closes it too.
        setWalls((prev) => [...prev, { ...currentWall, closed: true }])
      }
      setCurrentWall(null)
    }
    previousMode.current = mode
    if (keepSelectionOnModeChange.current && mode === 'select') {
      keepSelectionOnModeChange.current = false
      setSelectedCamera(null)
      setRotateDrag(false)
      setDrag(null)
      return
    }
    setSelectedCamera(null)
    setSelectedObject(null)
    setRotateDrag(false)
    setDrag(null)
  }, [mode])

  useEffect(() => {
    if (!rotateDrag || !rotateDrag.objectId) return undefined

    const smoothDoorRotation = (event) => {
      const door = objects.find((obj) => obj.id === rotateDrag.objectId)
      if (!door) return

      const world = getMouseWorld(event)
      const currentAngle = Math.atan2(world.y - rotateDrag.centerY, world.x - rotateDrag.centerX)
      const delta = Math.atan2(
        Math.sin(currentAngle - rotateDrag.startAngle),
        Math.cos(currentAngle - rotateDrag.startAngle),
      )
      const proposedRotation = rotateDrag.startRotation + (delta * 180 / Math.PI)

      let baseAngle = rotateDrag.startRotation
      if (door.wallId != null) {
        const wall = walls.find((candidate) => candidate.id === door.wallId)
        if (wall) {
          const p1 = wall.points[door.segmentIndex]
          const p2 = wall.points[(door.segmentIndex + 1) % wall.points.length]
          baseAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI
        }
      }

      let relative = proposedRotation - baseAngle
      relative = ((relative + 180) % 360 + 360) % 360 - 180
      const clampedRelative = Math.max(-90, Math.min(90, relative))
      const targetRotation = ((baseAngle + clampedRelative) % 360 + 360) % 360
      const currentRotation = door.rotation || 0
      const shortestStep = ((targetRotation - currentRotation + 540) % 360) - 180
      const nextRotation = ((currentRotation + shortestStep * 0.45) % 360 + 360) % 360

      setObjects((prev) => prev.map((obj) => (
        obj.id === rotateDrag.objectId ? { ...obj, rotation: nextRotation } : obj
      )))
      setSelectedObject((prev) => (
        prev && prev.id === rotateDrag.objectId ? { ...prev, rotation: nextRotation } : prev
      ))
    }

    // Pointer events rather than mouse ones, so swinging a door works with a finger or a
    // stylus as well as a mouse. One listener covers all three.
    document.addEventListener('pointermove', smoothDoorRotation)
    return () => document.removeEventListener('pointermove', smoothDoorRotation)
  }, [rotateDrag, objects, walls, origin, pan, zoom])

  // Continue the id counter past anything the plan arrived with, so a new camera
  // can never collide with one from a saved or shared layout.
  useEffect(() => {
    resetView()
    const ids = [...walls, ...cameras, ...objects, ...wires]
      .map((item) => item.id)
      .filter((id) => typeof id === 'number')
    if (ids.length) nextId = Math.max(nextId, Math.max(...ids) + 1)
  }, [])

  // ── Cloud save / load bridge used by the dashboard shell ──
  useEffect(() => {
    window.__mmcGetSnapshot = () => ({ version: 1, walls, cameras, objects, wires })
    window.__mmcSetSnapshot = (snapshot) => {
      if (!snapshot) { setWalls([]); setCameras([]); setObjects([]); setWires([]); return }
      if (Array.isArray(snapshot.walls)) setWalls(snapshot.walls)
      if (Array.isArray(snapshot.cameras)) setCameras(snapshot.cameras)
      if (Array.isArray(snapshot.objects)) setObjects(snapshot.objects)
      if (Array.isArray(snapshot.wires)) setWires(snapshot.wires)
    }
  })

  // Whatever route a plan arrived by — drawn here, restored from the dashboard, or a
  // shared #plan= link — its rooms get a name that is present and unique before anything
  // prints one. Only a missing name, or an automatic name that clashes, is replaced, so
  // this never overwrites a name the user typed. Same array back means no re-render.
  useEffect(() => {
    setWalls((prev) => ensureRoomLabels(prev))
  }, [walls])

  // Offer the plan to the timeline on every change, and only store it once it settles.
  // The Undo button lights up immediately; the entry itself lands when the drag ends.
  useEffect(() => {
    const snapshot = planSnapshotNow()
    latestPlanRef.current = snapshot
    const history = historyRef.current
    if (history.current() === null) {
      // The plan the session opened with is the state undo goes back to.
      history.record(snapshot)
      setHistoryFlagsFor(history.canUndo(), history.canRedo())
      return undefined
    }
    setHistoryFlagsFor(history.canUndo() || history.current() !== snapshot, history.canRedo())
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current)
    historyTimerRef.current = setTimeout(() => {
      historyTimerRef.current = null
      if (history.record(latestPlanRef.current)) setHistoryFlagsFor(history.canUndo(), history.canRedo())
    }, 400)
    return () => {
      if (historyTimerRef.current) clearTimeout(historyTimerRef.current)
    }
  }, [walls, cameras, objects, wires, activeFloor])

  // Anything the toolbar has to say clears itself, so it cannot go stale.
  useEffect(() => {
    if (!toolNotice) return undefined
    const timer = setTimeout(() => setToolNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [toolNotice])

  // The plan is painted from the canvas's own pixel size, so the canvas has to hear about
  // that size changing: a tablet turned on its side, a phone's address bar sliding away, a
  // window being dragged. Without this the drawing keeps the size it was first painted at
  // and the browser stretches it — which is what makes a plan look wrong on a phone.
  const [viewportTick, setViewportTick] = useState(0)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    const bump = () => setViewportTick((tick) => tick + 1)
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(bump)
      observer.observe(container)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', bump)
    window.addEventListener('orientationchange', bump)
    return () => {
      window.removeEventListener('resize', bump)
      window.removeEventListener('orientationchange', bump)
    }
  }, [])

  // A tool that places one and then lets go. The object is committed in the pointer-up
  // handler, so the letting-go watches the plan rather than the click: the moment a flight
  // of stairs lands, the tool is put down and the stair is left selected to be turned.
  // Undo, a restored plan or the AI placing cameras leave the tool alone, because those do
  // not grow the plan while a stair tool is in your hand.
  const placedCountRef = useRef(0)
  useEffect(() => {
    const added = objects.length - placedCountRef.current
    placedCountRef.current = objects.length
    const last = objects[objects.length - 1]
    if (!shouldDisarmAfterPlacement({ added, mode, armedPresetId: activeObjectPreset.id, placedPresetId: last && last.presetId })) return
    keepSelectionOnModeChange.current = true
    armSelect()
    setSelectedObject(last)
    const preset = OBJECT_PRESETS.find((p) => p.id === last.presetId)
    setToolNotice(`${preset ? preset.label : 'Placed'} placed and selected — drag the blue grip to turn it, then tap the tool again for the next one.`)
  }, [objects, mode, activeObjectPreset])

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
    const isRoofFloor = activeFloor === FLOOR_NAMES.length - 1
    if (isRoofFloor) {
      // Combined footprint of every floor (including this roof floor) for lot + roof outline
      const allPts = []
      const floorInfo = FLOOR_NAMES.map((name, i) => {
        const f = i === activeFloor ? { walls } : floorsRef.current[i]
        if (f && f.walls) for (const wall of f.walls) for (const p of wall.points) allPts.push(p)
        return { name, hasWalls: !!(f && f.walls && f.walls.length) }
      })
      drawRoofBackdrop(ctx, allPts, floorInfo, origin, pan, zoom)
      // Ghost every floor below so you can align the roof layout
      for (let fi = 0; fi < activeFloor; fi++) {
        const f = floorsRef.current[fi]
        if (f && f.walls) drawGhostFloor(ctx, f.walls, origin, pan, zoom, FLOOR_COLORS[fi])
      }
    } else {
      drawGrid(ctx, w, h, pan, zoom)
      if (activeFloor > 0) {
        const below = floorsRef.current[activeFloor - 1]
        const belowWalls = below && below.walls && below.walls.length
          ? below.walls
          : (floorsRef.current[0] && floorsRef.current[0].walls ? floorsRef.current[0].walls : [])
        drawGhostFloor(ctx, belowWalls, origin, pan, zoom)
      }
    }
    // The plan's scale, on the canvas: nothing else tells you what a metre is here.
    drawScaleBar(ctx, w, h, zoom)

    walls.forEach((wall, i) => {
      drawWall(ctx, wall, origin, pan, zoom, objects)
      drawRoomLabel(ctx, wall, origin, pan, zoom, roomDisplayName(wall, i))
    })
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

    for (const w of wires) {
      drawWire(ctx, w, origin, pan, zoom)
    }
    if (currentWire && currentWire.points.length >= 1) {
      const lastPt = currentWire.points[currentWire.points.length - 1]
      const hover = currentWire.hoverSnap
      if (hover) {
        const a = toCanvas(lastPt.x, lastPt.y, origin, pan, zoom)
        const b = toCanvas(hover.x, hover.y, origin, pan, zoom)
        ctx.save()
        ctx.strokeStyle = '#f97316'
        ctx.lineWidth = 2
        ctx.setLineDash([6, 4])
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
        ctx.restore()
      }
      drawWire(ctx, currentWire, origin, pan, zoom)
    }
    const poweredCameraIds = computePoweredCameraIds(cameras, objects, wires)
    let ghostWalls = []
    let ghostHull = null
    if (activeFloor === FLOOR_NAMES.length - 1) {
      for (let fi = 0; fi < activeFloor; fi++) {
        const f = floorsRef.current[fi]
        if (f && f.walls) ghostWalls = ghostWalls.concat(f.walls)
      }
      const allPts = []
      for (const w of ghostWalls) for (const p of w.points) allPts.push(p)
      ghostHull = convexHull(allPts)
    }
    // Areas the cameras miss, painted under the cones and the camera markers, so what
    // the report claims and what the plan shows are the same thing seen twice.
    if (aiBlindSpots.length > 0) drawBlindSpots(ctx, aiBlindSpots, origin, pan, zoom)
    for (const cam of cameras) {
      const cp = toCanvas(cam.x, cam.y, origin, pan, zoom)
      drawFovShape(ctx, cam, origin, pan, zoom, walls, objects, currentWall ? [currentWall] : [], activeFloor === FLOOR_NAMES.length - 1, ghostWalls, ghostHull)
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
      if (poweredCameraIds.has(cam.id)) {
        ctx.beginPath()
        ctx.arc(cp.x, cp.y, 12 * zoom, 0, Math.PI * 2)
        ctx.strokeStyle = '#22c55e'
        ctx.lineWidth = 2.5
        ctx.setLineDash([3, 3])
        ctx.stroke()
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.arc(cp.x + 11 * zoom, cp.y - 11 * zoom, 6 * zoom, 0, Math.PI * 2)
        ctx.fillStyle = '#22c55e'
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 9px system-ui'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('\u26A1', cp.x + 11 * zoom, cp.y - 11 * zoom)
      }
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
        const hingeT = selectedObject.hingeSide === 'left' ? selectedObject.t1 : selectedObject.t2
        const hxWorld = p1.x + (p2.x - p1.x) * hingeT
        const hyWorld = p1.y + (p2.y - p1.y) * hingeT
        const hinge = toCanvas(hxWorld, hyWorld, origin, pan, zoom)
        const rot = (selectedObject.rotation * Math.PI) / 180
        const wpx = (selectedObject.width || OBJECT_PRESETS.find((p) => p.id === 'door').width) * PIXELS_PER_METER * zoom
        const radius = wpx / 2

        ctx.beginPath()
        ctx.setLineDash([4 * zoom, 4 * zoom])
        ctx.strokeStyle = '#3b82f6'
        ctx.lineWidth = 2
        // arc centered on hinge so swing visually matches pivot
        const hingeDirection = selectedObject.hingeSide === 'left' ? -1 : 1
        ctx.arc(
          hinge.x,
          hinge.y,
          radius,
          rot + hingeDirection * Math.PI / 2,
          rot - hingeDirection * Math.PI / 2,
        )
        ctx.stroke()
        ctx.setLineDash([])

        const handleAngle = rot + hingeDirection * Math.PI / 2
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
        const span = preset ? openingSpan(obj, walls) : null
        // Every object gets marked, not just the ones that can be resized. The old test
        // here was `preset.resizable`, and the only resizable preset is the window, which
        // it then excluded — so selecting a safe, a socket or a stair changed nothing on
        // screen, and the tap looked like it had been ignored.
        ctx.strokeStyle = '#3b82f6'
        ctx.lineWidth = 2
        ctx.setLineDash([4, 4])
        if (span && obj.presetId !== 'door') {
          // A window marks the opening it sits in, along its wall.
          const a = toCanvas(span.a.x, span.a.y, origin, pan, zoom)
          const b = toCanvas(span.b.x, span.b.y, origin, pan, zoom)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.lineWidth = 4
          ctx.stroke()
        } else if (preset && obj.x != null) {
          const cp = toCanvas(obj.x, obj.y, origin, pan, zoom)
          // Never smaller than 14 px on screen, so a socket is as clearly selected as a
          // room is, whatever the zoom.
          const w = Math.max((obj.width || preset.width) * PIXELS_PER_METER * zoom, 14)
          const h = Math.max((obj.height || preset.height) * PIXELS_PER_METER * zoom, 14)
          // Turned with the object, so a stair lying on its side is marked where it is
          // drawn rather than where it used to lie.
          ctx.save()
          ctx.translate(cp.x, cp.y)
          ctx.rotate(((obj.rotation || 0) * Math.PI) / 180)
          ctx.strokeRect(-w / 2, -h / 2, w, h)
          ctx.restore()
        }
        ctx.setLineDash([])
        // The grip that turns it, on its stem, so a turned object shows where to grab it.
        const grip = objectRotateHandlePoint(obj, walls, origin, pan, zoom)
        if (grip) {
          ctx.setLineDash([3, 3])
          ctx.strokeStyle = '#3b82f6'
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.moveTo(grip.centre.x, grip.centre.y)
          ctx.lineTo(grip.x, grip.y)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.beginPath()
          ctx.arc(grip.x, grip.y, 7, 0, Math.PI * 2)
          ctx.fillStyle = '#3b82f6'
          ctx.fill()
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 2
          ctx.stroke()
        }
        // Door selection visuals are drawn separately above when `selectedObject` is a door
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
          const hingeT = obj.hingeSide === 'left' ? obj.t1 : obj.t2
          hxWorld = p1.x + (p2.x - p1.x) * hingeT
          hyWorld = p1.y + (p2.y - p1.y) * hingeT
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
      drawRectangle(
        ctx,
        p1.x,
        p1.y,
        p2.x,
        p2.y,
        zoom,
        Math.abs(rectEnd.x - rectStart.x) / PIXELS_PER_METER,
        Math.abs(rectEnd.y - rectStart.y) / PIXELS_PER_METER,
      )
    }

    if (currentWall) {
      const last = currentWall.points[currentWall.points.length - 1]
      const lastC = toCanvas(last.x, last.y, origin, pan, zoom)
      ctx.beginPath()
      ctx.arc(lastC.x, lastC.y, 4, 0, Math.PI * 2)
      ctx.fillStyle = '#ef4444'
      ctx.fill()
    }

    if (mode === 'wire' && wireSnap && currentWire) {
      const cp = toCanvas(wireSnap.x, wireSnap.y, origin, pan, zoom)
      ctx.beginPath()
      ctx.arc(cp.x, cp.y, 10, 0, Math.PI * 2)
      ctx.strokeStyle = wireSnap.kind === 'power' ? '#84cc16' : '#22c55e'
      ctx.lineWidth = 2
      ctx.setLineDash([3, 3])
      ctx.stroke()
      ctx.setLineDash([])
    }
  }, [walls, currentWall, cameras, pan, zoom, origin, mode, size, placingCamera, selectedCamera, rectStart, rectEnd, objects, placingObject, selectedRoom, hoveredPoint, activeObjectPreset, selectedObject, windowDrag, wires, wireSnap, currentWire, activeFloor, viewportTick])
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

  function snapToBelowWorld(world) {
    if (activeFloor <= 0) return world
    let belowWalls = []
    const below = floorsRef.current[activeFloor - 1]
    if (below && below.walls && below.walls.length) belowWalls = below.walls
    else if (floorsRef.current[0] && floorsRef.current[0].walls) belowWalls = floorsRef.current[0].walls
    if (!belowWalls.length) return world
    const hit = findNearestWallSegment(world, belowWalls, origin, pan, zoom, 14)
    if (!hit) return world
    const wall = belowWalls.find((w) => w.id === hit.wallId)
    if (!wall) return world
    const p1 = wall.points[hit.segmentIndex]
    const p2 = wall.points[(hit.segmentIndex + 1) % wall.points.length]
    return { x: p1.x + (p2.x - p1.x) * hit.t, y: p1.y + (p2.y - p1.y) * hit.t }
  }

  /**
   * "Did this click pick this wall shape?"
   *
   * This is the test the click handler calls when it is about to select a room, and it
   * means *the wall*, not the floor: the click has to land within WALL_CLICK_PX of one
   * of the shape's lines. The name is the click handler's; the geometry and the slack
   * live in clickHitsWallShape, beside the rest of the wall maths and its tests.
   *
   * Picking a room by its floor is what made everything standing in a room
   * unselectable — any click inside it grabbed the whole room first.
   */
  function isPointInPolygon(x, y, polygon) {
    return clickHitsWallShape({ x, y }, polygon, origin, pan, zoom, WALL_CLICK_PX)
  }

  return (
    <div className="app">
      <div className="toolbar">
        <div className="tools">
          <button className={mode === 'select' ? 'active' : ''} onClick={armSelect} title="Select, move and rotate what is already on the plan (V)">
            Select
          </button>
          <button onClick={undoPlan} disabled={!historyFlags.canUndo} title="Undo the last change (Ctrl+Z)">↶ Undo</button>
          <button onClick={redoPlan} disabled={!historyFlags.canRedo} title="Redo the change you just undid (Ctrl+Shift+Z)">↷ Redo</button>
        </div>
        <div className="controls">
          <div className="floor-switch">
            {FLOOR_NAMES.map((name, i) => (
              <button key={name} className={activeFloor === i ? 'active' : ''} onClick={() => switchFloor(i)} title="Switch floor layout">{name}</button>
            ))}
          </div>
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
          {mode === 'wire' && (
            <>
              <span className="hint">Click to route wire. Click a camera or outlet to snap.</span>
              <button onClick={finishWire} disabled={!currentWire || currentWire.points.length < 2}>Finish Wire</button>
              <button onClick={cancelWire}>Cancel</button>
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
          {mode === 'select' && !selectedCamera && !selectedObject && selectedRoom === null && (
            <span className="hint">Tap a camera or an object to select it — tap a wall to select its room</span>
          )}
          {/* Whatever is selected offers its own controls, in every mode: a door can be
              picked up while the Objects tool is still armed, and it should still be
              movable, rotatable and deletable from here. */}
          {selectedCamera && (
            <>
              <button onClick={duplicateSelection} title="Place another camera like this one (Ctrl+D)">Copy camera</button>
              <button onClick={deleteSelected}>Delete Camera</button>
            </>
          )}
          {selectedObject && (
            <>
              <button onClick={rotateSelectedObject}>Rotate 90°</button>
              <button onClick={duplicateSelection} title="Place another one of these (Ctrl+D)">Copy item</button>
              <button onClick={deleteSelected}>Delete Object</button>
            </>
          )}
          {selectedRoom !== null && (
            <>
              {/* Uncontrolled and keyed by the room, so the box shows this room's name
                  and typing in it is never overwritten by a re-render mid-edit. */}
              <label className="room-name">
                Room:
                <input
                  key={`room-name-${selectedRoom}`}
                  type="text"
                  defaultValue={normalizeRoomName(walls[selectedRoom]?.label)}
                  placeholder={roomDisplayName(walls[selectedRoom], selectedRoom)}
                  maxLength={MAX_ROOM_NAME}
                  title="Name this room — the report and the blind-spot list use it"
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                  onBlur={(e) => renameSelectedRoom(e.currentTarget.value)}
                />
              </label>
              <button onClick={deleteSelectedRoom}>Delete Room</button>
            </>
          )}
          <button onClick={aiPlaceWithModel} disabled={aiBusy} title="Premium: AI-suggested camera positions">
            {aiBusy ? '✨ Analysing the plan…' : '✨ AI Place Cameras'}{aiLocked ? ' 🔒' : ''}
          </button>
          {aiNote && (
            <span className="hint" title={aiSource === 'model'
              ? 'The AI proposed positions; the coverage solver picked the final ones'
              : 'Placed by the coverage solver'}
            >
              {aiSource === 'model' ? '✨ ' : '⚙️ '}{aiNote}
            </span>
          )}
          <button onClick={runBlindSpotDetection} title="Premium: shade the areas no camera can see on the plan">
            🧭 Blind Spots{aiLocked ? ' 🔒' : ''}
          </button>
          {aiBlindSpots.length > 0 && (
            <>
              <span className="hint" title="The red patches on the plan are the areas no camera reaches, and how much of each room that is">
                ⚠ {describeBlindSpots(aiBlindSpots)}
              </span>
              <button onClick={() => setAiBlindSpots([])} title="Take the blind-spot shading back off the plan">✕ Clear spots</button>
            </>
          )}
          <button onClick={exportImage} title={watermarked ? 'Free plan: exports carry a MapMyCams watermark' : 'Export the plan as a PNG'}>Export PNG{watermarked ? ' (watermarked)' : ''}</button>
          <button onClick={sharePlanLink} title="Premium: copy a link that opens this plan">🔗 Share link{shareLocked ? ' 🔒' : ''}</button>
          <button onClick={exportPdfReport} title="Premium: printable PDF security report">📄 PDF report{pdfLocked ? ' 🔒' : ''}</button>
          <button onClick={exitToDashboard} title="Save and return to dashboard">Dashboard</button>
          <button onClick={printPlan}>Print</button>
          <button onClick={resetView}>Reset View</button>
          {toolNotice && <span className="hint" title={toolNotice}>{toolNotice}</span>}
        </div>
      </div>
      <div className="workspace">
        <div className="canvas-wrap" ref={containerRef}>
          {/* Pointer events, not mouse ones: a finger, a stylus and a mouse all arrive
              here. The CSS class carries `touch-action: none`, without which a finger
              drags the page instead of the plan. */}
          <canvas
            ref={canvasRef}
            className="plan-canvas"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onPointerLeave={(event) => { if (event.pointerType !== 'touch') handlePointerUp(event) }}
            onWheel={handleWheel}
          />
          <div className="zoom-controls">
            <button onClick={zoomIn}>+</button>
            <button onClick={zoomOut}>-</button>
          </div>
        </div>
        <div className="side-tabs">
          <button
            className={`side-tab${showSidebar && sideTab === 'cameras' ? ' open' : ''}`}
            onClick={() => {
              armSelect()
              if (showSidebar && sideTab === 'cameras') setShowSidebar(false)
              else { setSideTab('cameras'); setShowSidebar(true) }
            }}
            title="Camera specs and recommendations"
          >
            <svg className="tab-icon" viewBox="0 0 20 20" width="15" height="15" fill="none" aria-hidden="true">
              <path d="M2 7a2 2 0 0 1 2-2h1.2l1-2h7.6l1 2H16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7Z" fill="currentColor" opacity="0.9"/>
              <circle cx="10" cy="10.5" r="3.2" fill="#0f172a"/>
              <circle cx="10" cy="10.5" r="1.5" fill="currentColor"/>
            </svg>
            <span>Cameras</span>
          </button>
          <button
            className={`side-tab${showSidebar && sideTab === 'objects' ? ' open' : ''}`}
            onClick={() => {
              armSelect()
              if (showSidebar && sideTab === 'objects') setShowSidebar(false)
              else { setSideTab('objects'); setShowSidebar(true) }
            }}
            title="Objects"
          >
            <svg className="tab-icon" viewBox="0 0 20 20" width="15" height="15" fill="none" aria-hidden="true">
              <rect x="3" y="3" width="14" height="14" rx="2" fill="currentColor" opacity="0.9"/>
              <rect x="7" y="7" width="6" height="6" fill="#0f172a"/>
            </svg>
            <span>Objects</span>
          </button>
          <button
            className={`side-tab${showSidebar && sideTab === 'score' ? ' open' : ''}`}
            onClick={() => {
              armSelect()
              if (showSidebar && sideTab === 'score') setShowSidebar(false)
              else { setSideTab('score'); setShowSidebar(true) }
            }}
            title="Security score and what to fix"
          >
            <svg className="tab-icon" viewBox="0 0 20 20" width="15" height="15" fill="none" aria-hidden="true">
              <path d="M10 2l6 2.4v4.4c0 3.6-2.5 6.9-6 8.2-3.5-1.3-6-4.6-6-8.2V4.4L10 2Z" fill="currentColor" opacity="0.9"/>
              <path d="M7 9.8l2.3 2.3 4-4.4" stroke="#0f172a" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span>Score</span>
          </button>
          <button
            className={`side-tab${showSidebar && sideTab === 'tools' ? ' open' : ''}`}
            onClick={() => {
              armSelect()
              if (showSidebar && sideTab === 'tools') setShowSidebar(false)
              else { setSideTab('tools'); setShowSidebar(true) }
            }}
            title="Drawing tools"
          >
            <svg className="tab-icon" viewBox="0 0 20 20" width="15" height="15" fill="none" aria-hidden="true">
              <path d="M3 17l1-4 10-10 3 3-10 10-4 1Z" fill="currentColor" opacity="0.9"/>
              <path d="M13 4l3 3" stroke="#0f172a" strokeWidth="1.4"/>
            </svg>
            <span>Tools</span>
          </button>
        </div>
        {showSidebar && (
          <aside className="sidebar">
            {sideTab === 'cameras' ? (
              <>
                <div className="sidebar-header">
                  <h2>Camera planner</h2>
                </div>
            <section className="side-section">
              <h3>Estimate observable range</h3>
              <div className="spec-row">
                <label>Field of view <span>{specFov}°</span></label>
                <input type="range" min="5" max="180" step="1" value={specFov} onChange={(e) => setSpecFov(Number(e.target.value))} />
              </div>
              <div className="spec-row">
                <label>Camera quality</label>
                <select value={specResolution.id} onChange={(e) => setSpecResolution(RESOLUTIONS.find((r) => r.id === e.target.value))}>
                  {RESOLUTIONS.map((r) => (
                    <option key={r.id} value={r.id}>{r.label}</option>
                  ))}
                </select>
              </div>
              <div className="spec-row">
                <label>Identification goal</label>
                <select value={specGoal.id} onChange={(e) => setSpecGoal(DETECTION_LEVELS.find((d) => d.id === e.target.value))}>
                  {DETECTION_LEVELS.map((d) => (
                    <option key={d.id} value={d.id}>{d.label}</option>
                  ))}
                </select>
              </div>
              <p className="spec-hint">{specGoal.hint}</p>
              <div className="range-result">
                <div className="range-big">{specRange > 0 ? `${specRange.toFixed(1)} m` : '—'}</div>
                <div className="range-meta">field width ≈ {specWidth.toFixed(1)} m at that distance</div>
              </div>
              <div className="apply-row">
                {selectedCamera ? (
                  <button className="apply-btn" onClick={applySpecToSelected}>
                    Apply to {selectedCamera.label}
                  </button>
                ) : (
                  <span className="apply-hint">Select a camera on the plan to apply these specs</span>
                )}
              </div>
            </section>
            <section className="side-section">
              <h3>Recommended cameras</h3>
              {mode === 'camera' && (
                <p className="catalog-hint">Click on the plan to place <strong>{selectedPreset.label}</strong></p>
              )}
              <p className="spec-hint">Click any card to load it into the camera tool (then click the plan to place), or paste affiliate links into <code>CAMERA_CATALOG.referralUrl</code> to enable Buy buttons.</p>
              <p className="spec-hint">
                {camLimit === Infinity
                  ? `${cameras.length} camera${cameras.length === 1 ? '' : 's'} on this plan — Premium is unlimited.`
                  : `${cameras.length} of ${camLimit} cameras placed on the Free plan.`}
                {camLimit !== Infinity && cameras.length >= camLimit ? (
                  <>
                    {' '}
                    <button className="btn-ghost" onClick={() => { if (showUpgrade) showUpgrade('Unlimited cameras', 'Free plans stop at 4 cameras. Premium allows as many as the layout needs.', 'premium_monthly') }}>
                      Unlock unlimited
                    </button>
                  </>
                ) : null}
              </p>
              <div className="cam-list">
                {CAMERA_CATALOG.map((c) => {
                  const locked = c.premium && ent && !ent.can('premiumBrands')
                  return (
                  <div
                    className={`cam-card${sideSelection && sideSelection.type === 'camera' && sideSelection.id === c.presetId ? ' active' : ''}`}
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => { if (locked) return; placeCatalogCamera(c.presetId) }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (locked) return; placeCatalogCamera(c.presetId) } }}
                    title={`Switch the camera tool to ${c.name}`}
                  >
                    <img className="cam-img" src={cameraSvg(c.accent, c.kind)} alt={c.name} />
                    <div className="cam-info">
                      <div className="cam-name">{c.name}{locked ? ' 🔒' : ''}</div>
                      <div className="cam-tags">
                        <span>{c.resolutionLabel}</span>
                        <span>{c.fovLabel}</span>
                        <span>{c.irLabel}</span>
                        <span>{c.rating}</span>
                        {c.brand ? <span>{c.brand}</span> : null}
                      </div>
                      {locked ? (
                        <span className="cam-buy pending" onClick={(e) => { e.stopPropagation(); if (showUpgrade) showUpgrade('Premium camera brands', `Unlock ${c.brand} and other premium brand models with Premium or the Brand Integration add-on.`, 'brands') }}>Premium — unlock</span>
                      ) : c.referralUrl ? (
                        <a className="cam-buy" href={c.referralUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Buy</a>
                      ) : (
                        <span className="cam-buy pending" onClick={(e) => e.stopPropagation()} title="Add your affiliate link to CAMERA_CATALOG in src/editor/plan-drawing.js">Buy — link soon</span>
                      )}
                    </div>
                  </div>
                )
                })}
              </div>
            </section>
              </>
            ) : sideTab === 'objects' ? (
              <>
                <div className="sidebar-header">
                  <h2>Objects</h2>
                </div>
                <section className="side-section">
                  <h3>Place objects</h3>
                  <p className="spec-hint">Click an object to load it into the Objects tool, then click the plan to place it.</p>
                  <div className="cam-list">
                    {OBJECT_PRESETS.map((p) => (
                      <div
                        className={`cam-card${sideSelection && sideSelection.type === 'object' && sideSelection.id === p.id ? ' active' : ''}`}
                        key={p.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => placeCatalogObject(p)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); placeCatalogObject(p) } }}
                        title={`Load ${p.label} into the Objects tool`}
                      >
                        <span className="obj-icon" style={{ backgroundColor: p.color }}></span>
                        <div className="cam-info">
                          <div className="cam-name">{p.label}</div>
                          <div className="cam-tags">
                            <span>{p.width} × {p.height} m</span>
                            <span>{p.blocksVision ? 'Blocks vision' : 'Open'}</span>
                            {p.isPowerSource ? <span>Power</span> : null}
                          </div>
                          {p.id === 'door' && (
                            <div className="door-hinge">
                              <button className={hingeShown === 'right' ? 'active' : ''} onClick={(e) => { e.stopPropagation(); applyDoorHinge('right') }}>Right hinge</button>
                              <button className={hingeShown === 'left' ? 'active' : ''} onClick={(e) => { e.stopPropagation(); applyDoorHinge('left') }}>Left hinge</button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="spec-hint">The hinge chosen here is used for the next door you place. With a door selected on the plan it swings that door instead.</p>
                </section>
              </>
            ) : sideTab === 'score' ? (
              <>
                <div className="sidebar-header">
                  <h2>Security score</h2>
                </div>
                {scoreLocked ? (
                  <section className="side-section">
                    <h3>Premium feature</h3>
                    <p className="spec-hint">The score grades this floor out of 100 — cameras reaching every room, doors and windows in view, power to every camera and the entrance watched twice — and lists what to fix. It comes with Premium.</p>
                    <button className="apply-btn" onClick={() => { if (showUpgrade) showUpgrade('Security score', 'Grade the plan out of 100 and get a list of what to fix, room by room.', 'premium_monthly') }}>
                      Unlock with Premium
                    </button>
                  </section>
                ) : (
                  <>
                    <section className="side-section">
                      <h3>This floor</h3>
                      <div className="range-result">
                        <div className="range-big">{health ? `${health.score} / ${healthMax}` : '—'}</div>
                        <div className="range-meta">{healthBand ? healthBand.label : 'Draw a closed room to score this floor'}</div>
                      </div>
                      <p className="spec-hint">Scored from what is on this floor: camera coverage, entry points in view, power to every camera and a second camera on the entrance.</p>
                    </section>
                    <section className="side-section">
                      <h3>What to fix</h3>
                      <div className="cam-list">
                        {(health ? health.checks : []).map((check) => (
                          <div className="cam-card" key={check.key} style={{ cursor: 'default' }}>
                            <span
                              className="obj-icon"
                              style={{ backgroundColor: check.earned === check.max ? '#22c55e' : check.earned > 0 ? '#f59e0b' : '#ef4444' }}
                            ></span>
                            <div className="cam-info">
                              <div className="cam-name">{check.label} · {check.earned}/{check.max}</div>
                              <div className="cam-tags"><span>{check.advice}</span></div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="sidebar-header">
                  <h2>Tools</h2>
                </div>
                <section className="side-section">
                  <h3>Drawing tools</h3>
                  <p className="spec-hint">Pick a tool, then click the plan to use it.</p>
                  <div className="cam-list">
                    <div
                      className={`cam-card${mode === 'select' ? ' active' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => activateTool('select')}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTool('select') } }}
                      title="Select, move, turn and delete what is already on the plan"
                    >
                      <span className="tool-icon">
                        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M5 3v15.2l3.9-3.9 3.1 6.7 3-1.4-3.1-6.6H18z" />
                        </svg>
                      </span>
                      <div className="cam-info">
                        <div className="cam-name">Select</div>
                        <div className="cam-tags">
                          <span>Move</span>
                          <span>Turn</span>
                          <span>Delete</span>
                        </div>
                      </div>
                    </div>
                    <div
                      className={`cam-card${mode === 'wall' ? ' active' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => activateTool('wall')}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTool('wall') } }}
                      title="Draw walls point by point"
                    >
                      <span className="tool-icon">
                        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M4 20V7l4-2 4 2v13" />
                          <path d="M12 20V8l4-2 4 3v11" />
                          <path d="M4 20h16" />
                        </svg>
                      </span>
                      <div className="cam-info">
                        <div className="cam-name">Wall</div>
                        <div className="cam-tags">
                          <span>Click points</span>
                          <span>Finish Wall</span>
                        </div>
                      </div>
                    </div>
                    <div
                      className={`cam-card${mode === 'rectangle' ? ' active' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => activateTool('rectangle')}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTool('rectangle') } }}
                      title="Click and drag to draw a room"
                    >
                      <span className="tool-icon">
                        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect x="4" y="6" width="16" height="12" rx="1" />
                        </svg>
                      </span>
                      <div className="cam-info">
                        <div className="cam-name">Rectangle</div>
                        <div className="cam-tags">
                          <span>Rooms</span>
                          <span>Drag</span>
                        </div>
                      </div>
                    </div>
                    <div
                      className={`cam-card${mode === 'wire' ? ' active' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => activateTool('wire')}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTool('wire') } }}
                      title="Route power wires between cameras and outlets"
                    >
                      <span className="tool-icon">
                        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M4 4l4 6 4-4 4 8 4-3" />
                        </svg>
                      </span>
                      <div className="cam-info">
                        <div className="cam-name">Wire</div>
                        <div className="cam-tags">
                          <span>Power</span>
                          <span>Snaps</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  )

  function exportImage() {
    const canvas = canvasRef.current
    if (!canvas) return
    let dataUrl = canvas.toDataURL('image/png')
    if (watermarked) {
      // Composite the canvas with a watermark overlay for free-tier exports
      const tmp = document.createElement('canvas')
      tmp.width = canvas.width; tmp.height = canvas.height
      const ctx = tmp.getContext('2d')
      ctx.drawImage(canvas, 0, 0)
      ctx.font = `${Math.max(18, canvas.width * 0.025)}px system-ui`
      ctx.fillStyle = 'rgba(15, 23, 42, 0.35)'
      ctx.textAlign = 'center'
      ctx.fillText('MapMyCams Free — mapmycams.dev', canvas.width / 2, canvas.height - 24)
      dataUrl = tmp.toDataURL('image/png')
    }
    const link = document.createElement('a')
    link.download = 'floorplan.png'
    link.href = dataUrl
    link.click()
  }

  /**
   * Copy a link that opens this plan at the other end. The plan travels in the URL
   * fragment, so nothing is uploaded anywhere. Premium (shareable plan links).
   */
  async function sharePlanLink() {
    if (shareLocked) {
      if (showUpgrade) showUpgrade('Shareable plan links', 'Send a link that opens this exact plan — floor by floor, cameras and all. Included with Premium.', 'premium_monthly')
      return
    }
    const url = planShareUrl({ version: 1, walls, cameras, objects, wires }, window.location.href)
    try {
      await navigator.clipboard.writeText(url)
      setToolNotice('Share link copied to the clipboard.')
    } catch {
      window.prompt('Copy this share link:', url)
    }
  }

  /* Every floor in the plan, whichever one happens to be on screen. */
  function planFloors() {
    return FLOOR_NAMES.map((name, i) => {
      const saved = floorsRef.current[i]
      const data = i === activeFloor
        ? { walls, cameras, objects, wires }
        : (saved || { walls: [], cameras: [], objects: [], wires: [] })
      return { name, ...data }
    })
  }

  /**
   * A printable report of the whole plan. The browser's own "Save as PDF" does the
   * writing — nothing to install and no server involved — and the numbers are the
   * ones the editor already shows. Premium, or the one-off PDF Report add-on.
   */
  function exportPdfReport() {
    if (pdfLocked) {
      if (showUpgrade) showUpgrade('Professional PDF report', 'A branded report of every floor, room, camera and blind spot — ready to print or send. Buy it once, or get it with Premium.', 'pdf_report')
      return
    }
    const esc = (value) => String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
    const sections = planFloors().map((floor) => {
      const rooms = floor.walls.filter((w) => w.points.length >= 3)
      const blind = computeBlindSpots(floor.walls, floor.cameras, floor.objects)
      const rows = floor.cameras.length
        ? floor.cameras.map((cam) => `<tr><td>${esc(cam.label || 'Camera')}</td><td>${Math.round(cam.hFov)}°</td><td>${Math.round(cam.distance)} m</td></tr>`).join('')
        : '<tr><td colspan="3">No cameras placed on this floor.</td></tr>'
      let scoreBlock = ''
      if (!scoreLocked) {
        const report = computeHealthScore(floor.walls, floor.cameras, floor.objects, floor.wires)
        const max = report.checks.reduce((sum, check) => sum + check.max, 0)
        const band = scoreBand(max > 0 ? Math.round((report.score / max) * 100) : 0)
        scoreBlock = `<p class="meta"><strong>Security score: ${report.score}/${max} — ${esc(band.label)}</strong></p>
          <ul>${report.checks.map((check) => `<li>${esc(check.label)} — ${esc(check.advice)}</li>`).join('')}</ul>`
      }
      return `<section>
        <h2>${esc(floor.name)} floor</h2>
        <p class="meta">${rooms.length} room${rooms.length === 1 ? '' : 's'} · ${floor.cameras.length} camera${floor.cameras.length === 1 ? '' : 's'} · ${floor.objects.length} placed item${floor.objects.length === 1 ? '' : 's'} · ${floor.wires.length} wire run${floor.wires.length === 1 ? '' : 's'}</p>
        <table><thead><tr><th>Camera</th><th>Field of view</th><th>Range</th></tr></thead><tbody>${rows}</tbody></table>
        ${scoreBlock}
        <p class="meta">${blind.length ? `Areas no camera can see: ${blind.map((b) => esc(b.label)).join(', ')}` : rooms.length ? 'Every sampled point of every room is covered by a camera.' : 'Draw a closed room to have coverage assessed.'}</p>
      </section>`
    }).join('')

    const win = window.open('', '_blank')
    if (!win) {
      setToolNotice('The report window was blocked — allow pop-ups for this site and try again.')
      return
    }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8" />
      <title>MapMyCams security report</title>
      <style>
        body { font: 14px/1.5 system-ui, sans-serif; color: #0f172a; margin: 32px; }
        h1 { margin: 0 0 4px; font-size: 22px; }
        h2 { margin: 28px 0 6px; font-size: 16px; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; }
        .meta { color: #475569; margin: 4px 0; }
        table { width: 100%; border-collapse: collapse; margin: 10px 0; }
        th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; }
        th { background: #f1f5f9; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
        ul { margin: 6px 0 0 18px; padding: 0; color: #334155; }
        footer { margin-top: 32px; color: #64748b; font-size: 12px; }
      </style></head><body>
      <h1>MapMyCams security report</h1>
      <p class="meta">Generated ${new Date().toLocaleString()} · mapmycams.dev</p>
      ${sections}
      <footer>Prepared with MapMyCams. Coverage is estimated from the field of view and range recorded for each camera, clipped by the walls, doors and vision-blocking objects on the plan.</footer>
      </body></html>`)
    win.document.close()
    win.focus()
    win.print()
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

  // ── AI camera placement suggestions (premium / AI add-on) ──
  function aiPlaceCameras() {
    if (aiLocked) {
      if (showUpgrade) showUpgrade('AI camera placement', 'Let AI analyse your floorplan geometry and place cameras at the optimal spots.', 'ai_pack')
      return
    }
    const spots = aiSuggestSpots(walls, cameras)
    if (spots.length > 0) setCameras((prev) => [...prev, ...spots])
    setAiBlindSpots(computeBlindSpots(walls, [...cameras, ...spots], objects))
  }

  // ── AI blind-spot detection ──
  function runBlindSpotDetection() {
    if (aiLocked) {
      if (showUpgrade) showUpgrade('AI blind-spot detection', 'AI scans every room and reports exactly which areas no camera can see.', 'ai_pack')
      return
    }
    setAiBlindSpots(computeBlindSpots(walls, cameras, objects))
  }

  function exitToDashboard() {
    if (onExit) onExit()
  }

  function handleMouseUp() {
    if (placingCamera) {
      const preset = placingCamera.preset
      if (camLimitReached) {
        if (showUpgrade) showUpgrade('Camera limit reached', `Free tier supports up to ${camLimit} cameras. Upgrade to Premium for unlimited cameras.`, 'premium_monthly')
        return
      }
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

  function flushActiveFloor() {
    let fWalls = walls
    let fWires = wires
    if (currentWall && currentWall.points.length >= 2) fWalls = [...walls, { ...currentWall, closed: true }]
    if (currentWire && currentWire.points.length >= 2) fWires = [...wires, { ...currentWire }]
    floorsRef.current[activeFloor] = { walls: fWalls, cameras, objects, wires: fWires }
  }

  function switchFloor(i) {
    if (i === activeFloor) return
    flushActiveFloor()
    setActiveFloor(i)
    const saved = floorsRef.current[i]
    setWalls(saved ? saved.walls : [])
    setCameras(saved ? saved.cameras : [])
    setObjects(saved ? saved.objects : [])
    setWires(saved ? saved.wires : [])
    setCurrentWall(null)
    setCurrentWire(null)
    setWireSnap(null)
    setSelectedCamera(null)
    setSelectedObject(null)
    setSelectedRoom(null)
    setRectStart(null)
    setRectEnd(null)
    setPlacingCamera(null)
    setPlacingObject(null)
    setWindowDrag(null)
    setHoveredPoint(null)
  }

  function rotateSelectedObject() {
    if (!selectedObject) return
    const next = ((selectedObject.rotation || 0) + 90) % 360
    setObjects((prev) => prev.map((o) => (o.id === selectedObject.id ? { ...o, rotation: next } : o)))
    setSelectedObject((prev) => (prev ? { ...prev, rotation: next } : prev))
  }

  function finishWire() {
    if (currentWire && currentWire.points.length >= 2) {
      setWires((prev) => [...prev, { ...currentWire }])
    }
    setCurrentWire(null)
    setWireSnap(null)
  }

  function cancelWire() {
    setCurrentWire(null)
    setWireSnap(null)
  }

  function finishWall() {
    if (currentWall && currentWall.points.length >= 2) {
      // `closed` matches what was on screen while clicking, so finishing a room
      // does not drop the line that was completing it.
      setWalls((prev) => [...prev, { ...currentWall, closed: true }])
      setCurrentWall(null)
    }
  }

  function cancelWall() {
    setCurrentWall(null)
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
      const angle = Math.atan2(dy, dx)
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
            const newRot = rotateDrag.startRotation + (delta * 180 / Math.PI)
            // determine base angle for clamping: wall angle if attached, otherwise startRotation
            let baseAngle = rotateDrag.startRotation
            if (door.wallId != null) {
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

    if (mode === 'wire' && currentWire) {
      const world = getMouseWorld(e)
      const cc = getMouseCanvas(e)
      const snap = findSnapTarget({ x: world.x, y: world.y, canvasX: cc.x, canvasY: cc.y }, cameras, objects, origin, pan, zoom)
      setWireSnap(snap)
      setCurrentWire((prev) => prev ? { ...prev, hoverSnap: snap ? { ...snap, id: endpointId(snap.kind, snap.id) } : null } : prev)
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
      const sw = snapToBelowWorld({ x: world.x, y: world.y })
      setRectEnd({ x: sw.x, y: sw.y })
    }
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
            const hingeT = obj.hingeSide === 'left' ? obj.t1 : obj.t2
            hingeX = p1.x + (p2.x - p1.x) * hingeT
            hingeY = p1.y + (p2.y - p1.y) * hingeT
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
          const hingeT = obj.hingeSide === 'left' ? obj.t1 : obj.t2
          const hx = p1.x + (p2.x - p1.x) * hingeT
          const hy = p1.y + (p2.y - p1.y) * hingeT
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
          const minLocalX = obj.hingeSide === 'left' ? -4 : -wpx - 4
          const maxLocalX = obj.hingeSide === 'left' ? wpx + 4 : 4
          if (localX >= minLocalX && localX <= maxLocalX && localY >= -hpx / 2 - 4 && localY <= hpx / 2 + 4) {
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
          const minLocalX = obj.hingeSide === 'left' ? -4 : -wpx - 4
          const maxLocalX = obj.hingeSide === 'left' ? wpx + 4 : 4
          if (localX >= minLocalX && localX <= maxLocalX && localY >= -hpx / 2 - 4 && localY <= hpx / 2 + 4) {
            // A free-standing door body is selectable like any other item; it used
            // to fall through to an undefined variable and throw.
            setSelectedObject(obj)
            setSelectedRoom(null)
            setSelectedCamera(null)
            const startAngle = Math.atan2(world.y - hingeY, world.x - hingeX)
            setRotateDrag({ type: 'rotateDoor', objectId: obj.id, centerX: hingeX, centerY: hingeY, startAngle, startRotation: obj.rotation })
            return
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
            const doorWidthPx = DOOR_WIDTH_METERS * PIXELS_PER_METER
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
              hingeSide: doorHinge,
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
      const sw = snapToBelowWorld({ x: world.x, y: world.y })
      setRectStart({ x: sw.x, y: sw.y })
      setRectEnd({ x: sw.x, y: sw.y })
      setDrag({ type: 'rect', startX: sw.x, startY: sw.y })
      return
    }

    if (mode === 'wall') {
      const sw = snapToBelowWorld({ x: world.x, y: world.y })
      setCurrentWall((prev) => {
        const points = prev ? [...prev.points, { x: sw.x, y: sw.y }] : [{ x: sw.x, y: sw.y }]
        return {
          id: prev?.id ?? nextId++,
          ...prev,
          points,
          label: prev?.label || `Room ${walls.length + 1}`,
        }
      })
      return
    }

    if (mode === 'wire') {
      const snap = findSnapTarget({ x: world.x, y: world.y, canvasX: c.x, canvasY: c.y }, cameras, objects, origin, pan, zoom)
      const settle = snap ? { x: snap.x, y: snap.y, snapId: endpointId(snap.kind, snap.id) } : null
      setCurrentWire((prev) => {
        if (!prev) {
          return {
            id: nextId++,
            points: [settle || { x: world.x, y: world.y }],
            snapStartId: settle ? settle.snapId : null,
            snapEndId: settle ? settle.snapId : null,
            hoverSnap: null,
          }
        }
        const last = prev.points[prev.points.length - 1]
        if (settle && prev.snapEndId === settle.snapId && Math.hypot(last.x - world.x, last.y - world.y) < 0.0001) {
          setTimeout(finishWire, 0)
          return prev
        }
        const newPt = settle || { x: world.x, y: world.y }
        const points = [...prev.points, newPt]
        const updated = { ...prev, points, hoverSnap: null }
        if (settle) updated.snapEndId = settle.snapId
        return updated
      })
      setWireSnap(snap)
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
          const hingeT = obj.hingeSide === 'left' ? obj.t1 : obj.t2
          const hx = p1.x + (p2.x - p1.x) * hingeT
          const hy = p1.y + (p2.y - p1.y) * hingeT
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
          const minLocalX = obj.hingeSide === 'left' ? -12 : -wpx - 12
          const maxLocalX = obj.hingeSide === 'left' ? wpx + 12 : 12
          if (localX >= minLocalX && localX <= maxLocalX && localY >= -hpx / 2 - 12 && localY <= hpx / 2 + 12) {
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

  /* INSERT */
}

export default App
