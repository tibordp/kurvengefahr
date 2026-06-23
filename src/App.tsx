import { Toolbar } from './ui/Toolbar'
import { Inspector } from './ui/Inspector'
import { Canvas } from './canvas/Canvas'
import { PreviewControls } from './ui/PreviewControls'
import { StatusBar } from './ui/StatusBar'
import { useShortcuts } from './ui/useShortcuts'

export function App() {
  useShortcuts()
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
