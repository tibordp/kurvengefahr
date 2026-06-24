# Kurvengefahr — pen-plotter CAM

Browser CAM for a pen plotter (Prusa MK4 + spring-loaded pen-holder toolhead: Z = pen up/down +
pressure, X/Y = position). Client-only React/TS SPA. Generate G-code in the browser, download,
plot. MVP input is handwriting; vector (SVG/DXF) and raster line-art are designed-for, not built.

This file is the *why* and the non-obvious invariants — the stuff you can't grep. Mechanical detail
(field lists, function names, arch numbers) is intentionally left to the code; don't re-document it
here. **Where things go:** project memories hold only workflow & communication preferences;
anything all contributors' agents should know lives here in CLAUDE.md.

## Cardinal rule

**All "fancy" geometry/toolpath compute lives in Rust** (`crate/`, compiled to WASM). TS owns the
app shell, UI, view-state, and the WASM boundary marshalling — nothing more. New geometry
computation goes in Rust unless it's genuinely view-coupled (per-frame render loop, or DOM
viewport math). **No TF.js / no JS ML** — the handwriting model is a pure-Rust forward pass.
Future input types (SVG/DXF, raster) will be their own `generate()` producing the same Geometry IR
— not implementations of a shared model trait. The unifying abstraction is `Stroke[]`, not a trait.

**Prefer concrete over speculative** — clean abstractions, no fallbacks/placeholders kept around as
junk (handwriting is *always* the model, with no stub fallback).

## Handwriting model (`crate/src/model.rs`, `compose.rs`) — runs in a **Web Worker**

A real **Graves RNN-MDN** (1308.0850), ported from the pretrained `sjvasquez/handwriting-synthesis`
weights as pure scalar Rust. The decisions that shape the surrounding code:

- **Word at a time, off the main thread.** Generation runs in a dedicated worker with its *own*
  WASM instance + model blob; **the main thread never loads the model**. Per-*word* (not per-line)
  because the model is far more reliable on short sequences. `core/generation.ts` is the controller
  (supersede-on-edit, word-granular progress, status store).
- **Golden-sample priming → one consistent hand.** Every word is teacher-forced on one bundled
  *golden* exemplar so all words share a hand; the per-word `seed` varies letterforms within it.
  (Earlier line-based + previous-line priming drifted into scribble; per-word + fixed golden is
  stable.) The primed state is computed once and cloned per word, so priming is ~free.
- **Async generation seam.** Handwriting is the one *async* element type — the worker posts placed
  geometry after each word and the canvas fills in word by word. Everything else generates
  synchronously (see WASM boundary).
- **Manual regeneration.** Editing params does **not** auto-regenerate (only a brand-new element
  auto-generates once, so it appears); edits mark the element *dirty* and dim its ink, with a
  Regenerate affordance. So tweaking several params is one run, not N.
- **Weights** are an f16 blob (committed), **lazily fetched** by the worker on first use. The raw TF
  checkpoint is **not** committed; `tools/` derives the blob and the NumPy twin (`reference.py`)
  validates the math + dumps the Rust gold-test fixtures. Deterministic for `(text, seed, bias)`;
  no fallback (generation requires the model loaded).

## The IR (the waist of everything)

`Stroke` = one pen-down polyline in mm + metadata; `Geometry = Stroke[]`. Defined in
`src/core/types.ts`, mirrored in `crate/src/geom.rs`. **Everything that makes marks produces
Geometry; everything that makes motion consumes it.** Adding a new input type is just a new
`generate()` — nothing downstream changes.

The metadata is what makes the optimizer and emitter work, and each field encodes an invariant:

- `pen` — **stamped at concatenation** (`buildPageGeometry`) from the element's top-level
  `DocElement.pen`, NOT a geometry param — so a pen change is a cheap re-place/re-emit, never a
  regenerate (mirrors `transform`). The optimizer is **per-pen**: each pen's strokes stay contiguous
  and pen groups plot in **palette order**, with the profile's `pause` macro dropped between groups.
  A future *natively multi-colour* element sets per-stroke pens in its generator and opts out of
  stamping via registry `multiPen`.
- `reversible` — optimizer may flip stroke direction.
- `group` — nonzero = one **locked, ordered, contiguous chain** (a handwriting element); 0 = free
  singleton in the global optimization bag.

**Fiducial** (`document.fiducial`) is the exception that proves the rule: a page-space alignment
point that makes **motion but no mark**, so it's a top-level document property — not an element, not
in the Stroke IR. `emit` prepends a start-of-print move over it at high clearance + an `M0` pause.

## Element types (`src/elements`)

Handwriting plus vector shapes (`shapes/`: `rect`, `ellipse`, `path`), all on the `Stroke[]` IR via
registry `generate()`. Non-obvious bits:

- **Tool ≠ type:** the line/pen/freehand tools all create a `path` (`{nodes, closed}`, handles
  relative to anchor; zero-length handle ⇒ corner, so polyline + Bézier share one type).
- **Tessellation + fill are Rust** (`crate/src/shapes.rs`, `hatch.rs`), called *synchronously* from
  each `generate()` (main-thread WASM, like clip). After any Rust change, `npm run build:wasm`.
- **Resize bakes scale into params** (real W/H, radii, node coords) via the registry `applyScale`
  hook, resetting `scaleX/Y=1`. Handwriting has no hook → it keeps scale in its transform. Corner
  radius is absolute mm and deliberately does NOT scale.
- The in-progress drawing **draft is a separate tiny store** so pointer ticks don't re-render the
  canvas. A selected `path` shows draggable anchors/handles (`NodeEditLayer`) instead of the
  Transformer.
- **Snapping is grid-only** (`store/snap.ts`; Alt bypasses) — object/point snapping was removed by
  request.

## Pipeline (`src/core/pipeline`)

generate (Rust, per element, **memoized**) → place (affine local→page) → filters (Stroke→Stroke) →
clip (Rust, to drawable rect) → optimize (Rust, per-pen + chain-aware greedy NN) → emit (G-code).

- `buildPageGeometry` = generate+place+filters; `buildPlottableGeometry` = +clip. Both **Generate
  and Preview** build on the latter, so they agree on what plots.
- **Invalidation taxonomy** (keeps it snappy): text/params → regenerate that element;
  transform/**pen** → re-place only; feeds/Z/preamble/offset → re-emit only.
- `place`/`filters` are the only pure-geometry TS bits left (trivial/inactive); fold them into Rust
  if/when consolidating the pipeline into one pass (which also drops the clip↔optimize marshal).

## WASM boundary

The boundary is flat typed-array (CSR) buffers (`src/core/wasm/serde.ts` ↔ `geom.rs`): every Rust
geometry fn returns one struct → one decode path in JS (the worker uses the same `serde.ts`,
transferring buffers back). After reading a returned struct's arrays, **call `.free()`**.

Main-thread WASM is instantiated **before first render** (`main.tsx` gates on `initWasm()`), so
clip/optimize/`substitution_note` are **synchronous** in app code — **handwriting generation is the
only exception** (async, in the worker). Build with `wasm-pack --target web`; `@wasm` → `crate/pkg`
(gitignored, regenerated).

## Coordinate spaces (plotter bugs live in the seams)

element-local mm → **page mm** (top-left origin, +Y down; via `element.transform`) →
**machine mm** (`toMachine`: Y-flip iff `origin === 'bottom-left'`) → **G-code** (`− penOffset`,
the nozzle command).

- The **canvas/document is always page space** (top-left, Y-down). The `origin` profile setting
  ONLY affects: the page→machine Y-flip, drawable-region placement, the status-bar readout, and the
  origin marker. It does **not** flip the editor.
- Status bar shows **machine-frame** coords (origin-aware): **Pen** = `toMachine(cursor)`;
  **Nozzle** = `pen − offset` (the literal G-code), shown only when the pen is offset in x/y.

## Pen offset model

Pen sits at `nozzle + offset`. G-code commands the nozzle ⇒ `commanded = penTarget − offset` (incl.
Z). Reachable area = `bed ∩ (bed + offset)` = the drawable region; the rest of the paper is greyed
out and **clipped away** (`clip` splits strokes at the boundary). `drawableRegion(profile)` (TS,
view-adjacent) computes the rect; the clipping itself is Rust.

## Machine profile (editable; presets in `store/profiles.ts`)

Non-obvious bits (the rest is in `types.ts`):

- **Pens** = the colour palette; `color` is display-only and the list order **is** the plot order.
- **`pause`** = the shared operator-pause macro (templated `{message}`), reused for pen swaps and
  the fiducial. Only the *pause* is the macro; the positioning **moves** (clearance lift, fiducial
  travel) are emitted by `emit`, which has the pen→nozzle transform. Empty = no pause.
- **Preamble** = machine init only; the **initial pen-up is generated by `emit`** (offset-correct
  Z), not hardcoded. **Postamble** ends with a hardcoded high `G0 Z30` clearance lift, intentionally
  *not* offset-adjusted.
- **Park point** (`penParkInPage`) = pen position after homing; seeds the optimizer start + the
  preview's first travel.

## Conventions & gotchas

- **Keyboard shortcuts are centralised** in `src/ui/shortcuts.ts` — the single source of truth for
  tool keys *and* the Help-dialog reference (`SHORTCUT_GROUPS`, rendered by `HelpDialog`). **When you
  add a user-facing action with a shortcut: register it in `SHORTCUT_GROUPS`, wire the binding in
  `useShortcuts.ts`, and put the key in the control's `title` tooltip.** Keeping these three in sync
  is the rule; the Help dialog updates itself from the list.
- **Icon-only buttons** use the `IconButton` primitive, which *requires* an `aria-label`; pair it
  with a `title` (and the shortcut, if any).
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
  (`strokeScaleEnabled={false}`).
- Handwriting defaults to `globalOptimize = false` → locked chain, natural reading order. Other
  element types are always free singletons in the optimization bag.

## Chrome & UI

App chrome (toolbar, inspector, status bar, preview) is **Tailwind v4** (CSS-first `@theme` tokens
in `src/index.css`). **Build new chrome from `src/ui/primitives.tsx`** (`Button`, `IconButton`,
`Field`, `SectionTitle`, `Banner`, `Modal`, `controlClass`/`textareaClass`) — not ad-hoc utility
soup, which rots as complexity grows.

- **Signature accent = signal red `#E5484D`** — a nod to *Achtung, die Kurve!*, the curve/snake game
  the project is named after (NOT a road sign). Keep neon-trail energy in the accent + logo only.
- **The Konva canvas is finished — do not restyle it.** The render path (`ElementNode`,
  `PreviewLayer`, `viewport.ts`) is off-limits; only the chrome around it is fair game.
- **Responsive**, desktop-primary: below `md` (768px) the inspector becomes a slide-over drawer
  (`store/ui.ts`).

## Persistence (`src/store/persistence`, `documents.ts`, `library.ts`)

- **Multi-document, per-tab.** Each doc is `localStorage['kg-doc:<id>']`; each *tab* binds one doc id
  in `sessionStorage`, so tabs never clash. A fresh tab is blank + unsaved until the first real edit
  (no litter). Two tabs on the same doc live-sync via `storage` events (last-write-wins, with
  echo/focus guards).
- **Autosave** = `useDoc.subscribe` → debounce → **content-diff** (a fingerprint excluding
  `updatedAt`). The diff is load-bearing: `notifyGeometry()` bumps the elements-array ref on every
  generation tick *without changing data*, and the diff makes those writes no-ops. **Don't remove
  it.**
- **Loaders never throw** — they return `{status: ok|unsupported|invalid}`. Backward-compat =
  stepwise migrations + sanitizers backfilling from defaults; forward (a higher `schemaVersion`) =
  `unsupported`, reported and skipped, stored bytes left intact. Bump `CURRENT_*_SCHEMA` + add a
  migration when the persisted shape changes.
- Geometry/viewport/preview are **never persisted**; restored handwriting regenerates for free via
  the App's `syncGeneration` effect (no cached geometry → generate).

## Deployment

Push to **main** → `.github/workflows/deploy.yml` builds (wasm + tsc + vite) and publishes to GitHub
Pages.

- **Pages source must be "GitHub Actions"** (not "Deploy from branch", or the deploy step 404s).
- Served at the custom domain **kurven.ojdip.net** with Vite `base: '/'`, so it only renders there —
  **not** at `tibordp.github.io/kurvengefahr/` (assets resolve from `/`).
- **PWA** (`vite-plugin-pwa`, autoUpdate): the shell is precached; the ~7 MB model blob is
  runtime-cached (CacheFirst), not precached.

## Stack & state

React 18 + TS + Vite; Zustand stores; Konva / react-konva with the Layer scaled so **1 unit =
1 mm**. The `document` store is **authoritative** (elements + profile + selection + fiducial); the
canvas is a *view* — Transformer changes are read back into the store on transform-end.

## Dev

`npm run dev` (predev builds wasm) · `npm run build` · `npm run build:wasm`. Requires Rust +
`wasm32-unknown-unknown` + `wasm-pack`.
