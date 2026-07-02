// Fill (hatch) controls shared by all closed shapes.
import { SectionTitle, Field, controlClass } from '../primitives'
import { Num } from './controls'
import type { Hatch, HatchPattern } from '../../elements/shapes'

/** The three valid stroke/fill combinations (never both off → no marks). */
type FillStyle = 'stroke' | 'both' | 'fill'
const fillStyle = (h: Hatch): FillStyle =>
  h.pattern === 'none' ? 'stroke' : h.stroke ? 'both' : 'fill'

/** Fill (hatch) controls shared by all closed shapes. Style picks stroke / stroke+fill / fill;
 *  "neither" is unrepresentable. */
export function HatchControls({ hatch, onChange }: { hatch: Hatch; onChange: (h: Hatch) => void }) {
  const set = (patch: Partial<Hatch>) => onChange({ ...hatch, ...patch })
  const style = fillStyle(hatch)
  const setStyle = (s: FillStyle) => {
    if (s === 'stroke') return set({ stroke: true, pattern: 'none' })
    // Entering a fill style needs a real pattern; revive 'lines' if there isn't one.
    set({ stroke: s === 'both', pattern: hatch.pattern === 'none' ? 'lines' : hatch.pattern })
  }
  return (
    <>
      <SectionTitle>Fill</SectionTitle>
      <Field label="Style">
        <select className={controlClass} value={style} onChange={(e) => setStyle(e.target.value as FillStyle)}>
          <option value="stroke">Stroke</option>
          <option value="both">Stroke + Fill</option>
          <option value="fill">Fill</option>
        </select>
      </Field>
      {style !== 'stroke' && (
        <>
          <Field label="Pattern">
            <select
              className={controlClass}
              value={hatch.pattern}
              onChange={(e) => set({ pattern: e.target.value as HatchPattern })}
            >
              <option value="lines">Lines</option>
              <option value="cross">Cross-hatch</option>
              <option value="grid">Grid</option>
              <option value="concentric">Concentric</option>
              <option value="hilbert">Hilbert curve</option>
              <option value="gradient">Gradient hatch</option>
              <option value="scribble">Scribble</option>
              <option value="stipple">Stipple (dots)</option>
              <option value="voronoi">Voronoi</option>
              <option value="truchet">Truchet tiles</option>
              <option value="spiral">Spiral</option>
              <option value="maze">Maze</option>
            </select>
          </Field>
          <Num label="Density (mm)" value={hatch.spacing} step={0.5}
            onChange={(v) => set({ spacing: Math.max(0.3, v) })} />
          {(hatch.pattern === 'lines' || hatch.pattern === 'cross') && (
            <Num label="Angle (°)" value={hatch.angle} step={5} onChange={(v) => set({ angle: v })} />
          )}
        </>
      )}
    </>
  )
}
