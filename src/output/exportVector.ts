// Export the document as vector SVG or raster PNG — the same plottable geometry the G-code is built
// from (so it round-trips and lets you eyeball exactly what will plot), in page mm on the bed.
import { useDoc } from '../store/document'
import { useDocuments } from '../store/documents'
import { buildPlottableGeometry } from '../core/pipeline'
import { downloadBlob, safeFilename } from './download'
import type { Geometry } from '../core/types'

/** Nominal pen-tip width (mm) used for the rendered stroke width — matches the canvas. */
const PEN_WIDTH_MM = 0.4

function plottable(): { geom: Geometry; bed: { width: number; height: number }; penColor: (p: number) => string; name: string } {
  const { elements, profile } = useDoc.getState()
  const geom = buildPlottableGeometry(elements, profile)
  const penColor = (pen: number) => profile.pens.find((p) => p.id === pen)?.color ?? '#1a1a1a'
  return { geom, bed: profile.bed, penColor, name: useDocuments.getState().activeName }
}

/** Strokes grouped by pen, in the profile's palette order then any strays. */
function byPen(geom: Geometry, order: number[]): Map<number, Geometry> {
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

export function exportSvg(): void {
  const { geom, bed, penColor, name } = plottable()
  const { pens } = useDoc.getState().profile
  const groups = byPen(geom, pens.map((p) => p.id))
  let body = ''
  for (const [pen, strokes] of groups) {
    const penName = pens.find((p) => p.id === pen)?.name ?? `Pen ${pen}`
    body += `  <g stroke="${penColor(pen)}" data-pen="${esc(penName)}">\n`
    for (const s of strokes) {
      const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' ')
      body += `    <path d="${d}"/>\n`
    }
    body += `  </g>\n`
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${bed.width}mm" height="${bed.height}mm" ` +
    `viewBox="0 0 ${bed.width} ${bed.height}" fill="none" stroke-width="${PEN_WIDTH_MM}" ` +
    `stroke-linecap="round" stroke-linejoin="round">\n${body}</svg>\n`
  downloadBlob(`${safeFilename(name, 'kurvengefahr')}.svg`, new Blob([svg], { type: 'image/svg+xml' }))
}

/** PNG export at `pxPerMm` pixels per millimetre (default ≈ a crisp, bounded image). */
export async function exportPng(pxPerMm?: number): Promise<void> {
  const { geom, bed, penColor, name } = plottable()
  const scale = pxPerMm ?? Math.min(10, Math.max(2, 2400 / Math.max(bed.width, bed.height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bed.width * scale))
  canvas.height = Math.max(1, Math.round(bed.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = PEN_WIDTH_MM * scale
  for (const s of geom) {
    if (s.points.length < 2) continue
    ctx.strokeStyle = penColor(s.pen)
    ctx.beginPath()
    ctx.moveTo(s.points[0].x * scale, s.points[0].y * scale)
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * scale, s.points[i].y * scale)
    ctx.stroke()
  }
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (blob) downloadBlob(`${safeFilename(name, 'kurvengefahr')}.png`, blob)
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)
