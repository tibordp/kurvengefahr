import './core/randomUUID' // shim crypto.randomUUID for insecure (LAN-IP HTTP) origins — must be first
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initWasm } from './core/wasm'
import { initDocuments } from './store/documents'
import { installApi } from './api'
import { Button } from './ui/primitives'
import '@fontsource-variable/inter/index.css'
import './index.css'

// Instantiate WASM before the first render. After this resolves, the crate's exported
// functions are synchronous, so element generation and the canvas stay synchronous.
const root = createRoot(document.getElementById('root')!)

initWasm().then(
  () => {
    // Restore this tab's document (or start a blank one) + start autosave before first paint.
    initDocuments()
    installApi() // the public window.kurvengefahr surface (userscripts, docs/screenshot.mjs)
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  },
  (err) => {
    // The app never rendered — a small self-contained failure screen (index.css is loaded, so the
    // theme tokens and the pre-paint dark class apply).
    root.render(
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-text">
        <h1 className="text-lg font-semibold">Kurvengefahr couldn't start</h1>
        <p className="max-w-md text-sm text-muted">
          The geometry engine (WebAssembly) failed to load — usually a network hiccup, sometimes a
          very old browser.
        </p>
        <Button variant="primary" onClick={() => location.reload()}>
          Reload
        </Button>
        <code className="max-w-md break-all text-xs text-faint">{String(err)}</code>
      </div>,
    )
  },
)
