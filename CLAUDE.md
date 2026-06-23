# Kurvengefahr — pen-plotter CAM

Browser CAM for a pen plotter (Prusa MK4 + spring-loaded pen-holder toolhead: Z = pen up/down +
pressure, X/Y = position). Client-only React/TS SPA. Generate G-code in the browser, download,
plot. MVP input is handwriting; vector (SVG/DXF) and raster line-art are designed-for, not built.

## Cardinal rule

**All "fancy" geometry/toolpath compute lives in Rust** (`crate/`, compiled to WASM). TS owns the
app shell, UI, view-state, and the WASM boundary marshalling — nothing more. New geometry
computation goes in Rust unless it's genuinely view-coupled (per-frame render loop, or DOM
viewport math). **No TF.js / no JS ML** — the handwriting model is a pure-Rust forward pass.
Future input types (SVG/DXF, raster) will be their own `generate()` producing the same Geometry IR
— not implementations of a shared model trait. The unifying abstraction is `Stroke[]`, not a trait.

## Handwriting model (`crate/src/model.rs`, `compose.rs`) — runs in a **Web Worker**

Real **Graves RNN-MDN** (1308.0850), ported from the pretrained `sjvasquez/handwriting-synthesis`
weights — 3×LSTM-400 + soft-window attention (K=10) + 20-component MDN. Pure scalar Rust, no deps.
- **Word at a time, off the main thread.** Generation runs in a dedicated worker
  (`src/core/wasm/genWorker.ts`) with its *own* WASM instance + the model blob; the main thread
  never loads the model (`core/wasm/index.ts` keeps only clip/optimize/`substitution_note`).
  The worker `clean_text`s + splits into words and calls **`generate_word` per word** — the model is
  far more reliable on short sequences than whole lines. `core/generation.ts` is the controller:
  supersede-on-edit, word-granular progress, a `useGeneration` status store; a superseded job
  abandons between words.
- **Golden-sample priming → consistency.** Every word is primed (teacher-forced) on one bundled
  *golden* handwriting exemplar (`crate/src/golden.bin`, from `tools/export_golden.py`), so all words
  share one hand. The golden-primed recurrent state is computed **once** at `init_model` and cloned
  per word (`Model::golden_state`), so priming costs ~nothing per word. The per-word `seed` varies
  letterforms within that hand. (Earlier line-based + previous-line priming drifted into scribble;
  per-word + fixed golden is stable.)
- **Manual typesetting.** The model returns a word at its own origin (`place_word`: baseline y=0,
  x from 0, scaled to mm + slant); the **worker** lays words left→right, wraps by width, advances
  baselines, and applies alignment. `UNITS_PER_EM≈14` maps model units → em. No deslant (short words).
- **Async generation seam.** Handwriting is registered as an *async* element type (no synchronous
  `generate`); `generateLocal` returns cached/stale/`[]` ink. The worker posts the **full placed
  geometry** after each word; the controller `markGenerated` (replace) + `notifyGeometry()`, so words
  appear on the canvas one at a time. App mounts `syncGeneration(elements)`.
- **Manual regeneration.** Editing params does **not** auto-regenerate — only a brand-new element
  auto-generates once (so it appears). Edits mark the element *dirty* (`isElementDirty` = cached
  geometry hash ≠ current params hash); dirty ink is dimmed on the canvas, with a Regenerate button
  in the inspector + a toolbar "Regenerate (N)". So tweaking several params is one run, not N.
- **Weights**: f16 blob at `public/models/kg_model.f16.bin` (~7 MB, committed), **lazily fetched**
  by the worker on first use. Raw TF checkpoint is **not** committed; `tools/convert_weights.py`
  derives the blob, `tools/reference.py` is the NumPy twin that validates the math + dumps the Rust
  gold-test fixtures (`crate/tests/fixtures.json`). Blob layout is mirrored Python ↔ `model.rs`.
- Deterministic for `(text, seed, bias)` (seeded mulberry32 sampler); `bias` = neatness slider
  (range 0–2.5, default 2.5). Generation **requires** the model loaded (no fallback).

## The IR (the waist of everything)

`Stroke` = one pen-down polyline in mm + metadata; `Geometry = Stroke[]`. Defined in
`src/core/types.ts`, mirrored in `crate/src/geom.rs`.
- `points: {x, y, pressure?}[]` — millimetres.
- `pen` — pen/layer id (Emit groups by it, drops `M0` between groups).
- `reversible` — optimizer may flip stroke direction.
- `group` — nonzero = one **locked, ordered, contiguous chain** (a handwriting element); 0 = free
  singleton in the global optimization bag. Assigned at concatenation in `buildPageGeometry`.

Everything that makes marks produces Geometry; everything that makes motion consumes it. Adding a
new input type is just a new `generate()` — nothing downstream changes.

## Pipeline (`src/core/pipeline`)

generate (Rust, per element, **memoized**) → place (affine local→page) → filters (Stroke→Stroke) →
clip (Rust, to drawable rect) → optimize (Rust, chain-aware greedy NN) → emit (G-code string).
- `buildPageGeometry` = generate+place+filters. `buildPlottableGeometry` = +clip. Both **Generate
  and Preview** build on the latter so they agree on what plots.
- **Invalidation taxonomy:** text/params → regenerate that element; transform → re-place only;
  feeds/Z/preamble/offset → re-emit only.
- Stages currently in Rust: generate, clip, optimize. `place`/`filters` are the only pure-geometry
  TS bits left (trivial/inactive); fold them in if/when consolidating the pipeline into one Rust
  pass (which would also drop the redundant clip↔optimize marshal).

## WASM boundary

Flat CSR typed arrays (`src/core/wasm/serde.ts` ↔ `geom.rs`): `xy`(f32, interleaved),
`pressure`(f32/pt), `offsets`(u32, nStrokes+1), `pen`(u16), `reversible`(u8), `group`(u32). Every
Rust geometry fn returns `GeometryBuffers` → one decode path in JS (the worker uses the same
`serde.ts`, transferring buffers back). Main-thread WASM is instantiated **before first render**
(`main.tsx` gates on `initWasm()`), so clip/optimize/`substitution_note` are **synchronous** in app
code; **handwriting generation is the exception** — it's async, in the worker (see above). After
reading a returned struct's arrays, call `.free()`. Build with `wasm-pack --target web`; `@wasm`
alias → `crate/pkg` (gitignored, regenerated).

## Coordinate spaces (plotter bugs live in the seams)

element-local mm → **page mm** (top-left origin, +Y down; via `element.transform`) →
**machine mm** (`toMachine`: Y-flip iff `origin === 'bottom-left'`) → **G-code** (`− penOffset`,
the nozzle command).
- The **canvas/document is always page space** (top-left, Y-down). The `origin` profile setting
  ONLY affects: the page→machine Y-flip, drawable-region placement, the status-bar readout, and the
  origin marker. It does **not** flip the editor.
- Status bar shows **machine-frame** coords (origin-aware): **Pen** = `toMachine(cursor)`;
  **Nozzle** = `pen − offset` (the literal G-code), shown only when offset x/y ≠ 0.

## Pen offset model

Pen sits at `nozzle + offset`. G-code commands the nozzle ⇒ `commanded = penTarget − offset` (incl.
Z). Reachable area = `bed ∩ (bed + offset)` = the drawable region; the rest of the paper is greyed
out and **clipped away** (`clip` splits strokes at the boundary). `drawableRegion(profile)` (TS,
view-adjacent) computes the rect; the clipping itself is Rust.

## Machine profile (editable; presets in `store/profiles.ts`)

`bed, origin, feeds, penZ{up,down,dwell}, penOffset{x,y,z}, pens, preamble, postamble`.
- **Preamble** = machine init only (G21/G90/G28). The **initial pen-up is generated by `emit`**
  (offset-correct Z), not hardcoded in the preamble.
- **Postamble** = raw user text; ends with a hardcoded high `G0 Z30` clearance lift, intentionally
  *not* offset-adjusted.
- **Park point** = `penParkInPage(profile)` = pen position after homing (nozzle home + offset, in
  page space). Seeds the optimizer start + the preview's first travel.

## Conventions & gotchas

- **Konva Transformer keeps its handles screen-constant itself** — pass plain pixel values
  (`anchorSize={10}`), do NOT divide by `scale` (double-compensates → handles invert with zoom).
  Ordinary shapes *inside* the scaled Layer DO need `/scale` for screen-constant size (origin
  marker, axis ticks).
- **Numeric inputs use `type="text"`** (`Num` in `Inspector.tsx`), not `type="number"` — number
  inputs report `""` mid-typing and clobber negatives/decimals. Local edit string, commit on valid
  parse, ArrowUp/Down to step.
- **Stays in TS deliberately:** `canvas/viewport.ts` (fit/clamp — view-state, DOM-coupled),
  `drawableRegion` (view-adjacent rect), `preview/toolpath.ts` (per-frame render loop), `emit`
  (string assembly), `serde` (the boundary itself).
- Guard `<Stage>` until the host has non-zero size, else Konva `drawImage` throws on a 0×0 canvas.
- Element geometry is **memoized on a stable hash of geometry-affecting params** (`registry.ts`);
  transform/feed edits never regenerate.
- Pen width renders **constant in physical mm regardless of element scale**
  (`strokeScaleEnabled={false}`, width = `PEN_WIDTH_MM × pxPerMm`).
- Handwriting defaults to `globalOptimize = false` → locked chain, natural reading order. Other
  element types are always free singletons in the optimization bag.

## Stack & state

React 18 + TS + Vite. Zustand stores: `document` (authoritative — elements + profile + selection),
`viewport` (pan/zoom + fit), `cursor` (status-bar position), `preview` (playback). Konva /
react-konva, with the Layer scaled so **1 unit = 1 mm**. The canvas is a *view*; the store is always
authoritative (Transformer changes are read back into the store on transform-end).

## Dev

`npm run dev` (predev builds wasm) · `npm run build` (prebuild wasm + tsc + vite) ·
`npm run build:wasm`. Requires Rust + `wasm32-unknown-unknown` target + `wasm-pack`.
