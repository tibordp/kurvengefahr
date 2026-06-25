import './core/randomUUID' // shim crypto.randomUUID for insecure (LAN-IP HTTP) origins — must be first
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initWasm } from './core/wasm'
import { initDocuments } from './store/documents'
import '@fontsource-variable/inter/index.css'
import './index.css'

// Instantiate WASM before the first render. After this resolves, the crate's exported
// functions are synchronous, so element generation and the canvas stay synchronous.
const root = createRoot(document.getElementById('root')!)

initWasm().then(
  () => {
    // Restore this tab's document (or start a blank one) + start autosave before first paint.
    initDocuments()
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  },
  (err) => {
    root.render(<div style={{ padding: 24 }}>Failed to load WASM: {String(err)}</div>)
  },
)
