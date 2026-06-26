# Kurvengefahr

A browser-based CAM tool for pen plotters. Compose on a virtual bed -- handwriting, vector shapes,
imported SVG, traced photos -- preview the exact toolpath, and download G-code. Everything runs
client-side; nothing is uploaded.

**[Live app](https://kurven.ojdip.net)** -- installable PWA, works offline. Built for a Prusa MK4
with a spring-loaded pen holder; the machine profile is editable.

<!-- Screenshots go here -- e.g. ![Kurvengefahr](docs/overview.png). -->

## Features

- **Handwriting** -- Type text and a recurrent neural network (Graves' handwriting model) renders it
  as real handwriting, not a font. Consistent across words and reproducible per text/seed/bias.
- **Shapes and paths** -- Rectangles, ellipses, lines, Bézier paths, and freehand. Edit points and
  curve handles on the canvas: add/delete nodes, rubber-band and multi-select, drag several at once,
  toggle corner/smooth, break handle symmetry.
- **Booleans** -- Union, subtract, intersect, and exclude on closed shapes, holes included.
- **SVG import** -- Vector art becomes native, editable paths. Overlapping fills are clipped to their
  visible area so hidden regions don't plot, colors map to the nearest pen, and fill darkness sets
  hatch density.
- **Raster tracing** -- Restyle an image as strokes: contour outlines, topographic levels, hatching,
  scanlines, a single TSP tour, flow fields, or spirals, with live preview.
- **Hatch fills** -- A pen can't lay solid ink, so closed shapes fill with lines, cross-hatch, grid,
  concentric rings, or a Hilbert curve at an adjustable density.
- **Multi-pen output** -- Assign a pen per element; the job is grouped by color with a pause to swap
  pens between colors, and each color's strokes are ordered to cut pen travel.
- **Reachable area** -- Account for the pen's offset from the nozzle; anything the pen can't reach is
  greyed out and clipped away.
- **Registration** -- An optional fiducial point the plot travels to and pauses at, so you can
  position the paper before the first stroke.
- **Preview** -- Scrub and play back the whole toolpath -- travel moves, pen lifts, and draws --
  before downloading the G-code.
- **Elements tree** -- A searchable, collapsible list of every element with named groups; selection
  is synced both ways with the canvas.
- **Documents** -- Multiple drawings in tabs, autosaved, with cross-tab sync, undo/redo that survives
  a refresh, and `.kgz` export.
- Light/dark themes, grid snapping, clipboard image paste, and a responsive layout that collapses to
  a drawer on small screens.

## How it works

Every mark -- handwriting, a shape, an imported path, a traced image -- reduces to the same thing: a
list of pen-down polylines in millimetres. That representation flows through one pipeline (place on
the page, clip to the reachable area, optimize stroke order, emit G-code), so adding a new input type
never touches the machinery downstream.

The app is client-only React, but all the geometry -- the handwriting model, shape and path math,
polygon booleans, SVG parsing and occlusion, image tracing, clipping, and path optimization -- is
Rust compiled to WebAssembly (the `kg_core` crate). The handwriting model and image tracing run in
Web Workers so the UI stays responsive.

## Building

```bash
npm install
npm run dev        # builds the wasm crate, then starts Vite
npm run build      # wasm + tsc + vite build
```

Requires the Rust `wasm32-unknown-unknown` target and `wasm-pack`. After changing `crate/`, rebuild
with `npm run build:wasm`. The Rust crate has tests (`cargo test`), including a NumPy reference that
validates the handwriting model.

Push to `main` and GitHub Actions deploys to GitHub Pages at kurven.ojdip.net.
