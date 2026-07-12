// The Logo code dock: hosts the CodeMirror editor while the program re-runs live.
//
// Desktop: a resizable panel under the canvas — code and drawing visible together. In-flow
// deliberately (the canvas shrinks to make room): a floating panel covered part of the page with
// no way to pan it into view when the whole page already fit the viewport.
//
// Mobile (below `md`, same boundary as the inspector drawer): the dock idea breaks down — the
// on-screen keyboard covers a bottom panel entirely. Instead the editor goes fullscreen, sized to
// the *visual* viewport (the layout viewport ignores the keyboard on iOS, so a plain inset-0
// overlay would still be half-hidden). Seeing the drawing is a mode: the Eye button blurs the
// editor (dismissing the keyboard) and hides the overlay — CodeMirror stays mounted, so its undo
// history and cursor survive — leaving a floating "Back to code" pill over the canvas. The canvas
// stays fully interactive in preview (pan/zoom to inspect the result), so a background tap may
// deselect the element; the session deliberately survives that while previewing, and the pill
// re-selects on the way back.
//
// Opening is an explicit act bound to one element (`codeDockFor` holds its id): the inspector's
// Edit code button, double-clicking the element, or creating a new one — never mere selection.
// While open the session is modal-ish: the canvas mutes every other element (see Canvas). It ends
// on X / Esc, and whenever the element stops being selected (background click, tree selection,
// undo) or is deleted — an editor detached from the selection would be confusing. The editor
// itself is lazy — CodeMirror never loads until a Logo element is actually edited.
//
// Dock height is transient chrome state (store/ui.ts), never part of the document — so the resize
// drag needs no history bracket.
import { Suspense, lazy, useEffect, useState } from 'react'
import { Code, Eye, Hammer, X } from 'lucide-react'
import { useDoc } from '../store/document'
import { useUI } from '../store/ui'
import { useLogoTools } from '../store/logoTools'
import { promptDialog } from '../store/dialogs'
import { LOGO_EXAMPLES } from '../elements/logo/examples'
import type { LogoParams } from '../elements/logo'
import { Button, IconButton, controlClass, cx } from './primitives'
import { useIsMobile } from './mobile'

const LogoEditor = lazy(() => import('./LogoEditor'))

const MIN_HEIGHT = 120
const maxHeight = () => Math.round(window.innerHeight * 0.7)

/** The visual-viewport rect while `active` — shrinks when the on-screen keyboard opens (which the
 *  layout viewport doesn't reflect on iOS). Null when inactive or unsupported → caller falls back
 *  to the full viewport. */
function useVisualViewport(active: boolean) {
  const [rect, setRect] = useState<{ top: number; height: number } | null>(null)
  useEffect(() => {
    const vv = window.visualViewport
    if (!active || !vv) return
    const update = () => setRect({ top: vv.offsetTop, height: vv.height })
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      setRect(null)
    }
  }, [active])
  return rect
}

export function LogoDock() {
  const editingId = useUI((s) => s.codeDockFor)
  const height = useUI((s) => s.codeDockHeight)
  const setFor = useUI((s) => s.setCodeDockFor)
  const setHeight = useUI((s) => s.setCodeDockHeight)
  const isMobile = useIsMobile()
  const [previewing, setPreviewing] = useState(false)
  const target = useDoc((s) => {
    const el = editingId ? s.elements.find((e) => e.id === editingId) : undefined
    return el?.type === 'logo' ? el : undefined
  })
  const selected = useDoc((s) => (editingId ? s.selectedIds.includes(editingId) : false))
  const inPreview = isMobile && previewing
  const visible = !!target && (selected || inPreview)

  // A fresh session never starts in preview.
  useEffect(() => setPreviewing(false), [editingId])

  // The fullscreen editor and the inspector drawer are both mobile overlays — opening the editor
  // (e.g. via the drawer's Edit code button) dismisses the drawer instead of stacking under it.
  const setInspectorOpen = useUI((s) => s.setInspectorOpen)
  useEffect(() => {
    if (isMobile && visible) setInspectorOpen(false)
  }, [isMobile, visible, setInspectorOpen])

  // End the session when the edited element vanishes (deleted, cross-tab replace) or is
  // deselected (background click, tree selection, undo) — an editor for an element that's no
  // longer selected is just confusing. Exception: mobile preview hides the editor to expose the
  // canvas, so deselection there is just the user tapping around — the pill restores selection.
  useEffect(() => {
    if (editingId && (!target || (!selected && !inPreview))) setFor(null)
  }, [editingId, target, selected, inPreview, setFor])

  // Esc closes the dock — unless CodeMirror consumed it (closing autocomplete etc. preventDefaults).
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setFor(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, setFor])

  const vvRect = useVisualViewport(isMobile && visible)

  if (!visible || !target) return null

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = useUI.getState().codeDockHeight
    const onMove = (ev: PointerEvent) => {
      setHeight(Math.round(Math.min(Math.max(startH + (startY - ev.clientY), MIN_HEIGHT), maxHeight())))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const insertExample = (name: string) => {
    const ex = LOGO_EXAMPLES.find((x) => x.name === name)
    if (!ex) return
    const params = target.params as LogoParams
    useDoc.getState().setParams(target.id, { ...params, source: ex.source, args: {} })
  }

  const saveAsTool = async () => {
    const name = await promptDialog({ title: 'Save as tool', initial: 'My tool' })
    if (name) useLogoTools.getState().addTool(name, (target.params as LogoParams).source)
  }

  const enterPreview = () => {
    // Blur dismisses the on-screen keyboard so the drawing isn't half-covered.
    ;(document.activeElement as HTMLElement | null)?.blur()
    setPreviewing(true)
  }

  const exitPreview = () => {
    useDoc.getState().select(target.id)
    setPreviewing(false)
  }

  /* The header doubles as the editor's toolbar (shared desktop/mobile). */
  const header = (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
      <span className="whitespace-nowrap text-2xs font-semibold uppercase tracking-wide text-muted">Logo program</span>
      <span className="hidden truncate text-xs text-faint sm:block">{target.name ?? ''}</span>
      <div className="flex-1" />
      <select
        className={cx(controlClass, 'h-7 !w-auto max-w-32 py-0 text-xs sm:max-w-44')}
        value=""
        title="Replace this element's program with a bundled example (undoable)"
        aria-label="Insert example program"
        onChange={(e) => insertExample(e.target.value)}
      >
        <option value="" disabled>
          Insert example…
        </option>
        {LOGO_EXAMPLES.map((x) => (
          <option key={x.name} value={x.name}>
            {x.name}
          </option>
        ))}
      </select>
      <IconButton
        aria-label="Save this program as a tool"
        title="Save as tool — click it in the sidebar to stamp copies"
        className="h-7 w-7"
        onClick={() => void saveAsTool()}
      >
        <Hammer size={15} />
      </IconButton>
      {isMobile && (
        <IconButton
          aria-label="Preview the drawing"
          title="Hide the editor to see the drawing"
          className="h-7 w-7"
          onClick={enterPreview}
        >
          <Eye size={15} />
        </IconButton>
      )}
      <span className="h-4 w-px bg-border" aria-hidden />
      <IconButton
        aria-label="Close code editor"
        title="Close code editor (Esc)"
        className="h-7 w-7"
        onClick={() => setFor(null)}
      >
        <X size={15} />
      </IconButton>
    </header>
  )

  const editor = (
    <div className="min-h-0 flex-1">
      <Suspense fallback={<div className="p-3 text-xs text-muted">Loading editor…</div>}>
        <LogoEditor key={target.id} id={target.id} />
      </Suspense>
    </div>
  )

  if (isMobile) {
    return (
      <>
        <div
          className={cx('fixed left-0 z-30 flex w-full flex-col bg-surface', previewing && 'invisible')}
          style={vvRect ? { top: vvRect.top, height: vvRect.height } : { top: 0, height: '100%' }}
        >
          {header}
          {editor}
        </div>
        {previewing && (
          <Button className="fixed bottom-4 left-1/2 z-30 -translate-x-1/2 shadow-panel" onClick={exitPreview}>
            <Code size={15} /> Back to code
          </Button>
        )}
      </>
    )
  }

  return (
    <div
      className="relative flex shrink-0 flex-col border-t border-border bg-surface"
      style={{ height: Math.min(height, maxHeight()) }}
    >
      {/* Grab zone straddling the top edge. */}
      <div
        className="absolute -top-1 left-0 right-0 h-2 cursor-row-resize"
        onPointerDown={startResize}
        aria-hidden
      />
      {header}
      {editor}
    </div>
  )
}
