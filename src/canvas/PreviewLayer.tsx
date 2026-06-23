// The preview overlay: draws the toolpath revealed up to the playhead distance. Ink (pen
// down) is stroked segment-by-segment with width ∝ pressure so line weight is visible; travel
// (pen up) is thin dashed gray. A turtle marker leads at the playhead — filled when the pen is
// down, hollow when up. Rendered inside the mm-scaled layer, so all coordinates/widths are mm.
import { Shape, Circle } from 'react-konva'
import type Konva from 'konva'
import { usePreview } from '../store/preview'
import { useDoc } from '../store/document'
import { sampleAt } from '../core/preview/toolpath'

const PEN_WIDTH_MM = 0.4

interface Props {
  pxPerMm: number
}

export function PreviewLayer({ pxPerMm }: Props) {
  const toolpath = usePreview((s) => s.toolpath)
  const dist = usePreview((s) => s.dist)
  const pens = useDoc((s) => s.profile.pens)
  if (!toolpath) return null

  const colorFor = (pen?: number) => pens.find((p) => p.id === pen)?.color ?? '#1a1a1a'

  const draw = (ctx: Konva.Context, shape: Konva.Shape) => {
    void shape
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (const m of toolpath.moves) {
      if (m.start > dist) break
      const avail = Math.min(m.len, dist - m.start)
      if (avail <= 0 && m.len > 0) continue

      if (m.kind === 'travel') {
        const a = m.pts[0]
        const b = m.pts[1]
        const t = m.len > 0 ? avail / m.len : 1
        ctx.save()
        ctx.setLineDash([1.4, 1.4])
        ctx.strokeStyle = '#c4c4c8'
        ctx.lineWidth = 0.12
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
        ctx.stroke()
        ctx.restore()
        continue
      }

      // Draw move: stroke each segment up to `avail`, width from average pressure.
      ctx.strokeStyle = colorFor(m.pen)
      let acc = 0
      for (let i = 1; i < m.pts.length; i++) {
        const a = m.pts[i - 1]
        const b = m.pts[i]
        const segLen = Math.hypot(b.x - a.x, b.y - a.y)
        let bx = b.x
        let by = b.y
        if (acc + segLen > avail) {
          const frac = segLen > 0 ? (avail - acc) / segLen : 0
          bx = a.x + (b.x - a.x) * frac
          by = a.y + (b.y - a.y) * frac
        }
        const pressure = (a.pressure + b.pressure) / 2
        ctx.lineWidth = PEN_WIDTH_MM * Math.max(pressure, 0.1)
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(bx, by)
        ctx.stroke()
        acc += segLen
        if (acc >= avail) break
      }
    }
  }

  const head = sampleAt(toolpath, dist)
  const r = 4 / pxPerMm // ~4px marker regardless of zoom

  return (
    <>
      <Shape sceneFunc={draw} listening={false} perfectDrawEnabled={false} />
      {head && (
        <Circle
          x={head.x}
          y={head.y}
          radius={head.penDown ? r * (0.6 + 0.8 * head.pressure) : r}
          fill={head.penDown ? '#2563eb' : '#ffffff'}
          stroke={head.penDown ? '#1e3a8a' : '#9ca3af'}
          strokeWidth={1 / pxPerMm}
          strokeScaleEnabled={false}
          listening={false}
        />
      )}
    </>
  )
}
