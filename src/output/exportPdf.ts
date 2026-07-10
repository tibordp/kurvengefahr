// Export the document as a vector PDF — the same plottable geometry as the SVG export, on a page
// the exact size of the bed (1 mm is 1 mm on paper). Hand-rolled writer: the whole document is
// polylines with per-pen color and width, which is a dozen PDF operators — a PDF library would be
// a heavyweight dependency for no gain. One content stream, deflated with fflate (already a dep).
import { zlibSync, strToU8 } from 'fflate'
import { useDoc } from '../store/document'
import { displayPenWidthMm } from '../canvas/penWidth'
import { byPen, docName, plottable, pressureVaries } from './exportVector'
import { downloadBlob } from './download'

const MM_TO_PT = 72 / 25.4

const f3 = (n: number) => (Math.round(n * 1000) / 1000).toString()

/** `#rrggbb` → `r g b` in 0..1 (PDF RG operands). Unparseable colors fall back to black. */
function rgbOps(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return '0 0 0'
  const v = parseInt(m[1], 16)
  return [16, 8, 0].map((sh) => f3(((v >> sh) & 0xff) / 255)).join(' ')
}

/** The plottable geometry rendered as a PDF Blob (bed-sized page, per-pen stroke colors). */
export function buildPdfBlob(): Blob {
  const { geom, bed, penColor, pressureOn } = plottable()
  const { pens } = useDoc.getState().profile
  const groups = byPen(geom, pens.map((p) => p.id))

  // Content stream in page mm, +y down: PDF user space is pt with +y up, so one CTM maps it —
  // scale mm→pt, flip y. Line widths pass through the CTM, so `w` operands are plain mm too.
  let cs = `${f3(MM_TO_PT)} 0 0 ${f3(-MM_TO_PT)} 0 ${f3(bed.height * MM_TO_PT)} cm\n1 J\n1 j\n`
  for (const [pen, strokes] of groups) {
    cs += `${rgbOps(penColor(pen))} RG\n`
    for (const s of strokes) {
      if (s.points.length < 2) continue
      if (pressureOn && pressureVaries(s)) {
        // Pressure rides on line weight (matching canvas/SVG): one segment per width change.
        for (let i = 1; i < s.points.length; i++) {
          const a = s.points[i - 1]
          const b = s.points[i]
          const w = displayPenWidthMm(((a.pressure ?? 1) + (b.pressure ?? 1)) / 2, true)
          cs += `${f3(w)} w ${f3(a.x)} ${f3(a.y)} m ${f3(b.x)} ${f3(b.y)} l S\n`
        }
      } else {
        cs += `${f3(displayPenWidthMm(s.points[0].pressure ?? 1, pressureOn))} w\n`
        cs += s.points.map((p, i) => `${f3(p.x)} ${f3(p.y)} ${i ? 'l' : 'm'}`).join(' ') + ' S\n'
      }
    }
  }

  return assemblePdf(bed.width * MM_TO_PT, bed.height * MM_TO_PT, zlibSync(strToU8(cs)), docName())
}

/** Minimal single-page PDF around a deflated content stream, with a byte-accurate xref. */
function assemblePdf(pageW: number, pageH: number, content: Uint8Array, title: string): Blob {
  const parts: Uint8Array[] = []
  let offset = 0
  const offsets: number[] = []
  const push = (u: Uint8Array) => {
    parts.push(u)
    offset += u.length
  }
  const obj = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = offset
    push(strToU8(`${n} 0 obj\n${body}\n`))
    if (stream) {
      push(strToU8('stream\n'))
      push(stream)
      push(strToU8('\nendstream\n'))
    }
    push(strToU8('endobj\n'))
  }
  // The header's high-bit bytes mark the file as binary for transfer tools.
  push(strToU8('%PDF-1.4\n%âãÏÓ\n'))
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f3(pageW)} ${f3(pageH)}] ` +
      '/Contents 4 0 R /Resources << >> >>',
  )
  obj(4, `<< /Length ${content.length} /Filter /FlateDecode >>`, content)
  // Literal strings escape \ ( ); the filename is already sanitized, non-ASCII just passes as UTF-8.
  const esc = title.replace(/[\\()]/g, (c) => '\\' + c)
  obj(5, `<< /Title (${esc}) /Producer (Kurvengefahr) >>`)
  const xrefAt = offset
  let xref = 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  xref += `trailer\n<< /Size 6 /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  push(strToU8(xref))
  return new Blob(parts as BlobPart[], { type: 'application/pdf' })
}

export function exportPdf(): void {
  downloadBlob(`${docName()}.pdf`, buildPdfBlob())
}
