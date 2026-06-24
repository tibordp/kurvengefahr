// Live preview of the in-progress draft (see drawing.ts). Drawn in the mm-scaled layer with the
// raw 2D context, like PreviewLayer. Subscribes only to the draft store, so pointer-drag ticks
// don't re-render the canvas elements. Accent-coloured; anchor/handle dots are screen-constant.
import { Shape } from 'react-konva'
import type Konva from 'konva'
import { useDraft } from './drawing'

const ACCENT = '#e5484d'

export function DrawingPreview({ pxPerMm }: { pxPerMm: number }) {
  const draft = useDraft((s) => s.draft)
  if (!draft) return null

  const draw = (ctx: Konva.Context) => {
    ctx.save()
    ctx.strokeStyle = ACCENT
    ctx.fillStyle = ACCENT
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 0.3
    const dot = (x: number, y: number, r = 3 / pxPerMm) => {
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }

    if (draft.kind === 'box') {
      const { tool, a, b } = draft
      ctx.beginPath()
      if (tool === 'rect') {
        ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
      } else if (tool === 'ellipse') {
        ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2)
      } else {
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
      }
      ctx.stroke()
    } else if (draft.kind === 'pen' && draft.nodes.length) {
      const { nodes, cursor, dragging } = draft
      ctx.beginPath()
      ctx.moveTo(nodes[0].x, nodes[0].y)
      for (let i = 1; i < nodes.length; i++) {
        const p0 = nodes[i - 1]
        const p1 = nodes[i]
        ctx.bezierCurveTo(p0.x + p0.houtX, p0.y + p0.houtY, p1.x + p1.hinX, p1.y + p1.hinY, p1.x, p1.y)
      }
      if (!dragging) ctx.lineTo(cursor.x, cursor.y) // rubber-band to the cursor
      ctx.stroke()

      // handle lines (grey), then anchor (accent) + handle (grey) dots
      ctx.save()
      ctx.strokeStyle = '#9ca3af'
      ctx.lineWidth = 1 / pxPerMm
      for (const n of nodes) {
        if (n.houtX || n.houtY) {
          ctx.beginPath()
          ctx.moveTo(n.x, n.y)
          ctx.lineTo(n.x + n.houtX, n.y + n.houtY)
          ctx.stroke()
        }
        if (n.hinX || n.hinY) {
          ctx.beginPath()
          ctx.moveTo(n.x, n.y)
          ctx.lineTo(n.x + n.hinX, n.y + n.hinY)
          ctx.stroke()
        }
      }
      ctx.restore()
      for (const n of nodes) dot(n.x, n.y)
      // Close-cue: a ring on the first node when the cursor is over it (clicking closes the path).
      if (draft.closeHover && nodes.length) {
        ctx.strokeStyle = ACCENT
        ctx.lineWidth = 1.5 / pxPerMm
        ctx.beginPath()
        ctx.arc(nodes[0].x, nodes[0].y, 6 / pxPerMm, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.fillStyle = '#6b7280'
      for (const n of nodes) {
        if (n.houtX || n.houtY) dot(n.x + n.houtX, n.y + n.houtY, 2.2 / pxPerMm)
        if (n.hinX || n.hinY) dot(n.x + n.hinX, n.y + n.hinY, 2.2 / pxPerMm)
      }
    } else if (draft.kind === 'freehand' && draft.pts.length) {
      const pts = draft.pts
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.stroke()
    }
    ctx.restore()
  }

  return <Shape sceneFunc={draw} listening={false} perfectDrawEnabled={false} />
}
