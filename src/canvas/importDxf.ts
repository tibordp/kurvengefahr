// DXF import: turn the Rust-parsed contours (mm geometry + per-entity colour) into native `path`
// elements. The parse + curve flattening is in Rust; here we only map colour → pen and drop the
// result on the page (one undo step). DXF is line art, so paths are imported outline-only (no hatch).
import { useDoc } from '../store/document'
import { importDxfRaw } from '../core/wasm/shapes'
import { nearestPen } from './importSvg'
import { cornerNode, type Contour, type PathParams } from '../elements/shapes'

export interface DxfImportOptions {
  /** Longest side, in mm, to scale the import into (DXF units are unreliable). */
  targetSize: number
  /** Map each entity colour to the nearest palette pen (else everything on pen 0). */
  colorToPen: boolean
  /** Chain segments that share endpoints into polylines, so a drawing exported as thousands of loose
   *  LINEs becomes a handful of paths instead of thousands of elements. */
  merge: boolean
  /** Name for the group the imported entities are collected under. */
  groupName?: string
}

export const defaultDxfImportOptions = (): DxfImportOptions => ({ targetSize: 150, colorToPen: true, merge: true })

/** Import a DXF's bytes as native path elements. Returns the number of elements created. */
export function addDxfElements(bytes: Uint8Array, opts: DxfImportOptions): number {
  const shapes = importDxfRaw(bytes, opts.targetSize, opts.merge)
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

  if (!specs.length) return 0
  const group = specs.length > 1 ? { name: opts.groupName || 'DXF import', collapsed: true } : undefined
  useDoc.getState().addElements(specs, group)
  return specs.length
}
