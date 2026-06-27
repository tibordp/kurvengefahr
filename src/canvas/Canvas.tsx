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
import { useTools } from '../store/tools'
import { useViewport, useCursor } from '../store/viewport'
import { clampViewport, fitScale, MIN_SCALE, MAX_SCALE } from './viewport'
import { drawableRegion } from '../core/pipeline/clip'
import { ElementNode } from './ElementNode'
import { CanvasContextMenu, type CanvasMenuState } from './CanvasContextMenu'
import { PreviewLayer } from './PreviewLayer'
import { DrawingPreview } from './DrawingPreview'
import { NodeEditLayer } from './NodeEditLayer'
import { FiducialLayer } from './FiducialLayer'
import { SnapGrid } from './SnapLayer'
import { useSnap } from '../store/snap'
import {
  drawPointerDown,
  drawPointerMove,
  drawPointerUp,
  drawDblClick,
  drawKey,
  cancelDraft,
  finishPenPath,
  type Pt,
} from './drawing'
import { place, localToPage } from '../core/pipeline/place'
import { generateLocal } from '../elements/registry'
import { useNodeSelection, isNodeSelected, type NodeSel } from './nodeSelection'
import { useHover } from '../store/hover'
import type { PathParams } from '../elements/shapes'

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

export function Canvas() {
  const elements = useDoc((s) => s.elements)
  const profile = useDoc((s) => s.profile)
  const bed = profile.bed
  const selectedIds = useDoc((s) => s.selectedIds)
  const previewActive = usePreview((s) => s.active)
  const tool = useTools((s) => s.tool)
  const drawing = tool !== 'select' && !previewActive

  const scale = useViewport((s) => s.scale)
  const vx = useViewport((s) => s.x)
  const vy = useViewport((s) => s.y)
  const setViewport = useViewport((s) => s.setViewport)
  const setFit = useViewport((s) => s.setFit)
  const fitNonce = useViewport((s) => s.fitNonce)
  const setCursor = useCursor((s) => s.setCursor)
  const clearCursor = useCursor((s) => s.clear)

  const hostRef = useRef<HTMLDivElement>(null)
  const trRef = useRef<Konva.Transformer>(null)
  const pan = useRef({ active: false, lastX: 0, lastY: 0 })
  // Active pointers (by pointerId, client coords) — two of them drive a pinch zoom/pan gesture.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinch = useRef<{ startDist: number; startScale: number; mx: number; my: number } | null>(null)
  const fittedFor = useRef('')
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [shiftHeld, setShiftHeld] = useState(false)
  const [hoverElement, setHoverElement] = useState(false)
  const [marquee, setMarquee] = useState<{ a: Pt; b: Pt } | null>(null)
  const marqueeStart = useRef<Pt | null>(null)
  const [menu, setMenu] = useState<CanvasMenuState | null>(null)

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

  // Fit-to-view requests (from shortcuts / command palette). The Canvas owns the host size, so the
  // viewport store just bumps a nonce and we compute the framing here.
  useEffect(() => {
    if (!fitNonce || !size.w || !size.h) return
    const { fitMode } = useViewport.getState()
    const { elements, selectedIds } = useDoc.getState()
    const targets =
      fitMode === 'selection' ? elements.filter((e) => selectedIds.includes(e.id)) : elements
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const el of targets)
      for (const s of place(generateLocal(el), el.transform))
        for (const p of s.points) {
          if (p.x < x0) x0 = p.x
          if (p.y < y0) y0 = p.y
          if (p.x > x1) x1 = p.x
          if (p.y > y1) y1 = p.y
        }
    // Fit-all also includes the bed; an empty/selection-less request falls back to the bed.
    if (fitMode === 'all' || !Number.isFinite(x0)) {
      x0 = Math.min(Number.isFinite(x0) ? x0 : 0, 0)
      y0 = Math.min(Number.isFinite(y0) ? y0 : 0, 0)
      x1 = Math.max(Number.isFinite(x1) ? x1 : bed.width, bed.width)
      y1 = Math.max(Number.isFinite(y1) ? y1 : bed.height, bed.height)
    }
    const bw = Math.max(1, x1 - x0)
    const bh = Math.max(1, y1 - y0)
    const scale = clamp(Math.min(size.w / bw, size.h / bh) * 0.92, MIN_SCALE, MAX_SCALE)
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    setViewport(
      clampViewport({ scale, x: size.w / 2 - scale * cx, y: size.h / 2 - scale * cy }, size.w, size.h, bed.width, bed.height),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitNonce])

  // Track Space for pan mode (ignored while typing).
  useEffect(() => {
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    }
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftHeld(true)
      if (e.code === 'Space' && !typing(e.target)) {
        setSpaceHeld(true)
        e.preventDefault()
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftHeld(false)
      if (e.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // A lone selected path is edited via the node overlay (NodeEditLayer), not the bounding-box
  // Transformer; everything else (incl. multi-selection) uses the Transformer for group transforms.
  const solePath =
    selectedIds.length === 1 && elements.find((e) => e.id === selectedIds[0])?.type === 'path'
  const showTransformer = selectedIds.length > 0 && !previewActive && !drawing && !solePath

  useEffect(() => {
    const tr = trRef.current
    const stage = tr?.getStage()
    if (!tr || !stage) return
    const nodes = showTransformer
      ? (selectedIds.map((id) => stage.findOne('#' + id)).filter(Boolean) as Konva.Node[])
      : []
    tr.nodes(nodes)
    tr.getLayer()?.batchDraw()
  }, [selectedIds, elements, showTransformer, scale, vx, vy])

  // Drawing keyboard: Enter finishes a pen path, Esc cancels the draft / returns to Select.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (drawKey(e)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Switching tools mid-draft abandons the draft.
  useEffect(() => {
    cancelDraft()
  }, [tool])

  // Finalize an in-progress drag even if the pointer is released outside the stage (e.g. freehand),
  // and keep the pointer/pinch bookkeeping clean when a release/cancel misses the stage.
  useEffect(() => {
    const up = (e: PointerEvent) => {
      pointers.current.delete(e.pointerId)
      if (pointers.current.size < 2) pinch.current = null
      drawPointerUp()
    }
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])

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

  /** Pointer position in page-mm, or null. */
  const pointerMM = (stage: Konva.Stage | null) => {
    const pointer = stage?.getPointerPosition()
    if (!pointer) return null
    const cur = useViewport.getState()
    return { x: (pointer.x - cur.x) / cur.scale, y: (pointer.y - cur.y) / cur.scale }
  }

  // --- Two-finger pinch: zoom toward the gesture midpoint while panning with it (touch's wheel +
  // space-drag). Coordinates are stage-relative px (client minus the host's top-left).
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
      mx: (mid.x - cur.x) / cur.scale, // page-mm point anchored under the start midpoint
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
    setViewport(
      clampViewport(
        { scale: next, x: mid.x - pc.mx * next, y: mid.y - pc.my * next },
        size.w,
        size.h,
        bed.width,
        bed.height,
      ),
    )
  }

  // Right-click: open the context menu (acting on the element under the cursor, or the background).
  // The element's own mousedown has already resolved selection, so we just read it.
  const onContextMenu = (e: KonvaEventObject<MouseEvent>) => {
    e.evt.preventDefault()
    // Mid-pen-path, right-click finishes it open (no extra node) — the only way to get a two-node
    // curved segment. (The right-click's pointerdown is already ignored, so no node was added.)
    if (drawing) {
      finishPenPath()
      return
    }
    if (previewActive) return
    const stage = e.target.getStage()
    // Walk up from the hit node to the owning element Group (its id is the element id).
    const ids = new Set(useDoc.getState().elements.map((el) => el.id))
    let node: Konva.Node | null = e.target
    let targetId: string | null = null
    while (node && node !== stage) {
      const nid = node.id()
      if (nid && ids.has(nid)) {
        targetId = nid
        break
      }
      node = node.getParent()
    }
    if (targetId && !useDoc.getState().selectedIds.includes(targetId)) {
      useDoc.getState().select(targetId, false)
    }
    const p = pointerMM(stage) ?? { x: 0, y: 0 }
    setMenu({ x: e.evt.clientX, y: e.evt.clientY, page: p, targetId })
  }

  const onPointerDown = (e: KonvaEventObject<PointerEvent>) => {
    pointers.current.set(e.evt.pointerId, { x: e.evt.clientX, y: e.evt.clientY })
    // Second finger down → switch to a pinch gesture, abandoning any single-pointer interaction.
    if (pointers.current.size >= 2) {
      pan.current.active = false
      marqueeStart.current = null
      setMarquee(null)
      cancelDraft()
      beginPinch()
      return
    }
    if (e.evt.button === 2) return // right-click → handled by onContextMenu (no marquee/pan)
    if (spaceHeld || e.evt.button === 1) {
      pan.current = { active: true, lastX: e.evt.clientX, lastY: e.evt.clientY }
      e.evt.preventDefault()
      return
    }
    if (drawing && e.evt.button === 0) {
      const p = pointerMM(e.target.getStage())
      if (p) drawPointerDown(p, { scale: useViewport.getState().scale, alt: e.evt.altKey })
      return
    }
    // Empty canvas (stage or bed) → start a marquee selection (resolved on mouse-up).
    if (e.target === e.target.getStage() || e.target.name() === 'bed') {
      const p = pointerMM(e.target.getStage())
      if (p) {
        marqueeStart.current = p
        setMarquee({ a: p, b: p })
      }
    }
  }

  const onPointerMove = (e: KonvaEventObject<PointerEvent>) => {
    const stage = e.target.getStage()
    if (pointers.current.has(e.evt.pointerId))
      pointers.current.set(e.evt.pointerId, { x: e.evt.clientX, y: e.evt.clientY })
    if (pinch.current && pointers.current.size >= 2) {
      updatePinch()
      return
    }
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

    const p = pointerMM(stage)
    if (!p) return
    setCursor(p.x, p.y, p.x >= 0 && p.x <= bed.width && p.y >= 0 && p.y <= bed.height)
    if (drawing) {
      drawPointerMove(p, { scale, shift: e.evt.shiftKey, alt: e.evt.altKey })
      return
    }
    if (marqueeStart.current) {
      setMarquee({ a: marqueeStart.current, b: p })
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
  }

  const onPointerUp = (e: KonvaEventObject<PointerEvent>) => {
    pointers.current.delete(e.evt.pointerId)
    // Ending (or stepping down out of) a pinch: don't fall through to marquee/draw resolution.
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = null
      return
    }
    pan.current.active = false
    if (drawing) {
      drawPointerUp()
      return
    }
    const start = marqueeStart.current
    if (start && marquee) {
      const x0 = Math.min(marquee.a.x, marquee.b.x)
      const x1 = Math.max(marquee.a.x, marquee.b.x)
      const y0 = Math.min(marquee.a.y, marquee.b.y)
      const y1 = Math.max(marquee.a.y, marquee.b.y)
      const tiny = x1 - x0 < 2 / scale && y1 - y0 < 2 / scale
      const doc = useDoc.getState()
      const editEl = solePath ? doc.elements.find((el) => el.id === doc.selectedIds[0]) : undefined

      if (editEl && editEl.type === 'path') {
        // Node-edit mode: the marquee rubber-bands this path's control points, not elements.
        if (tiny) {
          // Click on empty: clear the node selection if any, else exit node editing.
          if (useNodeSelection.getState().sels.length) useNodeSelection.getState().set([])
          else doc.clearSelection()
        } else {
          const picks: NodeSel[] = []
          ;(editEl.params as PathParams).contours.forEach((c, ci) =>
            c.nodes.forEach((n, ni) => {
              const pg = localToPage(editEl.transform, n.x, n.y)
              if (pg.x >= x0 && pg.x <= x1 && pg.y >= y0 && pg.y <= y1)
                picks.push({ elementId: editEl.id, ci, ni })
            }),
          )
          if (e.evt.shiftKey) {
            const merged = [...useNodeSelection.getState().sels]
            for (const pk of picks)
              if (!isNodeSelected(merged, pk.elementId, pk.ci, pk.ni)) merged.push(pk)
            useNodeSelection.getState().set(merged)
          } else {
            useNodeSelection.getState().set(picks)
          }
        }
      } else if (tiny) {
        doc.clearSelection() // a click on empty space → deselect
      } else {
        const ids: string[] = []
        for (const el of doc.elements) {
          let bx0 = Infinity
          let by0 = Infinity
          let bx1 = -Infinity
          let by1 = -Infinity
          for (const s of place(generateLocal(el), el.transform))
            for (const pt of s.points) {
              if (pt.x < bx0) bx0 = pt.x
              if (pt.y < by0) by0 = pt.y
              if (pt.x > bx1) bx1 = pt.x
              if (pt.y > by1) by1 = pt.y
            }
          if (Number.isFinite(bx0) && bx0 <= x1 && bx1 >= x0 && by0 <= y1 && by1 >= y0) ids.push(el.id)
        }
        doc.selectMany(ids)
      }
      marqueeStart.current = null
      setMarquee(null)
    }
  }
  const endPan = () => {
    pan.current.active = false
    marqueeStart.current = null
    setMarquee(null)
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
      // touch-action: none so the browser yields all touch gestures to us (draw + pinch zoom/pan).
      style={{ cursor: spaceHeld ? 'grab' : hoverElement ? 'move' : 'crosshair', touchAction: 'none' }}
    >
      {size.w > 0 && size.h > 0 && (
      <Stage
        width={size.w}
        height={size.h}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
        onDblClick={() => drawing && drawDblClick(6 / scale)}
        onDblTap={() => drawing && drawDblClick(6 / scale)}
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
          <SnapGrid />
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
              interactive={!previewActive && !spaceHeld && !drawing}
            />
          ))}
          {previewActive && <PreviewLayer pxPerMm={scale} />}
          {drawing && <DrawingPreview pxPerMm={scale} />}
          {!previewActive && !drawing && <NodeEditLayer pxPerMm={scale} />}
          {!previewActive && !drawing && <HoverHighlight pxPerMm={scale} />}
          <FiducialLayer pxPerMm={scale} interactive={!previewActive && !spaceHeld && !drawing} />
          {marquee && (
            <Rect
              x={Math.min(marquee.a.x, marquee.b.x)}
              y={Math.min(marquee.a.y, marquee.b.y)}
              width={Math.abs(marquee.b.x - marquee.a.x)}
              height={Math.abs(marquee.b.y - marquee.a.y)}
              fill="rgba(229,72,77,0.12)"
              stroke="#e5484d"
              strokeWidth={1 / scale}
              dash={[4 / scale, 3 / scale]}
              listening={false}
            />
          )}
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
            // Corner drag is free aspect by default; holding Shift keeps the ratio (Konva built-in).
            keepRatio={false}
            // Rotation is free; holding Shift snaps it to 45° increments.
            rotationSnaps={shiftHeld ? [0, 45, 90, 135, 180, 225, 270, 315] : []}
            rotationSnapTolerance={23}
            // Snap resize to the grid: boundBox is in absolute (screen) coords; convert each moved
            // edge to mm, round to the grid step, convert back. Skipped when rotated or grid is off.
            boundBoxFunc={(oldBox, newBox) => {
              const s = useSnap.getState()
              if (!s.grid || s.gridSize <= 0 || Math.abs(newBox.rotation) > 1e-3) return newBox
              const g = s.gridSize
              const snapMM = (v: number) => Math.round(v / g) * g
              const eps = 0.01

              // Aspect-locked resize (Shift on a corner → Konva scales both dimensions together):
              // snapping each edge independently breaks the ratio. Instead snap whichever dimension
              // sits closer to the grid and derive the other from the ratio, keeping the dragged
              // corner's opposite corner fixed. Only when both dims actually changed (i.e. a corner).
              const wChanged = Math.abs(newBox.width - oldBox.width) > eps
              const hChanged = Math.abs(newBox.height - oldBox.height) > eps
              if (shiftHeld && wChanged && hChanged) {
                const wmm = newBox.width / scale
                const hmm = newBox.height / scale
                const sw = Math.max(snapMM(wmm), g)
                const sh = Math.max(snapMM(hmm), g)
                // Snap the dimension with the smaller relative adjustment; derive the other.
                let nw: number, nh: number
                if (Math.abs(sw - wmm) / wmm <= Math.abs(sh - hmm) / hmm) {
                  nw = sw
                  nh = sw * (hmm / wmm)
                } else {
                  nh = sh
                  nw = sh * (wmm / hmm)
                }
                const pw = nw * scale
                const ph = nh * scale
                const movedLeft = Math.abs(newBox.x - oldBox.x) > eps
                const movedTop = Math.abs(newBox.y - oldBox.y) > eps
                const x = movedLeft ? newBox.x + newBox.width - pw : newBox.x
                const y = movedTop ? newBox.y + newBox.height - ph : newBox.y
                return { ...newBox, x, y, width: pw, height: ph }
              }

              const mm = (px: number, off: number) => (px - off) / scale
              const px = (v: number, off: number) => v * scale + off
              let left = newBox.x
              let top = newBox.y
              let right = newBox.x + newBox.width
              let bottom = newBox.y + newBox.height
              if (Math.abs(left - oldBox.x) > eps) left = px(snapMM(mm(left, vx)), vx)
              if (Math.abs(right - (oldBox.x + oldBox.width)) > eps) right = px(snapMM(mm(right, vx)), vx)
              if (Math.abs(top - oldBox.y) > eps) top = px(snapMM(mm(top, vy)), vy)
              if (Math.abs(bottom - (oldBox.y + oldBox.height)) > eps) bottom = px(snapMM(mm(bottom, vy)), vy)
              return { ...newBox, x: left, y: top, width: Math.max(right - left, 1), height: Math.max(bottom - top, 1) }
            }}
          />
        </Layer>
      </Stage>
      )}
      {menu && <CanvasContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** A dashed accent outline around the element hovered in the Elements tree, so it's obvious which
 *  row maps to which mark on the canvas. Skipped when the element is already selected (the
 *  Transformer covers it). Coordinates are page-mm inside the scaled Layer. */
function HoverHighlight({ pxPerMm }: { pxPerMm: number }) {
  const id = useHover((s) => s.id)
  const el = useDoc((s) => (id ? (s.elements.find((e) => e.id === id) ?? null) : null))
  const selected = useDoc((s) => (id ? s.selectedIds.includes(id) : false))
  if (!el || selected) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const s of place(generateLocal(el), el.transform))
    for (const p of s.points) {
      if (p.x < x0) x0 = p.x
      if (p.y < y0) y0 = p.y
      if (p.x > x1) x1 = p.x
      if (p.y > y1) y1 = p.y
    }
  if (!Number.isFinite(x0)) return null
  const pad = 1.5 / pxPerMm
  return (
    <Rect
      x={x0 - pad}
      y={y0 - pad}
      width={x1 - x0 + 2 * pad}
      height={y1 - y0 + 2 * pad}
      stroke="#e5484d"
      strokeWidth={1.5 / pxPerMm}
      dash={[4 / pxPerMm, 3 / pxPerMm]}
      cornerRadius={2 / pxPerMm}
      listening={false}
    />
  )
}
