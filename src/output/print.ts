// Print the plottable geometry at true physical scale — a paper proof before committing ink.
// A hidden iframe hosts the SVG on a page sized exactly to the bed (`@page` in mm, zero margin),
// so 1 mm in the document is 1 mm on paper when the print dialog is set to 100% / actual size.
import { useDoc } from '../store/document'
import { useDocuments } from '../store/documents'
import { buildSvgMarkup } from './exportVector'

export function printDocument(): void {
  const { bed } = useDoc.getState().profile
  const title = useDocuments.getState().activeName || 'Kurvengefahr'
  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  iframe.srcdoc =
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${escapeHtml(title)}</title>` +
    `<style>@page{size:${bed.width}mm ${bed.height}mm;margin:0}` +
    `html,body{margin:0;padding:0}svg{display:block;width:${bed.width}mm;height:${bed.height}mm}</style>` +
    `</head><body>${buildSvgMarkup()}</body></html>`

  let done = false
  const cleanup = () => {
    if (done) return
    done = true
    iframe.remove()
  }
  iframe.onload = () => {
    const win = iframe.contentWindow
    if (!win) return cleanup()
    win.addEventListener('afterprint', cleanup)
    win.focus()
    win.print()
    // afterprint fires in every modern browser; the timer only reaps the iframe if it doesn't.
    window.setTimeout(cleanup, 120_000)
  }
  document.body.appendChild(iframe)
}

const escapeHtml = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)
