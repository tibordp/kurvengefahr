// A faint dot grid over the bed when grid-snap is on, drawn in the mm-scaled layer.
import { Shape } from 'react-konva'
import type Konva from 'konva'
import { useSnap } from '../store/snap'
import { useDoc } from '../store/document'

const MAX_DOTS = 6000 // skip the grid if it'd be absurdly dense (snapping still works)

export function SnapGrid() {
  const grid = useSnap((s) => s.grid)
  const gridSize = useSnap((s) => s.gridSize)
  const bed = useDoc((s) => s.profile.bed)
  if (!grid || gridSize <= 0) return null
  if ((bed.width / gridSize + 1) * (bed.height / gridSize + 1) > MAX_DOTS) return null

  const draw = (ctx: Konva.Context) => {
    ctx.fillStyle = '#c4c4c8'
    for (let x = 0; x <= bed.width + 1e-6; x += gridSize)
      for (let y = 0; y <= bed.height + 1e-6; y += gridSize) {
        ctx.beginPath()
        ctx.arc(x, y, 0.35, 0, Math.PI * 2)
        ctx.fill()
      }
  }
  return <Shape sceneFunc={draw} listening={false} perfectDrawEnabled={false} />
}
