# Browser API

The app installs a small automation surface at `window.kurvengefahr` - for userscripts, browser
extensions, and headless tooling. It is deliberately small; every member is meant to stay
compatible, so new capabilities are added rather than existing ones changed.

Two conventions hold throughout:

- **Nothing returns live state.** Every result is detached plain data; mutating it does not touch
  the document.
- **Inputs are sanitized.** Anything you pass in goes through the same coercion imports use -
  unknown fields are dropped, missing ones are defaulted - so malformed input degrades to defaults
  instead of corrupting the document.

All coordinates are page millimeters: origin at the top-left of the bed, +Y down, regardless of the
machine's own origin.

## Documents

- `importDocument(data)` - import a `.kgz` container (as `ArrayBuffer`, `Uint8Array`, or `Blob`)
  as a new document and bind this tab to it. Resolves to `{status: 'ok'}` or
  `{status: 'invalid' | 'unsupported', message}`; never throws.
- `exportDocument()` - the active document as a `.kgz` `Blob`, referenced image blobs included.
- `getDocument()` - the active document as plain JSON: the same envelope as `document.json` inside
  a `.kgz` (raster elements reference their image blobs by id; the blobs themselves only travel in
  the container).

## Elements

- `listElements()` - light metadata for every element in z-order:
  `{id, type, name?, pen, parent?, hidden?}`.
- `addElement(type, params?, at?)` - add an element of any registered type (`rect`, `ellipse`,
  `polygon`, `path`, `text`, `handwriting`, `generative`, `raster`, `logo`, ...) at a page-space transform
  `{x, y, rotation?, scaleX?, scaleY?}`, and select it. Partial params are fine - see the
  sanitization convention above. Returns the new element's id, or `null` for an unknown type. The
  param shapes are the same ones the `.kgz` format persists; they are defined in
  `src/elements/*` (each type's `defaultParams` is the best reference).
- `selectElements(ids)` - replace the selection; unknown ids are ignored.

## Output

- `getPlottableGeometry()` - the machine-neutral strokes that would plot, as
  `{pen, points: [{x, y, pressure?}, ...]}[]`: generated, effected, placed in page mm, and clipped
  to the reachable area. Exactly what G-code generation and the preview agree on.
- `buildGcode()` - the full G-code string for the document. Resolves to `null` on an empty
  document or a non-G-code machine (an AxiDraw plots live over serial; there is no file artifact);
  rejects when the machine profile is invalid.
- `renderSvg()` - what would plot, as an SVG `Blob` (one layer per pen, real mm). Same output as
  Export.
- `renderPng(pxPerMm?)` - the same, as a transparent PNG `Blob`.

## App state

- `generationStatus()` - `{busy, errors}` for worker-backed generation (handwriting, raster
  tracing, Logo programs). `busy` stays true while any such element still lacks settled geometry; `errors` lists
  elements whose generation failed (those never settle). Poll this before reading geometry or
  taking a screenshot.
- `fitView()` - fit the bed into the viewport (same as the toolbar zoom-to-fit).

## Example

Add a hatched hexagon, wait for nothing (shapes are synchronous), and save the result as SVG:

```js
const kg = window.kurvengefahr
kg.addElement(
  'polygon',
  { rx: 25, ry: 25, sides: 6, hatch: { pattern: 'lines', spacing: 2, angle: 30 } },
  { x: 120, y: 90 },
)
const url = URL.createObjectURL(kg.renderSvg())
window.open(url)
```

Handwriting is the asynchronous exception - after adding one, poll `generationStatus()` until
`busy` is false:

```js
kg.addElement('handwriting', { text: 'hello from a userscript' }, { x: 20, y: 40 })
while (kg.generationStatus().busy) await new Promise((r) => setTimeout(r, 250))
const gcode = await kg.buildGcode()
```
