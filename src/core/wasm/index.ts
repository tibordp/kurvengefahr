// Main-thread WASM: the synchronous, model-free geometry ops — clip, optimize, and the stateless
// substitution note. `initWasm()` is idempotent and resolves before first render (see main.tsx),
// so these can be called synchronously everywhere.
//
// Handwriting *generation* does NOT live here: it runs in a Web Worker with its own WASM instance
// and the ~7 MB model blob (see core/wasm/genWorker.ts + core/generation.ts), so the heavy RNN
// never blocks the UI. The main thread never loads the model.
import init, {
  optimize,
  substitution_note,
  apply_filters,
  clip,
  clip_polygon,
  tessellate_rect,
  tessellate_ellipse,
  tessellate_path,
  simplify_polyline,
  split_cubic,
  text,
  generative,
  hatch,
  concentric,
  boolean,
  import_svg,
  import_dxf,
  SvgImport,
  GeometryBuffers,
} from '@wasm/kg_core.js'
import wasmUrl from '@wasm/kg_core_bg.wasm?url'

let ready: Promise<void> | null = null

export function initWasm(): Promise<void> {
  if (!ready) {
    ready = init({ module_or_path: wasmUrl }).then(() => undefined)
  }
  return ready
}

export {
  optimize,
  substitution_note,
  apply_filters,
  clip,
  clip_polygon,
  tessellate_rect,
  tessellate_ellipse,
  tessellate_path,
  simplify_polyline,
  split_cubic,
  text,
  generative,
  hatch,
  concentric,
  boolean,
  import_svg,
  import_dxf,
  SvgImport,
  GeometryBuffers,
}
