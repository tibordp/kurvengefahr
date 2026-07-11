import './core/randomUUID' // shim crypto.randomUUID for insecure (LAN-IP HTTP) origins — must be first
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initWasm } from './core/wasm'
import { initDocuments } from './store/documents'
import { installApi } from './api'
import { parseShareFragment } from './share/link'
import { Button } from './ui/primitives'
import '@fontsource-variable/inter/index.css'
import './index.css'

// A `#s=<hash>.<key>` fragment boots the read-only share viewer instead of the editor. Parsed
// up front (before any async work can see a mutated URL); the fragment is deliberately KEPT in
// the address bar while viewing — it never leaves the browser, and keeping it makes reload,
// bookmark and re-share work for free. It drops naturally on "Edit a copy"'s reload.
const shareRef = parseShareFragment(location.hash)

// Opening a share link in an already-running tab is just a fragment change — no navigation, no
// new boot. Reload deliberately: into the viewer when a share fragment arrives, and out of (or
// between) share views when the viewer's fragment changes. Editor-mode fragment noise stays
// inert. Autosave makes the editor reload lossless.
window.addEventListener('hashchange', () => {
  if (shareRef !== null || parseShareFragment(location.hash) !== null) location.reload()
})

// Instantiate WASM before the first render. After this resolves, the crate's exported
// functions are synchronous, so element generation and the canvas stay synchronous.
const root = createRoot(document.getElementById('root')!)

initWasm().then(
  async () => {
    if (shareRef !== null) {
      // Viewer mode: no initDocuments() (nothing may touch the visitor's saved documents or
      // autosave), no public API. Loaded lazily so the editor boot path doesn't pay for it.
      const [{ bootViewer }, { ShareViewer }] = await Promise.all([
        import('./share/viewer'),
        import('./ui/ShareViewer'),
      ])
      void bootViewer(shareRef)
      root.render(
        <StrictMode>
          <ShareViewer />
        </StrictMode>,
      )
      return
    }
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
