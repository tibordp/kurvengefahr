# Plotting and export

Everything on the canvas reduces to pen strokes in millimeters, and the same strokes drive the
screen, the preview, and every output - what you see is what plots. The
[machine profile](machines.md) decides how those strokes become motion; this page covers the
parts you use day to day.

## Pens and pressure

The machine profile carries a pen palette. Colors are display-only (the plotter draws with
whatever you clamp into it) - what matters is that **palette order is plot order**: the job
draws everything for the first pen, pauses so you can swap, then continues with the next. Each
element picks its pen in the inspector; Logo programs can also
[switch pens mid-program](logo-tutorial.md#pens-and-pressure).

Pressure (0 to 1) is an element's line weight. On screen it renders as stroke width; on machines
set up for it - a spring-loaded holder with a light-touch Z configured, see
[machines](machines.md) - it plots as actual pen force, interpolated along the stroke. Some
elements modulate pressure per point (the pressure-hatch tracing method, taper, Logo's
`setpressure`), and the element's own pressure knob scales on top of that.

## Stroke order

Within each pen, a travel optimizer reorders (and, where safe, reverses) strokes to minimize
pen-up travel. Elements whose drawing order is part of the
composition are treated with respect: handwriting plots in natural writing order, and Logo
programs plot in the order the program drew, unless the element's Global optimize toggle hands
its strokes to the optimizer.

The reachable area is the bed intersected with what the pen can actually reach (on machines with
a pen offset the two differ); anything outside is greyed out in the editor and clipped from the
job, never silently moved.

## The fiducial

The fiducial tool (`X`) places a registration point. A job begins by traveling there and pausing
with the pen up, so you can line the paper up against a known point before the first stroke -
essential for plotting onto pre-printed stock or adding a second layer. It is a document
property, not an element: it makes motion but no mark.

## Preview

Preview (the toolbar's play button) shows the exact toolpath: every stroke in plot order, travels
included, with a scrubbable timeline and a moving pen playhead - `Space` plays and pauses. It is
the same geometry and the same ordering the machine will get, so surprises show up here, not on
paper.

## Getting it on paper

By machine kind (all from the toolbar):

- **G-code plotters** - Generate G-code (`Cmd/Ctrl S`) downloads the job for any sender or
  printer. With a PrusaLink printer bound in the profile, Plot sends it straight to the printer
  through the companion Bridge browser extension.
- **AxiDraw / EBB** - Plot streams the job live over Web Serial (the app does the motion
  planning), with pause and resume that land exactly, a live playhead, and a walk home at the
  end. There is no file in between.
- **GRBL** - both: download GRBL-flavored G-code, or stream the byte-for-byte same moves live
  over Web Serial while the board's own position reports drive the progress display.

Machine-specific behavior - homing, pen actuation, pausing semantics - is covered in
[machines](machines.md).

## Vector and raster export

Export (in the document menu) renders what would plot:

- **SVG** - vector, real millimeters, one layer per pen.
- **PDF** - vector, one page at exactly the bed size.
- **PNG** - transparent raster at a resolution you choose.

Print (`Cmd/Ctrl P`) prints the page at true physical scale - a paper proof you can lay on the
bed before committing ink.
