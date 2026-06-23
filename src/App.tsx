import { useEffect } from 'react'
import { Toolbar } from './ui/Toolbar'
import { Inspector } from './ui/Inspector'
import { Canvas } from './canvas/Canvas'
import { PreviewControls } from './ui/PreviewControls'
import { StatusBar } from './ui/StatusBar'
import { useShortcuts } from './ui/useShortcuts'
import { useDoc } from './store/document'
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
  return (
    <div className="app">
      <Toolbar />
      <div className="canvas-area">
        <div className="canvas-pane">
          <Canvas />
          <PreviewControls />
          <StatusBar />
        </div>
      </div>
      <Inspector />
    </div>
  )
}
