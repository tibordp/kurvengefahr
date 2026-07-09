# The `.kgz` file format

A `.kgz` is an ordinary zip archive -- rename it and any unzip tool will open it:

```
document.json        the document (deflated)
images/<id>.png      one entry per referenced raster image (stored; PNG is already compressed)
```

## `document.json`

```json
{
  "kind": "kurvengefahr/document",
  "schemaVersion": 8,
  "document": {
    "name": "Showcase",
    "elements": [ ... ],
    "profile": { ... },
    "selectedIds": [ ... ],
    "fiducial": null
  }
}
```

- `elements` -- the drawing, in z-order. Each element is `{id, type, transform, params, pen}` plus
  optional fields (`name`, `effects`, `pressure`, `dash`, `parent`, `clipRole`, `hidden`). Param
  shapes are per-type and defined in `src/elements/*`; groups and clips are elements too, with
  membership expressed by the member's `parent`.
- `profile` -- the machine profile, a union on `kind` (`prusa` | `axidraw`). See
  [machines](machines.md).
- `fiducial` -- the optional registration point, or `null`.
- Raster elements reference their image by `params.imageId`, matching an `images/` entry. On import
  the ids are re-minted, so containers never collide with images already in the browser's store.

Units are millimeters throughout; page coordinates have their origin at the top-left of the bed
with +Y down. Generated geometry is never stored -- handwriting and traced images regenerate on
load, deterministically for the same params and seed.

## Compatibility

Loading is total: a corrupt file, a foreign file, or a document from a different app version
degrades gracefully, never crashes.

- **Older documents** load in a newer app: stepwise migrations bump the shape where needed, and
  sanitizers backfill anything missing from defaults. Elements of unknown type are dropped with a
  console warning; everything else survives.
- **Newer documents** (a `schemaVersion` above what the app knows) are refused as unsupported --
  reported, and the bytes left untouched -- rather than partially loaded and mangled.

The same schema and rules govern the document copies the app keeps in `localStorage`; only the
wrapper differs (stored documents carry their id and timestamps instead of the file envelope).

## Sidecar JSON files

Two device-global libraries export as plain JSON files (not zipped), with the same envelope
pattern and compatibility rules:

- `{"kind": "kurvengefahr/profiles", "schemaVersion": ..., "profiles": [...]}` -- saved machine
  profiles (Machine tab).
- `{"kind": "kurvengefahr/tools", "schemaVersion": ..., "tools": [...]}` -- saved Logo tools
  (Preferences tab); each tool is `{id, name, source}`. Imports merge with fresh ids.
