import { useEffect } from 'react'
import { Toolbar } from './ui/Toolbar'
import { ToolSidebar } from './ui/ToolSidebar'
import { Inspector } from './ui/Inspector'
import { Canvas } from './canvas/Canvas'
import { PreviewControls } from './ui/PreviewControls'
import { StatusBar } from './ui/StatusBar'
import { useShortcuts } from './ui/useShortcuts'
import { useDoc } from './store/document'
import { useUI } from './store/ui'
import { syncGeneration } from './core/generation'

/** Drive worker-backed (handwriting) generation: whenever the document changes, reconcile what
 *  needs (re)generating off the main thread. */
function useGenerationManager() {
  const elements = useDoc((s) => s.elements)
  useEffect(() => {
    syncGeneration(elements)
  }, [elements])
}

export function App() {
  useShortcuts()
  useGenerationManager()
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
    <div className="grid h-screen grid-rows-[auto_1fr] md:grid-cols-[auto_1fr_320px]">
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
    </div>
  )
}
