// ─── Read-only client review of a shared plan ─────────────────────────────────
// Reached with ?share=<code>, before any sign-in gate: the point of a share link
// is that a client can open it. The plan is drawn from the same pure drawing
// functions as the editor — so the picture is identical — but nothing here can
// edit it: there are no mutation handlers and no autosave, and the only writes
// are the reviewer's own comment pins.

import { useEffect, useRef, useState } from 'react'
import * as api from './api'
import { normalizePlanData } from '../editor/history'
import { roomDisplayName } from '../editor/room-names'
import {
  FLOOR_NAMES, toCanvas, toWorld, drawGrid, drawWall, drawObject, drawWire,
  drawFovShape, drawRoomLabel, computeBlindSpots, describeBlindSpots,
} from '../editor/plan-drawing'

export default function ShareViewer({ code, signedIn, onMakeCopy, onSignIn }) {
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [floor, setFloor] = useState(0)
  const [pan, setPan] = useState({ x: 400, y: 300 })
  const [zoom, setZoom] = useState(1)
  const [draftPin, setDraftPin] = useState(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [email, setEmail] = useState('')
  const canvasRef = useRef(null)
  const containerRef = useRef(null)

  useEffect(() => {
    let live = true
    api.getSharedPlan(code)
      .then((data) => { if (live) setReport(data) })
      .catch((err) => { if (live) setError(err.message) })
    return () => { live = false }
  }, [code])

  const plan = report ? normalizePlanData(report.data, FLOOR_NAMES.length) : null
  const here = plan ? plan.floors[Math.min(floor, plan.floors.length - 1)] : null
  const comments = (report?.comments || []).filter((c) => c.floorIndex === Math.min(floor, plan ? plan.floors.length - 1 : 0))

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || !here) return undefined
    const resize = () => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      draw()
    }
    const draw = () => {
      const ctx = canvas.getContext('2d')
      const dpr = window.devicePixelRatio || 1
      const w = canvas.width / dpr, h = canvas.height / dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#f8fafc'
      ctx.fillRect(0, 0, w, h)
      drawGrid(ctx, w, h, pan, zoom)
      here.walls.forEach((wall, i) => {
        drawWall(ctx, wall, { x: 0, y: 0 }, pan, zoom, here.objects, here.walls)
        drawRoomLabel(ctx, wall, { x: 0, y: 0 }, pan, zoom, roomDisplayName(wall, i))
      })
      for (const wire of here.wires) drawWire(ctx, wire, { x: 0, y: 0 }, pan, zoom)
      for (const cam of here.cameras) drawFovShape(ctx, cam, { x: 0, y: 0 }, pan, zoom, here.walls, here.objects, [], false)
      for (const obj of here.objects) drawObject(ctx, obj, { x: 0, y: 0 }, pan, zoom, here.walls)
      // Review pins, numbered in the order they were left.
      comments.forEach((comment, i) => {
        const p = toCanvas(comment.x, comment.y, { x: 0, y: 0 }, pan, zoom)
        ctx.beginPath()
        ctx.arc(p.x, p.y, 11, 0, Math.PI * 2)
        ctx.fillStyle = '#f97316'
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 11px system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(i + 1), p.x, p.y)
      })
      if (draftPin) {
        const p = toCanvas(draftPin.x, draftPin.y, { x: 0, y: 0 }, pan, zoom)
        ctx.beginPath()
        ctx.arc(p.x, p.y, 11, 0, Math.PI * 2)
        ctx.strokeStyle = '#f97316'
        ctx.lineWidth = 2
        ctx.setLineDash([4, 3])
        ctx.stroke()
        ctx.setLineDash([])
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()
    return () => observer.disconnect()
  }, [here, pan, zoom, comments, draftPin])

  // Drag to pan; a click without travel leaves a pin where a reviewer pressed.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    let start = null
    const down = (e) => { start = { x: e.clientX, y: e.clientY, pan } }
    const move = (e) => {
      if (!start) return
      setPan({ x: start.pan.x + (e.clientX - start.x), y: start.pan.y + (e.clientY - start.y) })
    }
    const up = (e) => {
      const moved = start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4
      start = null
      if (moved || !report?.canComment) return
      const rect = canvas.getBoundingClientRect()
      const world = toWorld(e.clientX - rect.left, e.clientY - rect.top, { x: 0, y: 0 }, pan, zoom)
      setDraftPin(world)
    }
    canvas.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      canvas.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [pan, zoom, report])

  async function submitComment() {
    if (!draftPin || !text.trim() || busy) return
    setBusy(true)
    setNotice('')
    try {
      const comment = await api.addShareComment(code, {
        text: text.trim().slice(0, 2000),
        floorIndex: Math.min(floor, plan.floors.length - 1),
        x: draftPin.x, y: draftPin.y,
      })
      setReport((prev) => ({ ...prev, comments: [...prev.comments, { ...comment, canDelete: true }] }))
      setDraftPin(null)
      setText('')
    } catch (err) { setNotice(err.message) } finally { setBusy(false) }
  }

  async function removeComment(id) {
    setBusy(true)
    try {
      await api.deleteShareComment(code, id)
      setReport((prev) => ({ ...prev, comments: prev.comments.filter((c) => c.id !== id) }))
    } catch (err) { setNotice(err.message) } finally { setBusy(false) }
  }

  async function sendReport() {
    if (busy) return
    setBusy(true)
    setNotice('')
    try {
      await api.emailShare(code, email.trim())
      setNotice('Report sent.')
    } catch (err) { setNotice(err.message) } finally { setBusy(false) }
  }

  async function revoke() {
    if (!window.confirm('Revoke this link? Anyone holding it loses access.')) return
    setBusy(true)
    try {
      await api.revokeShare(code)
      setError('This link has been revoked.')
      setReport(null)
    } catch (err) { setNotice(err.message) } finally { setBusy(false) }
  }

  if (error) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-brand"><span className="auth-logo">▲</span> MapMyCams</div>
          <h1>Shared plan</h1>
          <p className="auth-error">{error}</p>
          <p className="auth-legal">Ask whoever sent it for a fresh link.</p>
        </div>
      </div>
    )
  }
  if (!report || !plan) {
    return <div className="auth-screen"><p>Loading…</p></div>
  }

  return (
    <div className="app">
      <div className="toolbar">
        <div className="tools">
          <strong>{report.name}</strong>
          <span className="hint">Read-only · shared {new Date(report.created).toLocaleDateString()}</span>
          {report.isOwner && <span className="hint">Opened {report.opens || 0} time(s) · expires {new Date(report.expires).toLocaleDateString()}</span>}
        </div>
        <div className="controls">
          <div className="floor-switch">
            {FLOOR_NAMES.map((name, i) => (
              <button key={name} className={floor === i ? 'active' : ''} onClick={() => { setFloor(i); setDraftPin(null) }}>{name}</button>
            ))}
          </div>
          <button onClick={() => window.print()}>Printable report</button>
          {signedIn && onMakeCopy && <button onClick={() => onMakeCopy(report)}>Make editable copy</button>}
          {!signedIn && onSignIn && <button onClick={onSignIn}>Sign in to comment</button>}
          {report.isOwner && <button className="danger" onClick={revoke}>Revoke link</button>}
        </div>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none', cursor: report.canComment ? 'crosshair' : 'grab' }} />
      </div>
      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <div className="tools">
          <button onClick={() => setZoom((z) => Math.min(5, z * 1.2))}>＋</button>
          <button onClick={() => setZoom((z) => Math.max(0.2, z / 1.2))}>－</button>
          <span className="hint">{describeBlindSpots(computeBlindSpots(here.walls, here.cameras, here.objects)) || 'Every sampled point of this floor is covered.'}</span>
        </div>
        <div className="controls">
          {report.isOwner && (
            <>
              <input className="auth-input" type="email" placeholder="Send report to…" value={email} onChange={(e) => setEmail(e.target.value)} />
              <button disabled={busy || !email.trim()} onClick={sendReport}>Email report</button>
            </>
          )}
          {notice && <span role="status">{notice}</span>}
        </div>
      </div>
      <div className="save-status" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        {report.canComment ? (
          <>
            {draftPin ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <input autoFocus maxLength={2000} placeholder="What should change here?" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitComment() }} />
                <button disabled={busy || !text.trim()} onClick={submitComment}>Leave note</button>
                <button onClick={() => { setDraftPin(null); setText('') }}>Cancel</button>
              </div>
            ) : <span>Click the plan to leave a note on a spot.</span>}
          </>
        ) : <span>Anyone with this link can view. Sign in to leave review notes.</span>}
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {comments.map((c, i) => (
            <li key={c.id}>
              <strong>{i + 1}. {c.authorName}</strong>: {c.text}
              {c.canDelete && <button onClick={() => removeComment(c.id)}>✕</button>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
