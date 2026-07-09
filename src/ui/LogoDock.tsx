// The Logo code dock: a resizable panel under the canvas hosting the CodeMirror editor — code and
// drawing visible together while the program re-runs live. In-flow deliberately (the canvas
// shrinks to make room): a floating panel covered part of the page with no way to pan it into
// view when the whole page already fit the viewport.
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
import { Suspense, lazy, useEffect } from 'react'
import { Hammer, X } from 'lucide-react'
import { useDoc } from '../store/document'
import { useUI } from '../store/ui'
import { useLogoTools } from '../store/logoTools'
import { promptDialog } from '../store/dialogs'
import { LOGO_EXAMPLES } from '../elements/logo/examples'
import type { LogoParams } from '../elements/logo'
import { IconButton, controlClass, cx } from './primitives'

const LogoEditor = lazy(() => import('./LogoEditor'))

const MIN_HEIGHT = 120
const maxHeight = () => Math.round(window.innerHeight * 0.7)

export function LogoDock() {
  const editingId = useUI((s) => s.codeDockFor)
  const height = useUI((s) => s.codeDockHeight)
  const setFor = useUI((s) => s.setCodeDockFor)
  const setHeight = useUI((s) => s.setCodeDockHeight)
  const target = useDoc((s) => {
    const el = editingId ? s.elements.find((e) => e.id === editingId) : undefined
    return el?.type === 'logo' ? el : undefined
  })
  const selected = useDoc((s) => (editingId ? s.selectedIds.includes(editingId) : false))
  const visible = !!target && selected

  // End the session when the edited element vanishes (deleted, cross-tab replace) or is
  // deselected (background click, tree selection, undo) — an editor for an element that's no
  // longer selected is just confusing.
  useEffect(() => {
    if (editingId && (!target || !selected)) setFor(null)
  }, [editingId, target, selected, setFor])

  // Esc closes the dock — unless CodeMirror consumed it (closing autocomplete etc. preventDefaults).
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setFor(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, setFor])

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
      {/* The header doubles as the editor's toolbar. */}
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-2xs font-semibold uppercase tracking-wide text-muted">Logo program</span>
        <span className="truncate text-xs text-faint">{target.name ?? ''}</span>
        <div className="flex-1" />
        <select
          className={cx(controlClass, 'h-7 !w-auto max-w-44 py-0 text-xs')}
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
      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="p-3 text-xs text-muted">Loading editor…</div>}>
          <LogoEditor key={target.id} id={target.id} />
        </Suspense>
      </div>
    </div>
  )
}
