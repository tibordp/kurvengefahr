// Export the document as vector SVG or raster PNG — the same plottable geometry the G-code is built
// from (so it round-trips and lets you eyeball exactly what will plot), in page mm on the bed. The
// SVG is layered for editing elsewhere: element → part (tone band) → pen (see buildSvgMarkup).
// The shared helpers (plottable / byPen / pressureVaries) also feed the PDF export and true-scale
// printing (exportPdf.ts, print.ts).
import { useDoc } from '../store/document'
import { useDocuments } from '../store/documents'
import { buildPlottableGeometry, buildPlottableGeometryByElement } from '../core/pipeline'
import { elementLabel, partLabel } from '../elements/registry'
import { downloadBlob, safeFilename } from './download'
import { pressureEnabled, type Geometry, type Stroke } from '../core/types'
import { displayPenWidthMm } from '../canvas/penWidth'

/** Nominal pen-tip width (mm) used for the rendered stroke width — matches the canvas. */
const PEN_WIDTH_MM = 0.4

export interface Plottable {
  geom: Geometry
  bed: { width: number; height: number }
  penColor: (p: number) => string
  /** Profile maps pressure to line weight — render pressure as varying width, matching canvas/preview. */
  pressureOn: boolean
}

export function plottable(): Plottable {
  const { elements, profile } = useDoc.getState()
  const geom = buildPlottableGeometry(elements, profile)
  const penColor = (pen: number) => profile.pens.find((p) => p.id === pen)?.color ?? '#1a1a1a'
  return { geom, bed: profile.bed, penColor, pressureOn: pressureEnabled(profile) }
}

export const docName = () => safeFilename(useDocuments.getState().activeName, 'kurvengefahr')

const PRESSURE_EPS = 1e-3
/** Whether a stroke's pressure varies along its length (needs per-segment width to render honestly). */
export function pressureVaries(s: Stroke): boolean {
  let min = Infinity
  let max = -Infinity
  for (const p of s.points) {
    const v = p.pressure ?? 1
    if (v < min) min = v
    if (v > max) max = v
  }
  return max - min > PRESSURE_EPS
}

/** Strokes grouped by pen, in the profile's palette order then any strays. */
export function byPen(geom: Geometry, order: number[]): Map<number, Geometry> {
  const m = new Map<number, Geometry>()
  for (const s of geom) {
    if (s.points.length < 2) continue
    ;(m.get(s.pen) ?? m.set(s.pen, []).get(s.pen)!).push(s)
  }
  // Reinsert in palette order so SVG layers read sensibly.
  const sorted = new Map<number, Geometry>()
  for (const p of [...order, ...m.keys()]) if (m.has(p) && !sorted.has(p)) sorted.set(p, m.get(p)!)
  return sorted
}

/** The plottable geometry rendered as SVG markup: one layer per element (document order, named as
 *  in the Elements tree), a sub-layer per stroke part where the generator tagged them (tonal
 *  hatching's tone bands), and a pen layer inside only where an element draws with more than one pen
 *  (a single-pen element carries its pen on the enclosing layer). Page mm on the bed. */
export function buildSvgMarkup(): string {
  const { elements, profile } = useDoc.getState()
  const chunks = buildPlottableGeometryByElement(elements, profile)
  const penColor = (pen: number) => profile.pens.find((p) => p.id === pen)?.color ?? '#1a1a1a'
  const penName = (pen: number) => profile.pens.find((p) => p.id === pen)?.name ?? `Pen ${pen}`
  const penOrder = profile.pens.map((p) => p.id)
  const pressureOn = pressureEnabled(profile)
  const { bed } = profile

  const strokeMarkup = (s: Stroke, indent: string): string => {
    if (pressureOn && pressureVaries(s)) {
      // Pressure rides on line weight (matching canvas/preview): one <line> per segment, its width
      // from the segment's mean pressure. Only varying strokes pay this cost; the rest stay one path.
      let out = ''
      for (let i = 1; i < s.points.length; i++) {
        const a = s.points[i - 1]
        const b = s.points[i]
        const w = displayPenWidthMm(((a.pressure ?? 1) + (b.pressure ?? 1)) / 2, true)
        out += `${indent}<line x1="${f3(a.x)}" y1="${f3(a.y)}" x2="${f3(b.x)}" y2="${f3(b.y)}" stroke-width="${f3(w)}"/>\n`
      }
      return out
    }
    // Uniform stroke: one path. Weight it by the stroke's single pressure when pressure is on.
    const wAttr = pressureOn ? ` stroke-width="${f3(displayPenWidthMm(s.points[0].pressure ?? 1, true))}"` : ''
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${f3(p.x)} ${f3(p.y)}`).join(' ')
    return `${indent}<path d="${d}"${wAttr}/>\n`
  }
  const penAttrs = (pen: number) => ` stroke="${penColor(pen)}" data-pen="${esc(penName(pen))}"`
  // The strokes of one bucket (an element, or one of its parts): a single pen puts its attributes on
  // the enclosing <g>; several pens get one nested <g> each, in palette order.
  const bucketMarkup = (open: string, strokes: Geometry, indent: string): string => {
    const pens = byPen(strokes, penOrder)
    if (pens.size === 1) {
      const [pen, list] = [...pens][0]
      return `${indent}<g${open}${penAttrs(pen)}>\n${list.map((s) => strokeMarkup(s, indent + '  ')).join('')}${indent}</g>\n`
    }
    let out = `${indent}<g${open}>\n`
    for (const [pen, list] of pens) {
      out += `${indent}  <g${penAttrs(pen)}>\n${list.map((s) => strokeMarkup(s, indent + '    ')).join('')}${indent}  </g>\n`
    }
    return out + `${indent}</g>\n`
  }

  let body = ''
  for (const { el, geom } of chunks) {
    const elOpen = ` data-element="${esc(elementLabel(el))}"`
    const parts = byPart(geom)
    if (parts.size === 1) {
      // Untagged, or a single part (e.g. an unfilled shape's outline): no sub-groups to show.
      body += bucketMarkup(elOpen, geom, '  ')
      continue
    }
    body += `  <g${elOpen}>\n`
    for (const [part, strokes] of parts) {
      const open = part === 0 ? '' : ` data-part="${esc(partLabel(el.type, el.params, part))}"`
      body += bucketMarkup(open, strokes, '    ')
    }
    body += `  </g>\n`
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${bed.width}mm" height="${bed.height}mm" ` +
    `viewBox="0 0 ${bed.width} ${bed.height}" fill="none" stroke-width="${PEN_WIDTH_MM}" ` +
    `stroke-linecap="round" stroke-linejoin="round">\n${body}</svg>\n`
  )
}

const f3 = (n: number) => n.toFixed(3)

/** Strokes bucketed by their `part` tag in ascending tag order (0 = untagged first). */
function byPart(geom: Geometry): Map<number, Geometry> {
  const m = new Map<number, Geometry>()
  for (const s of geom) {
    if (s.points.length < 2) continue
    const k = s.part ?? 0
    ;(m.get(k) ?? m.set(k, []).get(k)!).push(s)
  }
  return new Map([...m].sort((a, b) => a[0] - b[0]))
}

/** The plottable geometry rendered as an SVG Blob. */
export function buildSvgBlob(): Blob {
  return new Blob([buildSvgMarkup()], { type: 'image/svg+xml' })
}

export function exportSvg(): void {
  downloadBlob(`${docName()}.svg`, buildSvgBlob())
}

/** The plottable geometry rendered as a transparent PNG Blob at `pxPerMm` pixels per millimetre
 *  (default ≈ a crisp, bounded image). Null only if canvas encoding fails. */
export async function buildPngBlob(pxPerMm?: number): Promise<Blob | null> {
  const { geom, bed, penColor, pressureOn } = plottable()
  const scale = pxPerMm ?? Math.min(10, Math.max(2, 2400 / Math.max(bed.width, bed.height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bed.width * scale))
  canvas.height = Math.max(1, Math.round(bed.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // Leave the background transparent (a fresh canvas is already clear; PNG keeps the alpha).
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const s of geom) {
    if (s.points.length < 2) continue
    ctx.strokeStyle = penColor(s.pen)
    // Stroke per segment so pressure reads as line weight (matching canvas/preview). When pressure is
    // off, displayPenWidthMm returns the nominal width for every point → uniform, as before.
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1]
      const b = s.points[i]
      ctx.lineWidth = displayPenWidthMm(((a.pressure ?? 1) + (b.pressure ?? 1)) / 2, pressureOn) * scale
      ctx.beginPath()
      ctx.moveTo(a.x * scale, a.y * scale)
      ctx.lineTo(b.x * scale, b.y * scale)
      ctx.stroke()
    }
  }
  return new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
}

/** PNG export at `pxPerMm` pixels per millimetre (default ≈ a crisp, bounded image). */
export async function exportPng(pxPerMm?: number): Promise<void> {
  const blob = await buildPngBlob(pxPerMm)
  if (blob) downloadBlob(`${docName()}.png`, blob)
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)
