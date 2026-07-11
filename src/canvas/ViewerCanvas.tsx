// The share viewer's canvas: the same Konva rendering as the editor (bed + ElementNode /
// ContainerNode in readOnly mode, so what's shown is exactly what would plot) with pan/zoom only.
// Deliberately its own slim component rather than a flag through Canvas.tsx — the editor canvas
// is tools/marquee/Transformer entanglement the viewer has no use for. Gestures are simpler
// here too: any single-pointer drag pans (there are no tools), wheel zooms to the cursor,
// two pointers pinch. View state only — no history, no gestures to record.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Layer, Rect, Stage } from 'react-konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { DocElement } from '../core/types'
import { useDoc } from '../store/document'
import { useViewport } from '../store/viewport'
import { clampViewport, fitScale, MAX_SCALE, MIN_SCALE } from './viewport'
import { isContainer } from '../elements/registry'
import { ContainerNode } from './ContainerNode'
import { ElementNode } from './ElementNode'
import { FiducialLayer } from './FiducialLayer'

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

export function ViewerCanvas() {
  const elements = useDoc((s) => s.elements)
  const bed = useDoc((s) => s.profile.bed)
  const { containerIds, membersOf } = useMemo(() => {
    const containerIds = new Set(elements.filter((e) => isContainer(e.type)).map((e) => e.id))
    const membersOf = new Map<string, DocElement[]>()
    for (const e of elements) {
      if (e.parent) {
        const arr = membersOf.get(e.parent) ?? []
        arr.push(e)
        membersOf.set(e.parent, arr)
      }
    }
    return { containerIds, membersOf }
  }, [elements])

  const scale = useViewport((s) => s.scale)
  const vx = useViewport((s) => s.x)
  const vy = useViewport((s) => s.y)
  const setViewport = useViewport((s) => s.setViewport)
  const setFit = useViewport((s) => s.setFit)

  const hostRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const pan = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinch = useRef<{ startDist: number; startScale: number; mx: number; my: number } | null>(null)
  const fittedFor = useRef('')

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Fit the bed on first sight of a bed size; on plain resize, re-clamp (keep zoom).
  useEffect(() => {
    if (!size.w || !size.h) return
    const bedKey = `${bed.width}x${bed.height}`
    const s = fitScale(size.w, size.h, bed.width, bed.height)
    setFit(s)
    if (fittedFor.current !== bedKey) {
      fittedFor.current = bedKey
      setViewport(clampViewport({ scale: s, x: 0, y: 0 }, size.w, size.h, bed.width, bed.height))
    } else {
      setViewport(clampViewport(useViewport.getState(), size.w, size.h, bed.width, bed.height))
    }
  }, [size.w, size.h, bed.width, bed.height, setViewport, setFit])

  // Pointer bookkeeping survives releases outside the stage.
  useEffect(() => {
    const up = (e: PointerEvent) => {
      pointers.current.delete(e.pointerId)
      if (pointers.current.size < 2) pinch.current = null
      if (pan.current?.pointerId === e.pointerId) pan.current = null
    }
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])

  const applyViewport = (v: { scale: number; x: number; y: number }) =>
    setViewport(clampViewport(v, size.w, size.h, bed.width, bed.height))

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const pointer = e.target.getStage()?.getPointerPosition()
    if (!pointer) return
    const cur = useViewport.getState()
    const factor = e.evt.deltaY < 0 ? 1.1 : 1 / 1.1
    const next = clamp(cur.scale * factor, MIN_SCALE, MAX_SCALE)
    const mx = (pointer.x - cur.x) / cur.scale
    const my = (pointer.y - cur.y) / cur.scale
    applyViewport({ scale: next, x: pointer.x - mx * next, y: pointer.y - my * next })
  }

  // Two-finger pinch: zoom toward the gesture midpoint while panning with it (same math as the
  // editor canvas). Coordinates are stage-relative px.
  const stageRel = (clientX: number, clientY: number) => {
    const r = hostRef.current?.getBoundingClientRect()
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) }
  }
  const twoPointers = () => {
    const pts = [...pointers.current.values()]
    return pts.length >= 2 ? ([pts[0], pts[1]] as const) : null
  }
  const beginPinch = () => {
    const two = twoPointers()
    if (!two) return
    const [a, b] = two
    const mid = stageRel((a.x + b.x) / 2, (a.y + b.y) / 2)
    const cur = useViewport.getState()
    pinch.current = {
      startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      startScale: cur.scale,
      mx: (mid.x - cur.x) / cur.scale,
      my: (mid.y - cur.y) / cur.scale,
    }
  }
  const updatePinch = () => {
    const two = twoPointers()
    const pc = pinch.current
    if (!two || !pc) return
    const [a, b] = two
    const mid = stageRel((a.x + b.x) / 2, (a.y + b.y) / 2)
    const next = clamp((pc.startScale * Math.hypot(a.x - b.x, a.y - b.y)) / pc.startDist, MIN_SCALE, MAX_SCALE)
    applyViewport({ scale: next, x: mid.x - pc.mx * next, y: mid.y - pc.my * next })
  }

  const onPointerDown = (e: KonvaEventObject<PointerEvent>) => {
    pointers.current.set(e.evt.pointerId, { x: e.evt.clientX, y: e.evt.clientY })
    if (pointers.current.size >= 2) {
      pan.current = null
      beginPinch()
      return
    }
    pan.current = { pointerId: e.evt.pointerId, lastX: e.evt.clientX, lastY: e.evt.clientY }
  }

  const onPointerMove = (e: KonvaEventObject<PointerEvent>) => {
    if (pointers.current.has(e.evt.pointerId))
      pointers.current.set(e.evt.pointerId, { x: e.evt.clientX, y: e.evt.clientY })
    if (pinch.current && pointers.current.size >= 2) {
      updatePinch()
      return
    }
    const p = pan.current
    if (!p || p.pointerId !== e.evt.pointerId) return
    const cur = useViewport.getState()
    applyViewport({ scale: cur.scale, x: cur.x + e.evt.clientX - p.lastX, y: cur.y + e.evt.clientY - p.lastY })
    p.lastX = e.evt.clientX
    p.lastY = e.evt.clientY
  }

  const onPointerUp = (e: KonvaEventObject<PointerEvent>) => {
    pointers.current.delete(e.evt.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pan.current?.pointerId === e.evt.pointerId) pan.current = null
  }

  return (
    <div
      ref={hostRef}
      className="relative min-h-0 flex-1 overflow-hidden bg-canvas"
      style={{ cursor: 'grab', touchAction: 'none' }}
    >
      {size.w > 0 && size.h > 0 && (
        <Stage
          width={size.w}
          height={size.h}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <Layer x={vx} y={vy} scaleX={scale} scaleY={scale}>
            <Rect
              name="bed"
              x={0}
              y={0}
              width={bed.width}
              height={bed.height}
              fill="#ffffff"
              stroke="#a1a1aa"
              strokeWidth={0.3}
              shadowColor="#000"
              shadowBlur={6}
              shadowOpacity={0.08}
            />
            {elements.map((el) => {
              if (el.hidden) return null
              // Members render only through their container's composed geometry (nothing is ever
              // selected in the viewer, so there's no edit-in-place case).
              if (el.parent && containerIds.has(el.parent)) return null
              if (isContainer(el.type))
                return <ContainerNode key={el.id} element={el} membersOf={membersOf} pxPerMm={scale} readOnly />
              return <ElementNode key={el.id} element={el} pxPerMm={scale} readOnly />
            })}
            <FiducialLayer pxPerMm={scale} interactive={false} />
          </Layer>
        </Stage>
      )}
    </div>
  )
}
