// Test-only: initialize the shared wasm-bindgen module from disk bytes, for node (vitest) tests
// that exercise real WASM geometry. The app initializes the same module via a Vite `?url` fetch
// (see index.ts); wasm-bindgen module state is a singleton and `__wbg_init` is idempotent, so
// after this the wrappers in core/wasm — and `initWasm()` itself — work as in the app. The
// `node:fs` import makes any accidental app-bundle inclusion fail loudly at build time.
import { readFileSync } from 'node:fs'
import init from '@wasm/kg_core.js'

export async function initWasmForTests(): Promise<void> {
  await init({
    module_or_path: readFileSync(new URL('../../../crate/pkg/kg_core_bg.wasm', import.meta.url)),
  })
}
