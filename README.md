# Kurvengefahr

Browser CAM for a pen plotter — specifically a Prusa MK4 with a spring-loaded pen-holder
toolhead (Z = pen up/down + pressure, X/Y = position). Generate G-code in the browser,
download it, drop it on the machine. Client-only SPA; the heavy toolpath work is Rust → WASM.

MVP input is **handwriting** (a Graves RNN-MDN, eventually). Vector (SVG/DXF) and raster
line-art are designed-for but not built — adding them is just a new element `generate()`.

## Architecture

The whole app pivots on one IR: a `Stroke` is one pen-down polyline in millimetres; a
`Geometry` is an ordered `Stroke[]`. Everything that makes marks produces it; everything that
makes motion consumes it.

```
element.generate()  →  place      →  filters   →  optimize        →  emit
(local mm, memoized)   (page mm)     (Stroke→    (WASM: stroke      (page→machine
                       affine        Stroke)      ordering)          + G-code)
```

Invalidation taxonomy (keeps it snappy):

- change `text`/`params`  → re-`generate()` that element (the expensive step)
- change `transform`      → re-`place` only (cheap)
- change feeds/Z/preamble → re-`emit` only (geometry untouched)

### Layout

```
crate/                 Rust → WASM (kg_toolpath): handwriting generation + stroke-ordering
  src/lib.rs           chain-aware greedy nearest-neighbour; seed of the lift-minimizer
  src/{stroke_model,typeset,geom}.rs   synthetic model · typesetter · IR + flat boundary
src/core/
  types.ts             the IR + MachineProfile
  wasm/                WASM loader + Stroke[] ↔ flat typed-array serde (the boundary contract)
  pipeline/            place · toMachine · filters · optimize · emit · index (orchestrator)
src/elements/
  registry.ts          type → generate(), with per-element memoization
  handwriting/         StrokeModel (synthetic stub now, RNN later) + Typesetter
src/store/             Zustand document store + machine-profile presets
src/canvas/            Konva stage (1 unit = 1 mm) + element nodes + Transformer
src/ui/                Toolbar + Inspector
src/output/            OutputSink (download now; PrusaLink/Web Serial later)
```

The canvas is a *view*; the store is always authoritative. The WASM boundary speaks flat
`Float32Array`/`Uint32Array` buffers (CSR-style), not serde'd objects — committed early
because it's the expensive thing to retrofit.

## Develop

```bash
npm install
npm run dev        # builds the wasm crate (predev), then starts Vite
npm run build      # wasm + tsc + vite build
```

Requires the Rust `wasm32-unknown-unknown` target and `wasm-pack`.

### Status

The handwriting `StrokeModel` is a **deterministic synthetic scribble**, not real letters —
a placeholder so the full pipeline (typeset → optimize → emit) runs end-to-end without model
weights. Replacing it with the Graves RNN behind the same interface is the next big step.
