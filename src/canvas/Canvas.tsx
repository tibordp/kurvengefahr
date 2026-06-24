// The canvas: a Konva stage filling its host, with a pan/zoom viewport. The Layer is scaled
// (px/mm) and offset (pan) by the viewport; everything inside is authored in millimetres.
//
// Interaction:
//   - wheel            → zoom toward the cursor
//   - Space-drag / MMB → pan (only meaningful when the bed exceeds the viewport; clamped)
//   - mouse-move       → publish cursor position (mm) to the status bar
// The store stays authoritative for element transforms; the viewport is its own UI store.
import { useEffect, useRef, useState } from 'react'
import { Stage, Layer, Rect, Circle, Line, Transformer } from 'react-konva'
import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { useDoc } from '../store/document'
import { usePreview } from '../store/preview'
import { useViewport, useCursor } from '../store/viewport'
import { clampViewport, fitScale, MIN_SCALE, MAX_SCALE } from './viewport'
import { drawableRegion } from '../core/pipeline/clip'
import { ElementNode } from './ElementNode'
import { PreviewLayer } from './PreviewLayer'

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

export function Canvas() {
  const elements = useDoc((s) => s.elements)
  const profile = useDoc((s) => s.profile)
  const bed = profile.bed
  const selectedId = useDoc((s) => s.selectedId)
  const select = useDoc((s) => s.select)
  const previewActive = usePreview((s) => s.active)

  const scale = useViewport((s) => s.scale)
  const vx = useViewport((s) => s.x)
  const vy = useViewport((s) => s.y)
  const setViewport = useViewport((s) => s.setViewport)
  const setFit = useViewport((s) => s.setFit)
  const setCursor = useCursor((s) => s.setCursor)
  const clearCursor = useCursor((s) => s.clear)

  const hostRef = useRef<HTMLDivElement>(null)
  const trRef = useRef<Konva.Transformer>(null)
  const pan = useRef({ active: false, lastX: 0, lastY: 0 })
  const fittedFor = useRef('')
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [hoverElement, setHoverElement] = useState(false)

  // Track the host size.
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Fit the bed on first sight of a bed size; on plain resize, just re-clamp (keep zoom).
  useEffect(() => {
    if (!size.w || !size.h) return
    const bedKey = `${bed.width}x${bed.height}`
    if (fittedFor.current !== bedKey) {
      fittedFor.current = bedKey
      const s = fitScale(size.w, size.h, bed.width, bed.height)
      setFit(s)
      setViewport(clampViewport({ scale: s, x: 0, y: 0 }, size.w, size.h, bed.width, bed.height))
    } else {
      setFit(fitScale(size.w, size.h, bed.width, bed.height))
      setViewport(clampViewport(useViewport.getState(), size.w, size.h, bed.width, bed.height))
    }
  }, [size.w, size.h, bed.width, bed.height, setViewport, setFit])

  // Track Space for pan mode (ignored while typing).
  useEffect(() => {
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    }
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !typing(e.target)) {
        setSpaceHeld(true)
        e.preventDefault()
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // Attach the Transformer to the selected element (never in preview / pan mode).
  useEffect(() => {
    const tr = trRef.current
    const stage = tr?.getStage()
    if (!tr || !stage) return
    const node = selectedId && !previewActive ? stage.findOne('#' + selectedId) : null
    tr.nodes(node ? [node] : [])
    tr.getLayer()?.batchDraw()
  }, [selectedId, elements, previewActive, scale, vx, vy])

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const stage = e.target.getStage()
    const pointer = stage?.getPointerPosition()
    if (!pointer) return
    const cur = useViewport.getState()
    const factor = e.evt.deltaY < 0 ? 1.1 : 1 / 1.1
    const next = clamp(cur.scale * factor, MIN_SCALE, MAX_SCALE)
    const mx = (pointer.x - cur.x) / cur.scale
    const my = (pointer.y - cur.y) / cur.scale
    setViewport(
      clampViewport(
        { scale: next, x: pointer.x - mx * next, y: pointer.y - my * next },
        size.w,
        size.h,
        bed.width,
        bed.height,
      ),
    )
  }

  const onMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    if (spaceHeld || e.evt.button === 1) {
      pan.current = { active: true, lastX: e.evt.clientX, lastY: e.evt.clientY }
      e.evt.preventDefault()
      return
    }
    // Click on empty canvas (stage or bed) deselects.
    if (e.target === e.target.getStage() || e.target.name() === 'bed') select(null)
  }

  const onMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    const stage = e.target.getStage()
    if (pan.current.active) {
      const dx = e.evt.clientX - pan.current.lastX
      const dy = e.evt.clientY - pan.current.lastY
      pan.current.lastX = e.evt.clientX
      pan.current.lastY = e.evt.clientY
      const cur = useViewport.getState()
      setViewport(
        clampViewport(
          { scale: cur.scale, x: cur.x + dx, y: cur.y + dy },
          size.w,
          size.h,
          bed.width,
          bed.height,
        ),
      )
      return
    }
    // Hover affordance: is the pointer over a draggable element? (walk up to a draggable node)
    let node: Konva.Node | null = e.target
    let over = false
    while (node && node !== stage) {
      if (node.draggable()) {
        over = true
        break
      }
      node = node.getParent()
    }
    if (over !== hoverElement) setHoverElement(over)

    const pointer = stage?.getPointerPosition()
    if (!pointer) return
    const cur = useViewport.getState()
    const mx = (pointer.x - cur.x) / cur.scale
    const my = (pointer.y - cur.y) / cur.scale
    setCursor(mx, my, mx >= 0 && mx <= bed.width && my >= 0 && my <= bed.height)
  }

  const endPan = () => {
    pan.current.active = false
  }

  // Paper the pen can't reach (pen-offset shrinks the reachable area), as up-to-four strips.
  const region = drawableRegion(profile)
  const inaccessible = [
    { x: 0, y: 0, w: region.x0, h: bed.height },
    { x: region.x1, y: 0, w: bed.width - region.x1, h: bed.height },
    { x: region.x0, y: 0, w: region.x1 - region.x0, h: region.y0 },
    { x: region.x0, y: region.y1, w: region.x1 - region.x0, h: bed.height - region.y1 },
  ].filter((s) => s.w > 1e-3 && s.h > 1e-3)

  // Machine origin marker: at the configured corner, with +X (right) and +Y axis ticks. For a
  // bottom-left origin +Y points up the page; for top-left it points down. Sizes are screen px.
  const originPage = profile.origin === 'bottom-left' ? { x: 0, y: bed.height } : { x: 0, y: 0 }
  const yDir = profile.origin === 'bottom-left' ? -1 : 1
  const axis = 16 / scale

  return (
    <div
      ref={hostRef}
      className="relative min-h-0 flex-1 overflow-hidden bg-canvas"
      // Base cursor (Konva overrides this on its own resize/rotate anchors). Space → pan grab;
      // over a draggable element → move; otherwise crosshair for placement.
      style={{ cursor: spaceHeld ? 'grab' : hoverElement ? 'move' : 'crosshair' }}
    >
      {size.w > 0 && size.h > 0 && (
      <Stage
        width={size.w}
        height={size.h}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endPan}
        onMouseLeave={() => {
          endPan()
          clearCursor()
          setHoverElement(false)
        }}
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
          {inaccessible.map((s, i) => (
            <Rect
              key={`noreach-${i}`}
              x={s.x}
              y={s.y}
              width={s.w}
              height={s.h}
              fill="#9ca3af"
              opacity={0.28}
              listening={false}
            />
          ))}
          {elements.map((el) => (
            <ElementNode
              key={el.id}
              element={el}
              pxPerMm={scale}
              interactive={!previewActive && !spaceHeld}
            />
          ))}
          {previewActive && <PreviewLayer pxPerMm={scale} />}
          {/* Machine origin + axes (X red, Y green), screen-constant size. */}
          <Line
            points={[originPage.x, originPage.y, originPage.x + axis, originPage.y]}
            stroke="#ef4444"
            strokeWidth={1.5 / scale}
            listening={false}
          />
          <Line
            points={[originPage.x, originPage.y, originPage.x, originPage.y + axis * yDir]}
            stroke="#22c55e"
            strokeWidth={1.5 / scale}
            listening={false}
          />
          <Circle
            x={originPage.x}
            y={originPage.y}
            radius={3 / scale}
            fill="#18181b"
            listening={false}
          />
          {/* Konva keeps the Transformer's handles a constant screen size itself, so these are
            plain pixels — no manual /scale (that double-compensated and inverted with zoom). */}
          <Transformer
            ref={trRef}
            rotateEnabled
            ignoreStroke
            flipEnabled={false}
            anchorSize={10}
            anchorStrokeWidth={1}
            borderStrokeWidth={1}
            rotateAnchorOffset={24}
            padding={6}
            rotateAnchorCursor="grab"
          />
        </Layer>
      </Stage>
      )}
    </div>
  )
}
