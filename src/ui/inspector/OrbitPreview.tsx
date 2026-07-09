// The 3D model inspector's interactive viewport: drag to orbit, Shift/right-drag to pan,
// wheel to dolly. Renders the decimated preview mesh (useStlMesh) flat-shaded with a painter's
// sort on a plain 2D canvas — a per-frame view concern, so TS is the right side of the WASM
// boundary for it. The camera math MUST mirror `crate/src/wireframe/view.rs` exactly (same eye
// formula, FOV, projection, NDC pan offsets, and the element box's aspect), so what you frame
// here is exactly what renders. The canvas keeps the element's aspect ratio for the same reason.
//
// Undo contract: a pointer drag brackets its (rAF-throttled) `setParams` stream in
// `beginGesture`/`endGesture`, like any canvas gesture; a wheel-dolly burst opens a gesture on the
// first tick and closes it on a 300 ms idle timer — one undo step per orbit/pan/dolly.
import { useEffect, useRef, useState } from 'react'
import { beginGesture, endGesture } from '../../store/history'
import type { ModelParams } from '../../elements/model'
import { useStlMesh, PREVIEW_MAX_TRIS } from './useStlMesh'

/** Mirrors `tess::WIREFRAME_FOV_DEG` — keep in sync with crate/src/tess.rs. */
const FOV_DEG = 40
const ORBIT_DEG_PER_PX = 0.5
const DOLLY_PER_WHEEL = 0.0015
const WHEEL_GESTURE_IDLE_MS = 300
const MAX_CANVAS_HEIGHT = 320

type Pose = Pick<ModelParams, 'yaw' | 'pitch' | 'panX' | 'panY' | 'distance'>

export function OrbitPreview({
  modelId,
  params,
  commit,
}: {
  modelId: string
  params: Pose & Pick<ModelParams, 'targetWidthMm' | 'targetHeightMm' | 'projection'>
  commit: (patch: Partial<ModelParams>) => void
}) {
  const mesh = useStlMesh(modelId)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)

  // Track the host width so the canvas fills the inspector column at the element's aspect.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas?.parentElement) return
    const host = canvas.parentElement
    const measure = () => setWidth(host.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  const aspect = params.targetWidthMm / Math.max(1e-6, params.targetHeightMm)
  const height = Math.min(MAX_CANVAS_HEIGHT, Math.round(width / Math.max(0.2, aspect)))

  // Gesture-local pose: pointer moves accumulate here (props lag the rAF-throttled commits, so
  // deltas can't apply against them without losing motion within a frame). Deltas come from
  // clientX/Y, not movementX/Y (which is physical-px on some platforms and 0 in synthetic events).
  const pose = useRef<Pose>({ ...params })
  const gesture = useRef<{ mode: 'orbit' | 'pan'; lastX: number; lastY: number } | null>(null)
  const wheelTimer = useRef<number | null>(null)
  const raf = useRef(0)

  const queueCommit = () => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      commit({ ...pose.current })
    })
  }

  // End any open gesture and cancel throttled work on unmount (element switch mid-drag).
  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current)
      if (wheelTimer.current !== null) {
        window.clearTimeout(wheelTimer.current)
        endGesture()
      }
      if (gesture.current) endGesture()
    },
    [],
  )

  const syncPoseFromProps = () => {
    pose.current = {
      yaw: params.yaw,
      pitch: params.pitch,
      panX: params.panX,
      panY: params.panY,
      distance: params.distance,
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return
    e.currentTarget.setPointerCapture(e.pointerId)
    if (!wheelTimer.current) syncPoseFromProps()
    gesture.current = {
      mode: e.button !== 0 || e.shiftKey ? 'pan' : 'orbit',
      lastX: e.clientX,
      lastY: e.clientY,
    }
    beginGesture()
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current
    if (!g) return
    const dx = e.clientX - g.lastX
    const dy = e.clientY - g.lastY
    g.lastX = e.clientX
    g.lastY = e.clientY
    const p = pose.current
    if (g.mode === 'orbit') {
      // "Grab the surface": dragging right spins the visible face rightward.
      p.yaw = (p.yaw - dx * ORBIT_DEG_PER_PX) % 360
      p.pitch = clamp(p.pitch + dy * ORBIT_DEG_PER_PX, -85, 85)
    } else {
      p.panX = clamp(p.panX + dx / Math.max(1, width), -0.5, 0.5)
      p.panY = clamp(p.panY + dy / Math.max(1, height), -0.5, 0.5)
    }
    queueCommit()
  }

  const onPointerUp = () => {
    if (!gesture.current) return
    gesture.current = null
    queueCommit()
    endGesture()
  }

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    if (wheelTimer.current === null) {
      if (!gesture.current) syncPoseFromProps()
      beginGesture()
    } else {
      window.clearTimeout(wheelTimer.current)
    }
    wheelTimer.current = window.setTimeout(() => {
      wheelTimer.current = null
      endGesture()
    }, WHEEL_GESTURE_IDLE_MS)
    pose.current.distance = clamp(pose.current.distance * Math.exp(e.deltaY * DOLLY_PER_WHEEL), 1.3, 20)
    queueCommit()
  }

  // React attaches `onWheel` passively (17+), so `preventDefault` wouldn't stop the inspector from
  // scrolling — the dolly needs a native non-passive listener. Ref-indirected so the listener
  // registers once but always sees the latest closure.
  const wheelRef = useRef(onWheel)
  wheelRef.current = onWheel
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handler = (e: WheelEvent) => wheelRef.current(e)
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [])

  // Redraw on any pose/mesh/size change. ~6k flat-shaded triangles is comfortably under a frame.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width < 10 || height < 10) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.scale(dpr, dpr)

    const style = getComputedStyle(canvas)
    const surface = parseColor(style.getPropertyValue('--color-surface')) ?? [255, 255, 255]
    const text = parseColor(style.getPropertyValue('--color-text')) ?? [24, 24, 27]
    ctx.clearRect(0, 0, width, height)
    if (!mesh) {
      ctx.fillStyle = style.getPropertyValue('--color-faint') || '#a1a1aa'
      ctx.font = '12px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('Loading model…', width / 2, height / 2)
      return
    }

    // ── The camera — mirrors wireframe/view.rs (positions are already bbox-centered) ──
    const yaw = (params.yaw * Math.PI) / 180
    const pitch = (clamp(params.pitch, -85, 85) * Math.PI) / 180
    const d = clamp(params.distance, 1.3, 20) * mesh.radius
    const e: V3 = [Math.sin(yaw) * Math.cos(pitch), -Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)]
    const eye: V3 = [d * e[0], d * e[1], d * e[2]]
    const fwd: V3 = [-e[0], -e[1], -e[2]]
    const right = norm(cross(fwd, [0, 0, 1]))
    const up = cross(right, fwd)
    const tanf = Math.tan(((FOV_DEG / 2) * Math.PI) / 180)
    // Ortho scales by the frustum half-height at the model center, so both projections frame the
    // model identically (mirrors wireframe/view.rs).
    const ortho = params.projection === 'orthographic'
    const halfH = tanf * d
    // The camera light: from the upper-left front, in camera space.
    const light = norm([-0.35, 0.55, -0.75])

    const pos = mesh.positions
    const nTris = pos.length / 9
    const tris: { z: number; shade: number; pts: [number, number][] }[] = []
    const cam = new Float32Array(9)
    for (let t = 0; t < nTris; t++) {
      const pts: [number, number][] = []
      for (let v = 0; v < 3; v++) {
        const i = t * 9 + v * 3
        const rel: V3 = [pos[i] - eye[0], pos[i + 1] - eye[1], pos[i + 2] - eye[2]]
        const cz = dot(rel, fwd)
        cam[v * 3] = dot(rel, right)
        cam[v * 3 + 1] = dot(rel, up)
        cam[v * 3 + 2] = cz
        const sdiv = ortho ? halfH : cz * tanf
        const ndcX = cam[v * 3] / (sdiv * aspect) + 2 * params.panX
        const ndcY = cam[v * 3 + 1] / sdiv - 2 * params.panY
        pts.push([(ndcX * 0.5 + 0.5) * width, (0.5 - ndcY * 0.5) * height])
      }
      // Camera-space flat shade; abs() = two-sided (STL winding is untrustworthy).
      const n = norm(
        cross(
          [cam[3] - cam[0], cam[4] - cam[1], cam[5] - cam[2]],
          [cam[6] - cam[0], cam[7] - cam[1], cam[8] - cam[2]],
        ),
      )
      const shade = 0.25 + 0.75 * Math.abs(dot(n, light))
      tris.push({ z: (cam[2] + cam[5] + cam[8]) / 3, shade, pts })
    }
    tris.sort((a, b) => b.z - a.z) // painter's: far first

    for (const t of tris) {
      const mixT = 0.25 + 0.6 * t.shade
      const c = `rgb(${mix(surface[0], text[0], mixT)},${mix(surface[1], text[1], mixT)},${mix(surface[2], text[2], mixT)})`
      ctx.fillStyle = c
      ctx.strokeStyle = c
      ctx.lineWidth = 0.5
      ctx.beginPath()
      ctx.moveTo(t.pts[0][0], t.pts[0][1])
      ctx.lineTo(t.pts[1][0], t.pts[1][1])
      ctx.lineTo(t.pts[2][0], t.pts[2][1])
      ctx.closePath()
      ctx.fill()
      ctx.stroke() // hairline over the shared edges hides antialiasing cracks
    }
  }, [mesh, params.yaw, params.pitch, params.panX, params.panY, params.distance, params.projection, aspect, width, height])

  return (
    <div className="min-w-0">
      <canvas
        ref={canvasRef}
        className="w-full cursor-grab touch-none rounded-md border border-border bg-surface active:cursor-grabbing"
        style={{ height }}
        title="Drag to orbit · Shift-drag or right-drag to pan · scroll to zoom"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />
      {mesh && (
        <div className="mt-1 text-xs text-faint">
          {mesh.totalTris.toLocaleString()} triangles
          {mesh.totalTris > PREVIEW_MAX_TRIS && ` (preview shows ${PREVIEW_MAX_TRIS.toLocaleString()})`}
        </div>
      )}
    </div>
  )
}

type V3 = [number, number, number]

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const dot = (a: V3 | Float32Array, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const norm = (a: V3): V3 => {
  const l = Math.max(1e-12, Math.hypot(a[0], a[1], a[2]))
  return [a[0] / l, a[1] / l, a[2] / l]
}
const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t)

/** Parse a `#rgb`/`#rrggbb` CSS custom-property value (what index.css uses for the tokens). */
function parseColor(v: string): [number, number, number] | null {
  const s = v.trim()
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (!m) return null
  const h = m[1]
  if (h.length === 3)
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
