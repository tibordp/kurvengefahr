// SVG import: turn the Rust-parsed shapes (mm geometry + source colour + fill darkness) into native
// `path` elements. The heavy lifting (parse, flatten, occlusion boolean) is in Rust; here we only
// map paint → pen, fill darkness → hatch density, and drop the result onto the page (one undo step).
import { useDoc } from '../store/document'
import { importSvgRaw, type SvgImportShape } from '../core/wasm/shapes'
import { cornerNode, type Contour, type Hatch, type HatchPattern, type PathParams } from '../elements/shapes'
import type { MachineProfile } from '../core/types'

/** usvg resolves physical units to px at this dpi, so px → mm for a physical SVG is 25.4/96. */
export const USVG_DPI = 96
export const MM_PER_IN = 25.4

/** Does the SVG declare a physical size (mm/cm/in/pt/pc) rather than pixels/user-units? Sniffed from
 *  the root `<svg width="…">` so the import dialog can offer true 1:1 (no DPI needed). */
export function svgIsPhysical(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.slice(0, 4096))
  const m = head.match(/<svg\b[^>]*?\bwidth\s*=\s*["']\s*[\d.]+\s*(mm|cm|in|pt|pc)\s*["']/i)
  return !!m
}

export interface SvgImportOptions {
  /** Subtract upper filled shapes from those beneath so hidden areas don't plot. */
  occlude: boolean
  /** Longest side, in mm, to scale the import into (when `pxToMm` is 0). */
  targetSize: number
  /** Millimetres per usvg px for 1:1 import; `0` = fit to `targetSize`. */
  pxToMm: number
  /** Hatch pattern for filled shapes (`'none'` = import the outline only). */
  fillStyle: HatchPattern
  /** Base hatch spacing (mm) — the densest, used for a fully black fill. */
  density: number
  /** Scale hatch spacing by each fill's darkness (lighter → sparser). */
  mapDensity: boolean
  /** Map each source colour to the nearest palette pen (else everything on pen 0). */
  colorToPen: boolean
  /** Name for the group the imported shapes are collected under (so the tree stays tidy). */
  groupName?: string
}

export const defaultSvgImportOptions = (): SvgImportOptions => ({
  occlude: true,
  targetSize: 150,
  pxToMm: 0,
  fillStyle: 'lines',
  density: 0.8,
  mapDensity: true,
  colorToPen: true,
})

function hexRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '')
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const v = parseInt(n, 16)
  return Number.isFinite(v) ? { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff } : { r: 0, g: 0, b: 0 }
}

/** Nearest palette pen to a packed 0xRRGGBB colour, by squared RGB distance. Returns its pen id. */
export function nearestPen(rgb: number, profile: MachineProfile): number {
  const r = (rgb >> 16) & 0xff
  const g = (rgb >> 8) & 0xff
  const b = rgb & 0xff
  let bestId = profile.pens[0]?.id ?? 0
  let bestD = Infinity
  for (const pen of profile.pens) {
    const c = hexRgb(pen.color)
    const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2
    if (d < bestD) {
      bestD = d
      bestId = pen.id
    }
  }
  return bestId
}

function hatchFor(shape: SvgImportShape, opts: SvgImportOptions): Hatch {
  // Stroke centreline, or a fill imported "outline only" → just draw the outline.
  if (shape.kind !== 0 || opts.fillStyle === 'none') {
    return { pattern: 'none', spacing: Math.max(0.3, opts.density), angle: 45, stroke: true }
  }
  const d = Math.min(1, Math.max(0.12, shape.darkness)) // clamp so near-white isn't absurdly sparse
  const spacing = opts.mapDensity ? opts.density / d : opts.density
  return { pattern: opts.fillStyle, spacing: Math.max(0.3, spacing), angle: 45, stroke: true }
}

/** Collapse stroke-only path specs (`hatch === 'none'`) into one multi-contour path per pen, so a
 *  line-art import becomes a few editable compound paths instead of hundreds of elements. Filled
 *  shapes are left alone — merging them would let even-odd punch holes where they overlap. */
export function mergePathSpecsByPen<T extends { type: string; params: PathParams; pen: number }>(specs: T[]): T[] {
  const out: T[] = []
  const byPen = new Map<number, { spec: T; contours: Contour[] }>()
  for (const s of specs) {
    if (s.params.hatch.pattern === 'none') {
      const g = byPen.get(s.pen)
      if (g) g.contours.push(...s.params.contours)
      else byPen.set(s.pen, { spec: s, contours: [...s.params.contours] })
    } else {
      out.push(s)
    }
  }
  for (const { spec, contours } of byPen.values()) out.push({ ...spec, params: { ...spec.params, contours } })
  return out
}

/** Import an SVG's bytes as native path elements. Returns the number of elements created. */
export function addSvgElements(bytes: Uint8Array, opts: SvgImportOptions): number {
  const shapes = importSvgRaw(bytes, opts.occlude, opts.targetSize, opts.pxToMm)
  if (!shapes.length) return 0
  const profile = useDoc.getState().profile

  // Overall bounds (mm, SVG origin), to centre the import on the bed.
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
          closed: s.kind === 0 ? true : ring.closed,
        }))
        .filter((c) => c.nodes.length >= 2)
      if (!contours.length) return null
      const params: PathParams = { contours, hatch: hatchFor(s, opts) }
      return { type: 'path', params, pen: opts.colorToPen ? nearestPen(s.rgb, profile) : 0 }
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)

  // Stroke-only shapes collapse to one compound path per pen (fills stay individual).
  const merged = mergePathSpecsByPen(specs)
  if (!merged.length) return 0
  // Collect the import into one collapsed group so a busy SVG doesn't flood the elements tree.
  const group = merged.length > 1 ? { name: opts.groupName || 'SVG import' } : undefined
  useDoc.getState().addElements(merged, group)
  return merged.length
}
