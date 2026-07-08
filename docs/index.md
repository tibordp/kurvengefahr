# Kurvengefahr docs

Deeper documentation for the parts of Kurvengefahr that outside tools and curious users depend on.
The [README](../README.md) has the feature tour; the source has the rest.

- [Browser API](browser-api.md) -- the `window.kurvengefahr` surface for userscripts, extensions,
  and headless automation.
- [File format](file-format.md) -- the `.kgz` container and how compatibility is handled.
- [Machines](machines.md) -- what a machine profile means, for G-code plotters and AxiDraw.

The screenshots in this directory regenerate through the real app in headless Chrome:

```bash
node docs/screenshot.mjs docs/showcase.kgz   # rewrites docs/showcase.png
```

Any `.kgz` works -- the script imports it, waits for generation to settle, fits the view, and
saves a PNG (see the header of `screenshot.mjs` for options).
