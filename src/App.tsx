import { useEffect } from 'react'
import { Toolbar } from './ui/Toolbar'
import { ToolSidebar } from './ui/ToolSidebar'
import { Inspector } from './ui/Inspector'
import { HelpDialog } from './ui/HelpDialog'
import { SvgImportDialog } from './ui/SvgImportDialog'
import { ExportDialog } from './ui/ExportDialog'
import { Canvas } from './canvas/Canvas'
import { PreviewControls } from './ui/PreviewControls'
import { StatusBar } from './ui/StatusBar'
import { useShortcuts } from './ui/useShortcuts'
import { useDoc } from './store/document'
import { useUI } from './store/ui'
import { syncGeneration } from './core/generation'
import { addImageElement } from './canvas/importImage'

/** Paste an image from the clipboard → a new raster element. Ignored while a text field is focused
 *  (the field gets the paste). `getAsFile()` + `preventDefault()` run synchronously in the handler;
 *  the actual import is async. */
function usePasteImage() {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = document.activeElement as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const item = Array.from(e.clipboardData?.items ?? []).find(
        (it) => it.kind === 'file' && it.type.startsWith('image/'),
      )
      const file = item?.getAsFile()
      if (!file) return
      e.preventDefault()
      void addImageElement(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
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
  usePasteImage()
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
      <ExportDialog />
    </div>
  )
}
