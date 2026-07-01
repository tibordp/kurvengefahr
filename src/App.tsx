import { useEffect } from 'react'
import { Toolbar } from './ui/Toolbar'
import { ToolSidebar } from './ui/ToolSidebar'
import { Inspector } from './ui/Inspector'
import { HelpDialog } from './ui/HelpDialog'
import { SvgImportDialog } from './ui/SvgImportDialog'
import { DxfImportDialog } from './ui/DxfImportDialog'
import { ExportDialog } from './ui/ExportDialog'
import { CommandPalette } from './ui/CommandPalette'
import { Toaster } from './ui/Toaster'
import { Canvas } from './canvas/Canvas'
import { PreviewControls } from './ui/PreviewControls'
import { StatusBar } from './ui/StatusBar'
import { useShortcuts } from './ui/useShortcuts'
import { useDoc } from './store/document'
import { useUI } from './store/ui'
import { syncGeneration } from './core/generation'
import { addImageElement } from './canvas/importImage'
import { serializeSelection, parseClipboard, pasteElements } from './store/clipboard'

/** Copy / cut / paste through the **real system clipboard** (the native events are the only place
 *  with synchronous clipboard access), so it works across documents, tabs and windows. Copy/cut
 *  serialize the selection as marked text; paste handles our marked elements AND/OR a clipboard image
 *  (→ a raster element) — when both are present you get both. Ignored while a text field is focused
 *  (the field gets the native copy/paste). */
function useSystemClipboard() {
  useEffect(() => {
    const typing = () => {
      const t = document.activeElement as HTMLElement | null
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    }
    // The user is selecting real page text (a label, banner, help copy) — let the browser copy that
    // text rather than hijacking the shortcut to copy the selected canvas element.
    const selectingText = () => {
      const sel = window.getSelection()
      return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0
    }
    const writeSelection = (e: ClipboardEvent): boolean => {
      const data = serializeSelection()
      if (!data) return false
      e.clipboardData?.setData('text/plain', data)
      e.preventDefault()
      return true
    }
    const onCopy = (e: ClipboardEvent) => {
      if (!typing() && !selectingText()) writeSelection(e)
    }
    const onCut = (e: ClipboardEvent) => {
      if (!typing() && !selectingText() && writeSelection(e)) useDoc.getState().removeSelected()
    }
    const onPaste = (e: ClipboardEvent) => {
      if (typing()) return
      const els = parseClipboard(e.clipboardData?.getData('text/plain'))
      const item = Array.from(e.clipboardData?.items ?? []).find(
        (it) => it.kind === 'file' && it.type.startsWith('image/'),
      )
      const file = item?.getAsFile() ?? null
      if (!els && !file) return // nothing for us — let the browser handle it
      e.preventDefault()
      const ids = els ? pasteElements(els) : []
      if (file)
        void addImageElement(file).then((id) => {
          // Select the pasted image alongside the pasted elements, not instead of them.
          if (id) useDoc.getState().selectMany([...ids, id])
        })
    }
    window.addEventListener('copy', onCopy)
    window.addEventListener('cut', onCut)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('copy', onCopy)
      window.removeEventListener('cut', onCut)
      window.removeEventListener('paste', onPaste)
    }
  }, [])
}

/** Drive worker-backed generation (handwriting + raster): whenever the document changes, reconcile
 *  what needs (re)generating off the main thread — initial generation for new elements, and a
 *  debounced re-trace for edited "live" (auto-regenerate) elements. */
function useGenerationManager() {
  const elements = useDoc((s) => s.elements)
  useEffect(() => {
    syncGeneration(elements)
  }, [elements])
}

export function App() {
  useShortcuts()
  useGenerationManager()
  useSystemClipboard()
  const inspectorOpen = useUI((s) => s.inspectorOpen)
  const setInspectorOpen = useUI((s) => s.setInspectorOpen)

  // Esc closes the mobile inspector drawer (desktop ignores `inspectorOpen`).
  useEffect(() => {
    if (!inspectorOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInspectorOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inspectorOpen, setInspectorOpen])

  return (
    <div className="grid h-dvh grid-cols-1 grid-rows-[auto_auto_1fr] overflow-hidden md:grid-cols-[auto_minmax(0,1fr)_320px] md:grid-rows-[auto_1fr]">
      <Toolbar />
      <ToolSidebar />
      <main className="relative flex min-h-0 min-w-0 flex-col">
        <Canvas />
        <PreviewControls />
        <StatusBar />
      </main>

      {/* Scrim behind the mobile drawer. */}
      {inspectorOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/30 backdrop-blur-[1px] md:hidden"
          aria-hidden
          onClick={() => setInspectorOpen(false)}
        />
      )}

      <Inspector />
      <HelpDialog />
      <SvgImportDialog />
      <DxfImportDialog />
      <ExportDialog />
      <CommandPalette />
      <Toaster />
    </div>
  )
}
