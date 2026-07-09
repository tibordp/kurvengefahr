// The Logo turtle, drawn on the canvas at the program's end pose while its code editor is open —
// so a program can be grown iteratively by appending to the end (you always see where the next
// `fd` starts and which way it points). MSWLogo-style: a triangle cursor, apex forward, sized in
// page mm (it zooms with the drawing, like the ink), in a green no default pen uses so it reads
// as a cursor, not ink.
//
// The pose arrives as the generation worker's `meta` sidecar (element-local page mm + compass
// heading, see logoWorker.ts) and describes the *generated* strokes — while an edit's re-run is
// pending it trails the source briefly, exactly like the ink does.
import { Circle, Group, Line } from 'react-konva'
import { useDoc } from '../store/document'
import { useUI } from '../store/ui'
import { getGeneratedMeta } from '../core/generation'
import type { LogoPose } from '../core/wasm/logoWorker'
import { effectiveTransform, transformToMatrix } from '../core/pipeline/place'

const STROKE = '#059669' // emerald — distinct from ink and from the red selection accent
const FILL = 'rgba(16, 185, 129, 0.16)'

export function TurtleMarker({ pxPerMm }: { pxPerMm: number }) {
  const editingId = useUI((s) => s.codeDockFor)
  // Subscribe to the elements array so worker geometry bumps (which deliver a fresh pose) and
  // transform edits re-render the marker.
  const elements = useDoc((s) => s.elements)

  if (!editingId) return null
  const el = elements.find((e) => e.id === editingId)
  if (!el || el.type !== 'logo') return null
  const pose = getGeneratedMeta(el.id) as LogoPose | undefined
  if (!pose) return null

  // Element-local pose → page space through the full parent chain (rotation/scale/flips included):
  // the position maps as a point, the heading as a direction vector.
  const byId = new Map(elements.map((e) => [e.id, e]))
  const [a, b, c, d, e, f] = transformToMatrix(effectiveTransform(el, byId))
  const px = a * pose.x + c * pose.y + e
  const py = b * pose.x + d * pose.y + f
  const hr = (pose.heading * Math.PI) / 180
  const [lx, ly] = [Math.sin(hr), -Math.cos(hr)] // heading 0 = up in y-down local space
  const rotation = (Math.atan2(b * lx + d * ly, a * lx + c * ly) * 180) / Math.PI + 90

  // The triangle is in page mm (it zooms with the drawing). MSWLogo geometry: a right triangle
  // whose hypotenuse trails the pen — the right-angled apex points along the heading, and the
  // **pen is the hypotenuse's midpoint**, marked with a dot so the exact draw point is
  // unambiguous. Only the outline width stays screen-constant, like pen strokes do.
  return (
    <Group x={px} y={py} rotation={rotation} listening={false}>
      <Line
        points={[0, -4, -4, 0, 4, 0]}
        closed
        stroke={STROKE}
        strokeWidth={1.5 / pxPerMm}
        lineJoin="round"
        fill={FILL}
      />
      <Circle x={0} y={0} radius={0.7} fill={STROKE} />
    </Group>
  )
}
