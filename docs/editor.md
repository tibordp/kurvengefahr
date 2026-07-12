# The editor

The canvas is the machine's bed at true scale: one canvas unit is one millimeter, and the page
outline is exactly the plottable area of the selected [machine profile](machines.md). What you
compose is what plots -- the same geometry drives the screen, the preview, and the output.

## Documents

Documents autosave continuously to your browser (the dot next to the document icon fades once a
change is saved). The document menu in the toolbar holds the document commands: create, rename,
duplicate, delete, switch between recent documents, and save/open as a [`.kgz` file](file-format.md)
for backup or moving between machines. Several tabs can hold different documents of the same
library; edits sync across tabs.

Undo (`Cmd/Ctrl Z`) covers everything -- geometry, params, machine settings -- and the history
survives a page reload.

## Tools

Each tool is one key (hover any button for its shortcut; press `?` for the full reference):

| Key | Tool |
| --- | --- |
| `V` | Select |
| `R` | Rectangle |
| `O` | Ellipse |
| `N` | Polygon / star |
| `P` | Pen (Bézier) |
| `F` | Freehand |
| `B` | Flood fill |
| `T` | Handwriting |
| `Y` | Text |
| `G` | Generative pattern |
| `L` | Logo program |
| `X` | Fiducial (registration point) |

A straight line is the pen tool with two clicks; a star is a polygon with the inspector's Star
toggle. Flood fill clicks any enclosed region -- every visible stroke acts as a boundary -- and
turns the area into a regular hatch-filled path.

## Selecting and arranging

Click selects, drag on empty canvas rubber-bands, `Shift`-click adds and removes,
`Cmd/Ctrl A` selects all. The selection handles resize and rotate; the inspector's Transform
section gives exact numbers, plus flip and alignment for multiple elements. Arrow keys
nudge by 1 mm (`Shift` for 10 mm). Copy, cut, and paste go through the real system clipboard, so
they work across documents, tabs, and windows; pasting an image from the clipboard creates an
[image element](elements.md#images-raster-tracing).

Elements snap to the grid while moving and resizing (hold `Alt` to bypass); the grid toggle and
spacing live in the status bar. Stroke order on paper is the optimizer's business, not a visual
stacking order -- see [plotting](plotting.md#stroke-order).

The elements panel lists everything in the document: click to select, and each row has hide,
rename, and delete. The filter box narrows long documents by name or type.

## The inspector

The right-hand panel follows the selection. For any element it shows the pen, pressure (line
weight), dash pattern, the [effect stack](effects.md), and the exact transform; below that come
the selected type's own controls -- text and font settings, tracing method, generative knobs, and
so on, covered per type in [elements](elements.md). With several elements selected it also offers
alignment, boolean operations, and combine/weld -- see [paths](elements.md#shapes-and-paths).

The **Machine** tab holds the machine profile ([machines](machines.md)), and **Preferences** the
theme and your saved Logo tools.

## Editing paths

Any path (and any shape after a boolean) is node-editable in place: with the element selected,
click a node to grab it, drag midpoints to insert nodes, `Del` removes, double-click toggles
corner/smooth, and `Alt`-dragging a handle breaks its symmetry. The full gesture list is in the
`?` dialog. Editing an element that has effects shows the pre-effect source as a ghost outline,
so you always manipulate the real geometry.

## Command palette and shortcuts

`Cmd/Ctrl K` opens the command palette -- every command, searchable, including ones that have no
button. `?` opens the shortcut reference. `Shift 1` fits the whole page in view, `Shift 2` the
selection.

## On a phone

The same app adapts below tablet width: the inspector becomes a drawer (toggle it from the
toolbar, or double-tap any element), the document menu collapses to a single button with rename
inside, and the Logo code editor goes fullscreen, sized to the on-screen keyboard, with an eye
button to peek at the drawing while you edit. Live plotting over USB works wherever the browser
offers Web Serial; everything else is touch-friendly.
