// The document's alignment fiducial: a draggable crosshair/target at its page-space point. Not an
// element — it makes no ink — so it lives as a top-level doc property and renders here on its own.
// Marker geometry is screen-constant (divided by px-per-mm, like the origin marker), so it stays a
// fixed size at any zoom. Dragging moves it (grid-snapped); the inspector edits X/Y / removes it.
import { Group, Circle, Line } from 'react-konva'
import { useDoc } from '../store/document'
import { snap } from './snap'

const ACCENT = '#E5484D'

export function FiducialLayer({ pxPerMm, interactive }: { pxPerMm: number; interactive: boolean }) {
  const fiducial = useDoc((s) => s.fiducial)
  const setFiducial = useDoc((s) => s.setFiducial)
  if (!fiducial) return null

  const ring = 6 / pxPerMm // ring radius (mm at this zoom)
  const arm = 11 / pxPerMm // crosshair arm reach
  const sw = 1.5 / pxPerMm

  return (
    <Group
      x={fiducial.x}
      y={fiducial.y}
      draggable={interactive}
      listening={interactive}
      opacity={interactive ? 1 : 0.4}
      onDragMove={(e) => {
        const sp = snap({ x: e.target.x(), y: e.target.y() }, !!e.evt.altKey)
        e.target.position(sp)
        setFiducial(sp)
      }}
      onDragEnd={(e) => setFiducial({ x: e.target.x(), y: e.target.y() })}
    >
      {/* Invisible grab disc (thin strokes are hard to hit). */}
      <Circle radius={arm} fill="#000" opacity={0} />
      <Circle radius={ring} stroke={ACCENT} strokeWidth={sw} />
      <Circle radius={ring * 0.16} fill={ACCENT} />
      <Line points={[-arm, 0, -ring * 0.5, 0]} stroke={ACCENT} strokeWidth={sw} />
      <Line points={[ring * 0.5, 0, arm, 0]} stroke={ACCENT} strokeWidth={sw} />
      <Line points={[0, -arm, 0, -ring * 0.5]} stroke={ACCENT} strokeWidth={sw} />
      <Line points={[0, ring * 0.5, 0, arm]} stroke={ACCENT} strokeWidth={sw} />
    </Group>
  )
}
