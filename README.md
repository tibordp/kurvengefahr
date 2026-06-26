# Kurvengefahr

Browser CAM for a pen plotter — built for a Prusa MK4 with a spring-loaded pen-holder toolhead
(Z = pen up/down + pressure, X/Y = position). Design in the browser, generate G-code, download it,
drop it on the machine. Client-only SPA; every bit of "fancy" geometry runs in Rust → WASM.

Live at **[kurven.ojdip.net](https://kurven.ojdip.net)** (installable PWA). Named after *Achtung, die
Kurve!* — hence the signal-red neon accent.

## What it does

Everything that makes marks becomes the same intermediate representation — a `Stroke` (one pen-down
polyline in mm) — so every input below flows through one shared place → clip → optimize → emit
pipeline and out as G-code.

**Inputs / elements**

- **Handwriting** — a real **Graves RNN-MDN** (1308.0850) ported from pretrained weights to pure
  scalar Rust (no TF.js, no JS ML). Generates a word at a time in a Web Worker, teacher-forced on a
  golden exemplar so every word shares one consistent hand; deterministic per `(text, seed, bias)`.
- **Vector shapes** — rectangle (rounded corners), ellipse, and a full **Bézier path** type.
  The line / pen / freehand tools all produce paths.
- **Multi-contour paths** — a path holds many subpaths, so it carries holes and disjoint pieces;
  closed contours fill with **even-odd parity** (a contour nested in another punches a hole).
- **Boolean operations** — union / subtract / intersect / exclude between selected closed shapes
  (robust polygon booleans via `i_overlay`), producing one combined multi-contour path.
- **On-canvas node editing** — select / rubber-band / shift-multi-select control points and move
  them together; insert a node on a segment (real cubic split), delete, toggle corner ↔ smooth,
  Alt-drag to break handle symmetry.
- **SVG import** — parse a real SVG (usvg: nested transforms, groups, styles, shape→path) into
  native, editable paths. Overlapping fills are **occluded** in paint order (so hidden area never
  plots), fill colour maps to the nearest pen, and fill darkness maps to hatch density. Imports drop
  into one collapsed group so a busy file doesn't flood the tree.
- **Raster stylization** — one uploaded image, many ways to turn it into strokes (outline /
  topographic / hatch / scanlines / TSP / flow field / spiral), worker-backed and live.

**Fills** — a pen can't lay solid ink, so closed shapes hatch: lines, cross-hatch, grid, concentric
contours, or a space-filling Hilbert curve.

**Toolpath & output**

- **Pen-offset model** — the pen sits at `nozzle + offset`; the reachable area is `bed ∩ (bed +
  offset)` and the rest of the paper is greyed out and clipped away.
- **Per-pen optimizer** — chain-aware greedy nearest-neighbour ordering that keeps each pen's strokes
  contiguous (pen swaps are manual `M0` pauses, plotted in palette order) and flips reversible
  strokes to cut travel.
- **G-code** — editable machine profile (bed, feeds, pen Z + pressure, pen palette, preamble /
  postamble / pause macro), a start-of-print **fiducial** (travel + pause to register the medium),
  live **toolpath preview** with playback, and download.

**Workspace**

- **Grouped elements tree** — every element in a searchable, collapsible tree; flat groups
  (group / ungroup / rename), multi-select with shift-range and ⌘-toggle, fully synced with the
  canvas selection, hover-to-highlight.
- **Multi-document**, per-tab, autosaving to `localStorage` with cross-tab live sync; undo/redo that
  survives refresh; import/export a `.kgz` bundle.
- **PWA** (offline-capable; the ~7 MB model blob is runtime-cached), **dark mode**, responsive
  (the inspector becomes a drawer on small screens), grid snapping, paste-image-from-clipboard.

## Architecture

The whole app pivots on one IR: a `Stroke` is one pen-down polyline in millimetres; a `Geometry` is
an ordered `Stroke[]`. **Everything that makes marks produces it; everything that makes motion
consumes it.** Adding an input type is just a new `generate()` — nothing downstream changes.

```
element.generate()  →  place      →  filters   →  clip          →  optimize        →  emit
(local mm, memoized)   (page mm)     (Stroke→    (to reachable     (per-pen, chain-    (page→machine
                       affine        Stroke)      region)           aware NN)          + G-code)
```

Invalidation taxonomy (keeps it snappy):

- change `text` / `params` → re-`generate()` that element (the expensive step)
- change `transform` / `pen` → re-`place` only (cheap)
- change feeds / Z / preamble → re-`emit` only (geometry untouched)

**The cardinal rule:** all geometry/toolpath compute lives in Rust (`crate/`, the `kg_core` crate,
compiled to WASM). TypeScript owns the app shell, UI, view-state, and the WASM-boundary marshalling —
nothing more. The boundary speaks flat `Float32Array` / `Uint32Array` buffers (CSR-style), not
serde'd objects.

### Layout

```
crate/  (kg_core → WASM: all the "fancy" compute)
  src/lib.rs              WASM entry points
  src/model.rs, compose.rs, typeset.rs   handwriting RNN · alphabet substitution · word layout
  src/shapes.rs, hatch.rs boundary tessellation · even-odd hatch fills
  src/boolean.rs, svg.rs  polygon booleans (i_overlay) · SVG import (usvg) + occlusion
  src/raster/             image → strokes (outline/topographic/hatch/scanlines/TSP/flow/spiral)
  src/clip.rs, geom.rs    rectangle clipping · the IR + flat CSR boundary
src/core/                 types (IR + MachineProfile) · WASM loader + serde · the pipeline
src/elements/             type registry → generate(), with per-element memoization
src/store/                Zustand document store · persistence · history · machine profiles
src/canvas/               Konva stage (1 unit = 1 mm) · element nodes · node-edit + drawing tools
src/ui/                   toolbar · inspector (elements tree, machine, preferences) · dialogs
src/output/               G-code emit · download · .kgz container
```

The canvas is a *view*; the store is always authoritative. Handwriting generation and raster
stylization run off the main thread (their own WASM instances in Web Workers); everything else —
shape tessellation, clipping, booleans, SVG import, optimization — is synchronous main-thread WASM.

## Develop

```bash
npm install
npm run dev        # builds the wasm crate (predev), then starts Vite
npm run build      # wasm + tsc + vite build
npm run typecheck  # tsc only
```

Requires the Rust `wasm32-unknown-unknown` target and `wasm-pack`. After any change in `crate/`,
rebuild with `npm run build:wasm`. Rust has gold tests (`cargo test` in `crate/`), including a NumPy
twin that validates the handwriting model's math.

## Deploy

Push to `main` → GitHub Actions builds (wasm + tsc + vite) and publishes to GitHub Pages, served at
the custom domain **kurven.ojdip.net**.
