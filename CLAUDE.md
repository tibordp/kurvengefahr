# Kurvengefahr — pen-plotter CAM

Browser CAM for a pen plotter (Prusa MK4 + spring-loaded pen-holder toolhead: Z = pen up/down +
pressure, X/Y = position). Client-only React/TS SPA. Generate G-code in the browser, download,
plot. Inputs: handwriting (the original MVP), text, vector shapes/paths, SVG and DXF import, raster
stylization, and generative primitives — all reduced to the same `Stroke[]` IR.

This file is the *why* and the non-obvious invariants — the stuff you can't grep. Mechanical detail
(field lists, function names, arch numbers) is intentionally left to the code; don't re-document it
here. **Where things go:** project memories hold only workflow & communication preferences;
anything all contributors' agents should know lives here in CLAUDE.md.

**Keep `README.md` current:** when you add a major feature or rework an existing one, update the
README *if it changes what the app can do* (it's the user-facing feature list, house style: no emoji,
`--` not em-dash, American spelling). Skip it for internal-only changes.

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
- `pressure` (per-point, 0..1) — the element's single `DocElement.pressure` is **stamped onto its
  points at concatenation** (in `place`, called from `buildPageGeometry`), exactly like `pen`: a
  cheap re-place/re-emit, never a regenerate; multi-pen types carry per-member pressure instead.
  `emit` maps it to the pen-down Z, interpolating `penZ.downLight` (light) → `penZ.down` (full).
  **`penZ.downLight` is the pressure switch** (`pressureEnabled()`): absent ⇒ pen up/down only, every
  stroke at `down`, and the per-element control is disabled in the UI (value kept). On the canvas +
  preview, pressure shows as line weight only (display, not the real tip width). A future *natively
  variable-pressure* element sets per-point pressure in its generator and opts out of stamping.
- `reversible` — optimizer may flip stroke direction.
- `group` — nonzero = one **locked, ordered, contiguous chain** (a handwriting element); 0 = free
  singleton in the global optimization bag.

**Fiducial** (`document.fiducial`) is the exception that proves the rule: a page-space alignment
point that makes **motion but no mark**, so it's a top-level document property — not an element, not
in the Stroke IR. `emit` prepends a start-of-print move over it at high clearance + an `M0` pause.

## Element types (`src/elements`)

Handwriting plus vector shapes (`shapes/`: `rect`, `ellipse`, `path`), all on the `Stroke[]` IR via
registry `generate()`. Non-obvious bits:

- **Containers are real elements, not tags.** `group` and `clip` are registered element types with
  `container: true` (no generator). Membership is a single `DocElement.parent` (the container's id);
  a member's `transform` is **container-local** and composes up the `parent` chain
  (`effectiveTransform`), so a container moves/scales as one nested object. A `group` just unions its
  members; a `clip` additionally clips them to a mask member (`clipRole: 'mask'`). Composition lives
  in `clipGeometry.ts` (`groupLocalGeometry`/`clipLocalGeometry`), rendered by one `ContainerNode`.
  Grouping (`createGroup`) tags members + appends an identity-transform container after them (z-order
  invariant: members precede their container); `ungroup`/`unclip` bake the container transform back
  into members. Deleting a container cascades to members (`withDescendants`); empty containers are
  pruned (`pruneEmptyContainers`).
- **Non-destructive filters** (`src/filters`, `crate/src/filters/`): a per-element `DocElement.filters`
  stack (roughen / smooth / wave / sketch / twist / bulge) applied in Rust, in **local space before
  `place`**,
  via `filteredLocal`. The **source stays editable** — a `path`'s nodes still edit its *pre-filter*
  shape; the canvas draws the post-filter strokes with the pre-filter outline shown as a faint ghost
  (`GhostLayer`, a read-only overlay) when selected. Filters compose with containers: a member's
  filters apply inside the group, then the container's own filters apply over the combined result —
  so a group/clip warp is **one coherent field**. Like raster, the param *union* crosses the WASM
  boundary as one JSON string (`filters::FilterSpec` is the schema); adding a filter = a Rust submodule
  + match arm + serde fields + a `src/filters/registry.ts` entry (which the inspector renders
  generically). Seeded filters (roughen/sketch) are deterministic per `seed`. Filters are NOT a
  geometry param (they live beside `pen`/`pressure`), so editing them never regenerates.

- **Tool ≠ type:** the line/pen/freehand tools all create a `path` (`{nodes, closed}`, handles
  relative to anchor; zero-length handle ⇒ corner, so polyline + Bézier share one type).
- **Tessellation + fill are Rust** (`crate/src/shapes.rs`, `hatch.rs`), called *synchronously* from
  each `generate()` (main-thread WASM, like clip). After any Rust change, `npm run build:wasm`. All
  the geometry **tolerances + tessellation resolution** (curve flattening, arc/circle/spline steps,
  DXF simplify/weld, cleanup) live in one place: `crate/src/tess.rs` — tune fidelity vs point count
  there, not at scattered call sites.
- **Resize bakes scale into params** (real W/H, radii, node coords) via the registry `applyScale`
  hook, resetting `scaleX/Y=1`. Handwriting has no hook → it keeps scale in its transform. Corner
  radius is absolute mm and deliberately does NOT scale.
- The in-progress drawing **draft is a separate tiny store** so pointer ticks don't re-render the
  canvas. A selected `path` shows draggable anchors/handles (`NodeEditLayer`) instead of the
  Transformer.
- **Snapping is grid-only** (`store/snap.ts`; Alt bypasses) — object/point snapping was removed by
  request.
- **Raster is a stylization layer, not one tracer** (`crate/src/raster/`, worker-backed like
  handwriting): one uploaded image, `method` picks how it becomes strokes (outline/topographic/
  hatch/scanlines/TSP/flow/spiral). Each method is a Rust submodule reading a shared inkness
  `Grid` + the union `Params`; adding one = submodule + match arm + an inspector control. Two
  non-obvious seams: (1) **params cross the boundary as a JSON string**, not flat buffers — the one
  exception to the CSR-buffer rule below, because the param *union* outgrew a positional signature
  (`raster::Params` with serde is the schema; the worker just `JSON.stringify`s `RasterParams`, and
  Rust ignores the non-geometry keys). (2) **Every method auto-regenerates live** (debounced,
  off-thread — all fast enough, even 50k-point TSP), so there's *no* manual Regenerate for raster
  (only handwriting's slow model run is manual). The worker caches the decoded image by `imageId` so
  a param-only edit re-runs only the Rust, not the decode. The randomized methods (tsp/flow, in
  `SEEDED_METHODS`) are deterministic per `seed` (re-roll = new arrangement).

## Pipeline (`src/core/pipeline`)

generate (Rust, per element, **memoized**) → **filter** (Rust filter stack, local mm, **memoized**) →
place (affine local→page) → clip (Rust, to drawable rect) → optimize (Rust, per-pen + chain-aware
greedy NN) → emit (G-code).

- `filteredLocal(el)` (`clipGeometry.ts`) is the single local-geometry accessor — it applies the
  element's filter stack to its pre-filter `baseLocal` (a generator's output, or a *container's*
  composition of already-filtered members), memoized on (base ref + `filters` ref). **Everything that
  renders/composes/plots goes through it** (ElementNode, ContainerNode, buildPageGeometry,
  convertToPath, marquee/hover bounds), so the canvas shows exactly what plots.
- `buildPageGeometry` = generate+filter+place (+pen/pressure/group stamping, dashing);
  `buildPlottableGeometry` = +clip. Both **Generate and Preview** build on the latter, so they agree
  on what plots.
- **Invalidation taxonomy** (keeps it snappy): text/params → regenerate that element;
  **filters**/transform/**pen**/pressure → re-filter/re-place only (never a regenerate);
  feeds/Z/preamble/offset → re-emit only.
- `place` is the only pure-geometry TS bit left; fold it into Rust if/when consolidating the pipeline
  into one pass (which also drops the clip↔optimize marshal).

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

## Undo / redo (`src/store/history.ts`)

Snapshot history over `useDoc` (elements + profile + fiducial; selection is restored but not its own
step). Snapshots are just the current references — `useDoc` is strictly immutable, so no deep clone.

- A single `useDoc.subscribe` captures changes; a content fingerprint (`fp`, **excludes
  selectedIds**) means selection-only changes and `notifyGeometry()` ref-bumps create **no** entry.
- **Coalescing into one step:** continuous canvas gestures wrap with `beginGesture()`/`endGesture()`
  (the end is microtask-deferred because Konva fires dragend/transformend **once per selected
  node** — a burst that must collapse to one transaction). Inspector field/slider sessions need
  **no** wrapping: a global `focusin`/`focusout` bracket coalesces them (the Konva canvas isn't
  focusable, so the two never collide). **Any new continuous gesture must wrap with
  `beginGesture`/`endGesture`.**
- undo/redo go through `loadDocument`, so autosave persists the result; a `restoring` flag keeps
  history from re-recording it.
- **Per-tab persistence** (best-effort, **sessionStorage only — never long-term**): the stack
  survives refresh / bfcache back-nav / switching docs and back. `documents.ts` orchestrates the
  seams — on *leaving* a document state (switch, or `pagehide`/`visibilitychange:hidden`) it
  **flushes the autosave AND `leave()`s the stack**, both stamped with the same content fingerprint;
  on *entering* (boot, switch-to) it `enter()`s, restoring only if the saved fingerprint matches the
  loaded doc (else fresh). The paired flush is load-bearing: without it localStorage lags the
  in-memory doc and the fingerprint check would always drop the stack. A cross-tab remote replace
  `reset()`s (drops history); on any sessionStorage write failure the whole key is nuked and
  in-memory history continues.

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
