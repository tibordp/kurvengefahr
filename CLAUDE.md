# Kurvengefahr — pen-plotter CAM

Browser CAM for pen plotters. Three machine families: G-code plotters (Prusa printers + a
spring-loaded pen-holder toolhead, or any G-code machine), AxiDraw-style EBB machines (streamed
live over Web Serial), and GRBL 1.1 plotters (G-code download or live Web Serial). Client-only
React/TS SPA. Inputs: handwriting (the original MVP), text, vector shapes/paths, SVG and DXF
import, raster stylization, generative primitives, and Logo programs — all reduced to the same
`Stroke[]` IR.

This file holds only what's useful in *every* context: the architecture to keep in mind, style
preferences, and non-obvious design choices. Area-specific invariants live in that area's module
headers (they're deliberately rich — read them before changing a subsystem). Project memories hold
only workflow & communication preferences; anything all contributors' agents should know lives
here.

## Architecture

**All "fancy" geometry/toolpath compute lives in Rust** (`crate/`, compiled to WASM; `npm run
build:wasm` after any change). TS owns the app shell, UI, view-state, and boundary marshalling —
nothing more. New geometry computation goes in Rust unless genuinely view-coupled (per-frame
render loops, DOM viewport math). No TF.js / no JS ML — the handwriting model is a pure-Rust
forward pass. Geometry tolerances/tessellation resolution are centralized in `crate/src/tess.rs`.

**The IR is the waist**: `Stroke` = one pen-down polyline in mm + metadata (`src/core/types.ts` ↔
`crate/src/geom.rs`). Everything that makes marks produces `Stroke[]`; everything that makes
motion consumes it. A new input type is just a new registry `generate()` — nothing downstream
changes. The unifying abstraction is the IR, not a shared trait.

**The editor targets an *abstract* plotter.** The IR and everything upstream (elements, effects,
optimize, canvas) speak machine-neutral terms: mm, a `pen` index, `pressure` 0..1. Realizing them
as physical motion (Z heights, servo angles, feeds, G-code) is the machine profile + emit/plan
layer's job *alone* — machine concepts must not leak into core copy, IR fields, or generators.
`MachineProfile` is a discriminated union on `kind`, so the compiler enumerates every consumer
when a branch changes.

**Stroke metadata encodes the cheap-invalidation contract:**

- `pen` — stamped at concatenation from `DocElement.pen`, NOT a geometry param, so a pen change
  never regenerates. Natively multi-colour generators (Logo `setpen`, containers) register
  `multiPen` to opt out of stamping. The pen list order **is** the plot order; the optimizer keeps
  each pen's strokes contiguous with an operator pause between groups.
- `pressure` (per-point 0..1) — the element's single pressure is a *gain* applied at concatenation,
  never an overwrite, so variable-pressure generators compose with the knob for free. Rendered as
  line weight on screen; realized per machine (e.g. interpolated pen-down Z) at emit.
- `reversible` — the optimizer may flip the stroke. `group` nonzero = one locked, ordered,
  contiguous chain (handwriting's reading order); 0 = free singleton in the optimization bag.

**Pipeline** (`src/core/pipeline`): generate (Rust, memoized on a stable hash of geometry-affecting
params) → effect (Rust, local mm, memoized) → place (local→page affine) → clip (to the reachable
region) → optimize (per-pen, chain-aware) → emit G-code *or* plan an EBB segment tape, by machine
kind. `effectedLocal` is the single local-geometry accessor everything rendering/plotting goes
through, so the canvas shows exactly what plots. Invalidation taxonomy: params → regenerate;
effects/transform/pen/pressure → re-place; machine settings → re-emit only.

**WASM boundary**: flat CSR typed-array buffers (`src/core/wasm/serde.ts` ↔ `geom.rs`), one decode
path; call `.free()` after reading a returned struct. Main-thread WASM initializes before first
render, so geometry calls are synchronous in app code. The exceptions are the three worker-backed
generators — handwriting (manual regenerate; the model run is slow), raster and Logo (live,
debounced) — each with its own WASM instance behind one shared message protocol/controller
(`core/generation.ts`). Rich param unions cross the boundary as one JSON string (serde struct =
schema) instead of positional args.

**Determinism is a memoization contract**: generation is assumed pure per (params, seed) — the
registry caches on exactly that. Seeded randomness only (re-roll = new seed); never wall-clock
anything in a generator (Logo's runaway limits are deterministic budgets, not timers).

**Coordinate spaces** (plotter bugs live in the seams): element-local mm → page mm (top-left, +Y
down — the editor is *always* page space) → machine mm (Y-flip iff bottom-left origin) → G-code
(minus the pen→nozzle offset). The reachable area is `bed ∩ (bed + offset)`; everything outside is
clipped away, not just greyed out.

**Stack & state**: React 18 + Vite; Zustand stores; Konva with the layer scaled so 1 unit = 1 mm.
The `document` store is authoritative; the canvas is a view (Transformer edits are read back on
transform-end). Persisted state goes through loaders that **never throw** (`Outcome` +
sanitizers + migrations; bump `CURRENT_*_SCHEMA` when a persisted shape changes); generated
geometry/viewport/preview are never persisted. Undo is snapshot history with content
fingerprints — **any new continuous canvas gesture must wrap in `beginGesture`/`endGesture`**.

## Style preferences

- **Prefer concrete over speculative** — no fallbacks/placeholders kept around as junk; build the
  seam when the second consumer arrives.
- **Build chrome from `src/ui/primitives.tsx`** (Button, IconButton, Field, SectionTitle, Banner,
  Modal, Menu, controlClass/textareaClass) — not ad-hoc utility soup. Tailwind v4, tokens in
  `src/index.css`. Signature accent = signal red `#E5484D` (an *Achtung, die Kurve!* nod — keep it
  scarce: accent + logo).
- **Never use native `alert()`/`confirm()`/`prompt()`.** Notifications → `toast` (`store/toast`);
  confirmations and quick naming → `confirmDialog`/`promptDialog` (`store/dialogs`).
- **Shortcuts stay in sync three ways**: register in `SHORTCUT_GROUPS` (`src/ui/shortcuts.ts`, the
  single source of truth + Help dialog), wire in `useShortcuts.ts`, and put the key in the
  control's `title`. Icon-only buttons use `IconButton` (requires `aria-label`; pair with `title`).
- **README and docs/ are user-facing** — the README is the feature tour, docs/ the deeper manual
  (house style: no emoji, plain single `-` for dashes — never `--` or em-dash, American
  spelling). Dev/maintainer material stays out
  of both — it lives in `tools/README.md`, module headers, or here.
- Numeric inputs are `type="text"` with commit-on-valid-parse (`Num`/`SliderNum`) — `type="number"`
  reports `""` mid-typing and clobbers negatives/decimals.

## Pre-commit checklist

Run through this before every commit:

1. **Docs are current** — any feature added or reworked is reflected in README.md (the feature
   tour) and the relevant docs/ page(s).
2. **Screenshots regenerated** — if the change is visible in the UI:
   `node tools/screenshot.mjs docs/showcase.kgz`, then refresh `public/og.png` from it (sips
   commands in `tools/README.md`). Every committed screenshot keeps its source `.kgz` beside it.

## Non-obvious design choices

- **Handwriting** generates per-*word*, primed on one golden exemplar (per-line + chained priming
  drifted into scribble). Regeneration is **manual** (edits mark dirty + dim; N param tweaks = one
  run); only brand-new elements auto-generate. Raster and Logo regenerate **live** instead — they
  are fast and hard-limited.
- **Containers (`group`/`clip`) are real elements**, not tags: membership is `DocElement.parent`,
  member transforms are container-local, z-order invariant is members-before-container.
- **Effects are non-destructive and NOT geometry params** — they apply in Rust in local space, the
  pre-effect source stays editable (ghost outline when selected), and editing them never
  regenerates.
- **Tool ≠ type**: pen and freehand both create `path` (corner node = zero-length handles, so
  polyline and Bézier share one type; a "line tool" is just two pen clicks). Polygon covers stars
  via a flag. Resize bakes scale into params via the registry `applyScale` hook (types without it,
  like handwriting and Logo, keep scale in the transform).
- **Snapping is grid-only** (Alt bypasses) — object/point snapping was removed by request. No
  z-ordering anywhere: strokes have no fill, paint order is invisible, and the optimizer reorders
  for plotting anyway.
- **Fiducial** is a top-level document property, not an element — it makes motion but no mark, so
  it stays out of the Stroke IR.
- **AxiDraw invariants** (details in `crate/src/plan.rs` + `src/output/ebb/`): pause only at rest
  on planner-guaranteed zero-velocity boundaries; quantize *cumulative* motor positions, never
  per-segment deltas; flow control = awaiting the EBB's withheld ack — no self-managed pacing. No
  endstops: home is wherever the operator parked, position is dead-reckoned, so every job ends by
  walking home. Opt-in live hardware suite: `EBB_DEVICE=/dev/cu.usbmodemXXXX npm test`.
- **Autosave's content-diff is load-bearing**: `notifyGeometry()` bumps the elements ref on every
  generation tick without changing data; the fingerprint diff turns those into no-ops. Don't
  remove it. Multi-document = one localStorage key per doc + per-tab binding in sessionStorage,
  cross-tab last-write-wins.
- **Deployment**: push to main → GitHub Actions → Pages at **kurvengefahr.org** (Vite `base: '/'`,
  so it does not render at `tibordp.github.io/...`; Pages source must be "GitHub Actions"). PWA:
  shell precached, the ~7 MB handwriting model runtime-cached.

## Recurring UI gotchas

- Konva Transformer keeps handle sizes screen-constant itself — pass plain px, do NOT divide by
  scale. Ordinary shapes inside the mm-scaled Layer DO need `/scale` for screen-constant size.
- Pen width renders constant in physical mm regardless of element scale
  (`strokeScaleEnabled={false}`). Guard `<Stage>` until the host has non-zero size.
- `Modal`'s `onClose` must be referentially stable — its focus effect re-runs on change and steals
  focus from inputs mid-typing.

## Dev

`npm run dev` (predev builds wasm) · `npm run build` · `npm run build:wasm` · `npm test` (vitest)
· `cargo test` in `crate/` and in `share-api/`. Requires Rust + `wasm32-unknown-unknown` +
`wasm-pack`. Local share stack (Garage + share-api; `npm run dev` targets it via
`.env.development`): `docker compose -f share-api/dev/compose.yml up --build`.
