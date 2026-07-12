# Effects

Effects are non-destructive passes over an element's strokes: the source stays fully editable
(selected elements show it as a ghost outline), and removing an effect returns exactly the
original geometry. They live in the inspector's Effects section, stack in order from top to
bottom, and each one can be toggled, reordered, or removed independently. Containers take effects
too -- a roughen on a group roughens the composed result, clip mask and all.

Effects apply in the element's own space, so they travel with it: move, rotate, or scale the
element and the effect follows. The seeded ones have a re-roll button for a fresh random
variation; the same seed always reproduces the same result.

## The effects

- **Roughen (hand-drawn)** -- displaces strokes with a smooth positional noise field plus an
  optional fine tremor, so precise geometry reads as drawn by hand. Amount and detail set the
  displacement and its wavelength. Strokes that share endpoints stay joined -- patterns made of
  touching tiles deform without tearing. Seeded.
- **Smooth** -- the opposite: subdivides and relaxes, rounding corners and ironing out jitter.
  Resolution, strength, and iterations.
- **Wave / warp** -- a sinusoidal displacement across the element: amplitude, wavelength, axis
  angle, phase, and a harmonics count (1 is a pure sine; more sums overtones into an organic
  warp).
- **Sketch (overdraw)** -- replaces each stroke with several wandering passes, like searching
  pencil lines. Passes and per-pass offset. Seeded.
- **Twist / swirl** -- rotates geometry about the element's center, fading out toward a radius.
- **Bulge / pinch** -- pushes geometry radially outward (+) or inward (−) about the center,
  fading toward a radius.
- **Taper (calligraphy)** -- fades pen pressure toward each open stroke's ends over a length you
  set, for entry/exit strokes that thin like a lifted pen. Pressure-only: it needs a machine with
  [variable pressure](plotting.md#pens-and-pressure) to show on paper (on screen it always shows
  as line weight).
- **Offset (inset / outset)** -- grows (+) or shrinks (−) the element's stroke region by a
  distance in mm, like Inkscape's inset/outset. Open strokes are treated as closed end-to-start;
  nested contours count as holes, so an outset makes text bolder and a donut's wall thicker. An
  inset past a shape's inradius collapses it to nothing.
- **Hull (outline)** -- keeps only the outermost boundary of the element's strokes and discards
  everything inside: overlapping shapes merge into one silhouette, holes and interior detail
  vanish, separate islands each keep their own outline. The Convex toggle takes the convex hull
  instead -- one taut loop around everything. Open strokes are treated as closed end-to-start,
  like offset.

Offset and hull work per pen: a multi-color element keeps its colors, each treated as its own
region.

## Flatten

The Flatten button below the stack bakes the current effected result into a plain, node-editable
path and consumes the effect stack -- the point of no return, for when you want to hand-tune what
an effect produced. Until then, everything stays live: effect edits never regenerate the element,
they just re-apply.
