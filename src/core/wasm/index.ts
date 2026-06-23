// Single place that owns WASM instantiation. `initWasm()` is idempotent and must resolve
// before any exported function is called. The app gates first render on it (see main.tsx),
// so the exports below can be invoked synchronously everywhere else.
import init, {
  optimize,
  generate_handwriting,
  clip,
  GeometryBuffers,
} from '@wasm/kg_toolpath.js'
import wasmUrl from '@wasm/kg_toolpath_bg.wasm?url'

let ready: Promise<void> | null = null

export function initWasm(): Promise<void> {
  if (!ready) {
    ready = init({ module_or_path: wasmUrl }).then(() => undefined)
  }
  return ready
}

export { optimize, generate_handwriting, clip, GeometryBuffers }
