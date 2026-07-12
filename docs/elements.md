# Elements

Everything on the canvas is an element: a transform you manipulate on the canvas, plus parameters
you edit in the inspector. Whatever the type, an element ultimately produces pen strokes - so
every element takes a pen, a pressure (line weight), a dash pattern, and an
[effect stack](effects.md), and everything below composes freely.

## Shapes and paths

**Rectangle, ellipse, polygon** are parametric shapes; the polygon covers stars via the Star
toggle (inner radius becomes editable). Closed shapes have a Fill section: stroke only, fill
only, or both, where the fill is a hatch - lines, cross-hatch, grid, concentric, Hilbert curve,
gradient hatch, scribble, stipple, Voronoi, Truchet tiles, spiral, or maze - with a density in
mm (and an angle where it applies). A pen lays down lines, not areas, so hatching *is* how a
plotter fills.

**Paths** come from the pen tool (click for corners, click-drag for curve handles), the freehand
tool, or any import. Corner and smooth nodes mix freely on one path, and everything is
node-editable in place - see [editing paths](editor.md#editing-paths). A path with closed
contours gets the same Fill section as a shape.

With several closed shapes selected, the inspector offers **boolean operations** - union,
subtract (upper shapes cut the bottom one), intersect - which produce one editable path.
**Combine** merges selections into one multi-contour compound path (even-odd: enclosed regions
become holes); **Break apart** undoes that. **Weld** joins open contours that share endpoints
into continuous lines - useful before plotting hand-drawn or imported linework so the pen lifts
less. **Flood fill** (the `B` tool) clicks any region enclosed by visible strokes and creates a
hatch-filled path of exactly that region, holes included.

## Text

Two modes. **Single-line** uses Hershey engraving fonts (Sans, Sans Bold, Serif, Serif Bold,
Script, Gothic) - each glyph is a centerline stroke, the classic plotter look, ideal for small
text. **Outline** uses real TTF outlines (Sans, Serif, Mono): closed glyph contours you can leave
as outlines or fill with any hatch; counters (the holes in O, A, e) come out correctly.

Layout is honest typesetting, not stroke scattering: font metrics, kerning, letter and line
spacing, and a wrap width with left/center/right/justify alignment.

## Handwriting

A recurrent neural network (Graves' handwriting synthesis model) writes your text as actual
handwriting - generated stroke by stroke, not a font. The knobs: size, line height, wrap width
and alignment, slant, word and paragraph spacing, plus two that shape the hand itself: **seed**
(a different random variation of the same text) and **neatness** (loose and natural through neat
and legible). The same seed and settings always reproduce the same ink.

Generation runs a real model, so it takes a moment: edits mark the element stale (it dims) and
you regenerate explicitly with the toolbar's Regenerate button - tweak as many knobs as you
like, then run once. By default the strokes plot in natural writing order; the Global optimize
toggle releases them to the [travel optimizer](plotting.md#stroke-order) instead.

## Generative patterns

One element type, five generators, all deterministic per seed: **Spirograph** (hypotrochoid
gears), **L-system** fractals (Koch, dragon, Sierpinski, plant, Hilbert presets),
**Truchet tiles** (arcs or diagonals), **Voronoi** diagrams, and **flow fields**. Each has its
own small set of knobs plus a seed with a re-roll button where randomness is involved; resizing
on canvas bakes into the pattern's box, so it regenerates crisp at the new size.

## Images (raster tracing)

Import a photo or drawing (file import, or just paste an image) and restyle it as strokes. One
image, ten renderings, switchable live:

- **Outlines** - faithful contour tracing of dark regions, with threshold, smoothing, and
  despeckle controls.
- **Centerline** - skeleton tracing for line art: one stroke down the middle of each line.
- **Topographic** - iso-tone contour lines, like a terrain map of the image's darkness.
- **Hatch** - engraving-style tonal cross-hatch, darker areas gaining crossing layers.
- **Pressure hatch** - a single even hatch where darkness rides on pen pressure (for machines
  with [variable pressure](plotting.md#pens-and-pressure)).
- **Scanlines** - horizontal squiggle lines, wiggle amplitude proportional to darkness.
- **TSP** - one continuous line threaded through a density-weighted point cloud.
- **Voronoi** - a mosaic with small cells where the image is dark.
- **Flow field** - streamlines flowing along the image's edges.
- **Spiral** - one Archimedean spiral, radially modulated by the image.

All methods share invert (trace the light instead) and a faint source-image underlay you can
toggle while composing. Tracing re-runs live as you adjust, off the main thread.

## 3D models

Import an STL and orbit it in an interactive preview; the element renders a plottable wireframe
of the model's feature edges - silhouettes, creases past a tunable angle, and boundaries -
with hidden lines removed (occluded) or kept (transparent), under a perspective or orthographic
camera.

## Logo programs

A full turtle-graphics language for parametric, procedural drawing - from "draw a square" to
recursive trees and multi-pen rosettes. It gets its own pages: start with the
[tutorial](logo-tutorial.md), then the [reference](logo-reference.md).

## Groups and clips

Containers are real elements: select several elements and group them to move, scale, effect, and
pen them as one; members keep their identity and are editable from the elements panel.
A **clip** masks its members to a shape, non-destructively and nestably - select the elements
plus the mask shape on top and choose Clip to shape. Double-click a clip to enter it and edit a
member in place. Effects on a container apply to the composed result - see
[effects](effects.md).

## SVG and DXF import

Vector imports become native, editable paths - not embedded pictures. SVG arrives at its
real-world size (or fit to a size you choose), colors are mapped onto the machine's pens, filled
regions can gain a hatch of your choosing, and regions a fill occludes are clipped away so hidden
linework does not plot. DXF (the common CAD interchange) imports the drawing entities at actual
size, with a unit override for files that omit or lie about theirs. Both show a live summary in
the import dialog before anything lands on the canvas.
