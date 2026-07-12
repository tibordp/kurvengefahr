# Kurvengefahr docs

The user manual. The [README](../README.md) has the quick feature tour; these pages cover how the
app actually works, aimed at someone comfortable with vector tools and plotters.

Using the app:

- [The editor](editor.md) -- documents, the canvas, tools, selection, node editing, the inspector,
  undo, keyboard shortcuts, and the mobile layout.
- [Elements](elements.md) -- every kind of mark: shapes, paths, text, handwriting, generative
  patterns, traced images, 3D wireframes, and imports.
- [Effects](effects.md) -- the non-destructive effect stack, every effect, and flattening.
- [Plotting and export](plotting.md) -- pens, plot order, the toolpath preview, G-code, live
  plotting, and SVG/PDF/PNG/print export.
- [Sharing](sharing.md) -- read-only snapshot links and the privacy model behind them.
- [Machines](machines.md) -- what a machine profile means, for G-code plotters, AxiDraw, and GRBL.

The Logo language:

- [Logo tutorial](logo-tutorial.md) -- turtle graphics from zero: movement, procedures, recursion,
  parameters, pens, and randomness.
- [Logo reference](logo-reference.md) -- the complete dialect: syntax, semantics, every builtin,
  and the runtime limits.

For tooling built on top:

- [File format](file-format.md) -- the `.kgz` container and how compatibility is handled.
- [Browser API](browser-api.md) -- the `window.kurvengefahr` surface for userscripts, extensions,
  and headless automation.
