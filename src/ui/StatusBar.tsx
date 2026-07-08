// Status bar under the canvas: live cursor position and zoom, in MACHINE coordinates so the
// readout's origin follows the profile's `origin` setting (e.g. bottom-left → Y measured from
// the bottom). Pen = the pen's machine position; Nozzle = pen − offset = the literal commanded
// G-code, shown only when the pen is offset from the nozzle in X/Y.
import { useCursor, useViewport } from '../store/viewport'
import { useDoc } from '../store/document'
import { useSnap } from '../store/snap'
import { toMachine } from '../core/pipeline/toMachine'
import { penOffsetOf } from '../core/types'

const fmt = (v: number) => v.toFixed(1)

export function StatusBar() {
  const x = useCursor((s) => s.x)
  const y = useCursor((s) => s.y)
  const inside = useCursor((s) => s.inside)
  const scale = useViewport((s) => s.scale)
  const fit = useViewport((s) => s.fit)
  const profile = useDoc((s) => s.profile)
  const offset = penOffsetOf(profile)

  const hasOffset = offset.x !== 0 || offset.y !== 0
  const pen = toMachine({ x, y }, profile) // page → machine (origin-aware)
  const coords = (cx: number, cy: number) =>
    inside ? `X ${fmt(cx)}  Y ${fmt(cy)} mm` : 'X —  Y —'

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 py-1 text-xs text-muted">
      <span>
        <strong className="mr-1.5 font-semibold text-text">Pen</strong>
        <span className="font-mono tabular-nums">{coords(pen.x, pen.y)}</span>
      </span>
      {hasOffset && (
        <>
          <span className="h-3.5 w-px bg-border" aria-hidden />
          <span>
            <strong className="mr-1.5 font-semibold text-text">Nozzle</strong>
            <span className="font-mono tabular-nums">
              {coords(pen.x - offset.x, pen.y - offset.y)}
            </span>
          </span>
        </>
      )}
      <span className="flex-1" />
      <SnapControl />
      <span className="h-3.5 w-px bg-border" aria-hidden />
      <span className="font-mono tabular-nums" title="Zoom level" aria-label="Zoom level">
        {Math.round((scale / fit) * 100)}%
      </span>
    </div>
  )
}

function SnapControl() {
  const grid = useSnap((s) => s.grid)
  const gridSize = useSnap((s) => s.gridSize)
  const s = useSnap.getState()
  return (
    <span className="flex items-center gap-2" title="Snap to grid — hold Alt to bypass">
      <label className="flex items-center gap-1">
        <input type="checkbox" className="h-3.5 w-3.5" checked={grid} onChange={(e) => s.setGrid(e.target.checked)} />
        Grid
      </label>
      <input
        type="number"
        value={gridSize}
        min={0.5}
        step={0.5}
        onChange={(e) => s.setGridSize(parseFloat(e.target.value) || 1)}
        className="w-12 rounded border border-border bg-surface px-1 py-0.5 text-xs tabular-nums"
        title="Grid size (mm)"
        aria-label="Grid size in millimetres"
      />
    </span>
  )
}
