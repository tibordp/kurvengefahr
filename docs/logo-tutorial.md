# Logo tutorial

The Logo element draws with a **turtle**: a pen-holding cursor you steer with commands. `fd 40`
moves it 40 mm forward, drawing a line; `rt 90` turns it 90 degrees right. Everything a Logo
program draws plots like any other element -- so a few lines of code become a parametric,
re-rollable, multi-pen drawing. This page assumes no Logo; if you know the language, skip to the
[reference](logo-reference.md).

To start: pick the Logo tool (`L`), click the canvas, and the code editor opens under the canvas
with a small default program. Programs re-run live as you type; syntax errors and the exact line
of a failed run show up as squiggles, and autocomplete knows the whole vocabulary. If you ever
want them back, the editor's "Insert example" menu holds commented starter programs covering the
same ground as this tutorial.

## Moving the turtle

The turtle starts where you clicked, facing up, pen down. Distances are millimeters, turns are
degrees:

```logo
fd 40     ; forward 40 mm, drawing
rt 90     ; turn 90° clockwise
bk 10     ; backward 10 mm
lt 45     ; turn 45° counterclockwise
```

`repeat` runs a bracketed block several times -- the classic square:

```logo
repeat 4 [fd 40 rt 90]
```

Lift the pen to move without drawing, and put it back down:

```logo
fd 20  pu  fd 10  pd  fd 20    ; a dashed segment by hand
```

Two arc commands cover curves: `arc 90 20` draws a quarter circle of radius 20 *around* the
turtle without moving it, while `arc2 90 20` makes the turtle *walk* the arc, curving right (a
negative angle curves left). `arc2 360 20` is a full circle you can drive through.

## Procedures

`to name … end` defines a command; inputs are named with a colon:

```logo
to petal :len
  arc2 60 :len
  rt 120
  arc2 60 :len
  rt 120
end

repeat 6 [petal 40 rt 60]
```

Procedures can call themselves. This is *the* Logo idiom -- a spiral is a procedure that draws a
little, turns, and calls itself slightly bigger, until a stopping test:

```logo
to spiral :len
  if :len > 120 [stop]
  fd :len
  rt 91
  spiral :len + 1.5
end
spiral 2
```

Recursion also branches. The fractal tree draws a trunk, then becomes two smaller trees -- note
how it walks back down (`bk`) so each branch starts from the right place:

```logo
to tree :len :depth
  if :depth = 0 [stop]
  fd :len
  lt 25
  tree :len * 0.72 :depth - 1
  rt 50
  tree :len * 0.72 :depth - 1
  lt 25
  bk :len
end
tree 40 7
```

Arithmetic works infix (`:len + 1.5`, `360 / :petals`) right inside arguments, and comparisons
(`=`, `<`, `>`, `<>`, …) drive `if`/`ifelse` and `while`. A handful of other loops exist --
`for [i 1 10] [...]` counts, `foreach`/`map`/`filter` walk lists -- all in the
[reference](logo-reference.md#control).

## Knobs: `param`

`param` declares a variable that appears as a control in the inspector:

```logo
param "petals 6 [3 24]    ; name, default, [min max] -> a slider
param "sides 5 [3 12 1]   ; optional third item: step (snaps to whole numbers)
param "size 40            ; no range -> a plain number field

repeat :petals [petal :size rt 360 / :petals]
```

Sliders re-run the program live -- your program becomes an instrument you play from the
inspector. The declaration is real code (it defines `:petals`), and the element stores only your
overrides, so the program text keeps its own defaults.

## Pens and pressure

A Logo element can draw with the whole machine palette. `setpen 1` switches to the palette's
second pen for what follows (pens count from 0); at plot time the job pauses for a swap between
colors, like any multi-pen document:

```logo
param "count 18 [4 48]
repeat :count [
  setpen modulo repcount 2    ; alternate pens 0 and 1
  arc2 360 16
  rt 360 / :count
]
```

`setpressure 0.4` sets how hard the pen presses (0 to 1) -- it shows as line weight on screen and
plots as pen force on machines with [variable pressure](plotting.md#pens-and-pressure). Ramping
it mid-drawing gives strokes that swell and fade:

```logo
for [i 0 288] [
  setpressure 0.1 + 0.9 * :i / 288
  fd 0.05 * :i
  rt 10
]
```

## Randomness

`random 6` is a random integer 0 to 5; `pick [30 45 60]` picks from a list. Randomness is
seeded: the element gets a seed knob (with a re-roll die) as soon as a program uses it, the same
seed always draws the same thing, and re-rolling explores variations:

```logo
param "steps 200 [20 800]
repeat :steps [
  fd 2 + random 6
  rt -60 + random 121
]
```

## Working with the canvas

While the editor is open, a small green turtle on the canvas marks where the program *ends* --
position and heading -- so growing a drawing is appending to the end. The element moves, scales,
and rotates like any other, takes [effects](effects.md), and by default plots its strokes in the
order the program drew them (the inspector's Global optimize toggle hands them to the
[travel optimizer](plotting.md#stroke-order) instead).

A runaway loop cannot hang anything: programs run in the background against fixed
[limits](logo-reference.md#limits), and an over-budget run reports its line like any other error
while the canvas keeps the last good drawing.

## Keeping programs

Save a program as a **tool** (the hammer icon in the editor, or the inspector) and it appears in
the tool sidebar in every document: click it, then click the canvas to stamp a fresh element with
that program. Stamped elements are self-contained copies -- editing one never changes the tool.
The Preferences tab manages the library, including import and export as a JSON file for sharing.

From here, the [reference](logo-reference.md) has the full language: every builtin with its
inputs, the syntax rules that make `fd 10 rt 90` parse, list operations, and the exact semantics
of variables and procedures.
