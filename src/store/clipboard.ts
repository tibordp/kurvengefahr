// Copy/paste via the **real system clipboard**, so it works across documents, tabs and windows (not
// just within one tab's JS memory). Elements are serialized as marked JSON in `text/plain`; paste
// recognizes that marker (our elements) and/or an image file (→ a raster element). The keyboard path
// runs through the native copy/cut/paste events (App's `useSystemClipboard`, the only place with
// synchronous clipboard access); the palette/menu buttons use the async Clipboard API helpers here.
import { useDoc } from './document'
import { sanitizeElements } from './persistence/schema'
import type { DocElement } from '../core/types'

/** Marker prefixing our JSON in `text/plain`, so paste can tell our payload from arbitrary text. */
const PREFIX = 'kg-clip/v1:'

/** Serialize the current selection to a clipboard string, or null if nothing is selected. */
export function serializeSelection(): string | null {
  const { elements, selectedIds } = useDoc.getState()
  const sel = elements.filter((e) => selectedIds.includes(e.id))
  return sel.length ? PREFIX + JSON.stringify(sel) : null
}

/** Parse clipboard text back into elements (sanitized), or null if it isn't our payload. */
export function parseClipboard(text: string | null | undefined): DocElement[] | null {
  if (!text || !text.startsWith(PREFIX)) return null
  try {
    const els = sanitizeElements(JSON.parse(text.slice(PREFIX.length)))
    return els.length ? els : null
  } catch {
    return null
  }
}

/** Add pasted elements (fresh ids, slight offset, group membership dropped); selects them. */
export function pasteElements(els: DocElement[]): string[] {
  return useDoc.getState().addPasted(els)
}

// --- async helpers for non-keyboard triggers (palette / menu run inside a user gesture) ----------

export async function copySelectionToClipboard(): Promise<void> {
  const data = serializeSelection()
  if (data) await navigator.clipboard.writeText(data).catch(() => {})
}

export async function cutSelectionToClipboard(): Promise<void> {
  const data = serializeSelection()
  if (!data) return
  await navigator.clipboard.writeText(data).catch(() => {})
  useDoc.getState().removeSelected()
}

export async function pasteFromClipboard(): Promise<void> {
  try {
    const els = parseClipboard(await navigator.clipboard.readText())
    if (els) pasteElements(els)
  } catch {
    /* clipboard read denied / unavailable */
  }
}
