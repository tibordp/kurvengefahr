// DXF import: turn the Rust-parsed contours (mm geometry + per-entity colour) into native `path`
// elements. The parse + curve flattening is in Rust; here we only map colour → pen and drop the
// result on the page (one undo step). DXF is line art, so paths are imported outline-only (no hatch).
import { useDoc } from '../store/document'
import { importDxfRaw } from '../core/wasm/shapes'
import { nearestPen, mergePathSpecsByPen } from './importSvg'
import { cornerNode, type Contour, type PathParams } from '../elements/shapes'

/** Selectable units → millimetres per unit. DXF carries real dimensions; we import at actual size. */
export const DXF_UNITS = [
  { key: 'mm', label: 'Millimeters', mm: 1 },
  { key: 'cm', label: 'Centimeters', mm: 10 },
  { key: 'm', label: 'Meters', mm: 1000 },
  { key: 'in', label: 'Inches', mm: 25.4 },
  { key: 'ft', label: 'Feet', mm: 304.8 },
] as const
export type DxfUnit = (typeof DXF_UNITS)[number]['key']

/** Map a `$INSUNITS` header code to one of our selectable units (others → millimetres). */
export function unitFromInsunits(insunits: number): DxfUnit {
  const m: Record<number, DxfUnit> = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' }
  return m[insunits] ?? 'mm'
}

export const unitScaleFor = (u: DxfUnit): number => DXF_UNITS.find((d) => d.key === u)!.mm

export interface DxfImportOptions {
  /** Millimetres per DXF unit — imports at actual size. */
  unitScale: number
  /** Map each entity colour to the nearest palette pen (else everything on pen 0). */
  colorToPen: boolean
  /** Chain segments that share endpoints into polylines, so a drawing exported as thousands of loose
   *  LINEs becomes a handful of paths instead of thousands of elements. */
  merge: boolean
  /** Name for the group the imported entities are collected under. */
  groupName?: string
}

export const defaultDxfImportOptions = (): DxfImportOptions => ({ unitScale: 1, colorToPen: true, merge: true })

/** Import a DXF's bytes as native path elements. Returns the number of elements created. */
export function addDxfElements(bytes: Uint8Array, opts: DxfImportOptions): number {
  const { shapes } = importDxfRaw(bytes, opts.unitScale, opts.merge)
  if (!shapes.length) return 0
  const profile = useDoc.getState().profile

  // Overall bounds (mm), to centre the import on the bed.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of shapes)
    for (const ring of s.rings)
      for (const p of ring.points) {
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
        if (p.x > maxX) maxX = p.x
        if (p.y > maxY) maxY = p.y
      }
  if (!Number.isFinite(minX)) return 0
  const offX = profile.bed.width / 2 - (minX + maxX) / 2
  const offY = profile.bed.height / 2 - (minY + maxY) / 2

  const specs = shapes
    .map((s) => {
      const contours: Contour[] = s.rings
        .map((ring) => ({
          nodes: ring.points.map((p) => cornerNode(p.x + offX, p.y + offY)),
          closed: ring.closed,
        }))
        .filter((c) => c.nodes.length >= 2)
      if (!contours.length) return null
      const params: PathParams = { contours, hatch: { pattern: 'none', spacing: 1, angle: 45, stroke: true } }
      return { type: 'path', params, pen: opts.colorToPen ? nearestPen(s.rgb, profile) : 0 }
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)

  // DXF is line art — collapse to one compound path per pen.
  const merged = mergePathSpecsByPen(specs)
  if (!merged.length) return 0
  const group = merged.length > 1 ? { name: opts.groupName || 'DXF import', collapsed: true } : undefined
  useDoc.getState().addElements(merged, group)
  return merged.length
}
