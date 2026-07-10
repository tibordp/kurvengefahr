# Logo

The Logo element runs a turtle-graphics program and plots what the turtle draws. The dialect is
UCB-style Logo: procedures with real recursion, dynamic scoping, lists as both data and code,
seeded randomness. Programs re-run live as you edit (in a Web Worker, hard-limited so a runaway
loop can't hang anything), and everything is deterministic for the same source, parameters, and
seed.

All distances are millimeters. The turtle starts at the element's anchor (where you clicked),
heading up, pen down. Heading 0 is up and turns are clockwise-positive, textbook Logo style; on
the page, `fd` moves up and `rt 90` turns to the right.

## Writing programs

Select a Logo element and press Edit code (or double-click it) for the editor: syntax
highlighting, live diagnostics (parse errors as you type, plus the exact line of a failed run),
and autocomplete with the full vocabulary and your own procedures. While the editor is open, a
small green turtle on the canvas marks where the program ends up (position and heading) -- so you
can grow a drawing by appending to the end.

```logo
; Classic square, Logo style.
repeat 4 [fd 40 rt 90]

; Procedures, with recursion (tail calls run in constant space).
to spiral :len
  if :len > 120 [stop]
  fd :len
  rt 91
  spiral :len + 1.5
end
spiral 2
```

Comments run from `;` to the end of the line. Names are case-insensitive. Logo parses greedily by
arity -- `fd 10 rt 90` works because `fd` is known to take one input -- and infix arithmetic binds
inside arguments (`fd :n + 5` moves by `:n + 5`). Use parentheses for grouping or to pass extra
inputs to the variadic reporters: `(sum 1 2 3)`.

## Parameters: knobs in the inspector

`param` declares a variable that surfaces as an inspector control:

```logo
param "petals 6 [3 24]   ; name, default, optional [min max] -> slider
param "sides 5 [3 12 1]  ; optional third range item: step (values snap to the grid)
param "size 40           ; no range -> plain number field
```

The declaration is real code -- it defines `:petals` -- and the inspector stores only your
overrides on the element, so the program keeps its own defaults. Declarations must be literal and
top-level to become knobs (anything else still runs, with a warning).

## Pens, pressure, randomness

- `setpen 1` switches to the second pen of the machine's palette mid-program; the plot pauses for
  a swap between colors. A Logo element is natively multi-pen, so it has no single pen picker.
- `setpressure 0.4` sets how hard the pen presses (0 to 1) for what follows -- it renders as line
  weight and plots as pen force on machines with variable pressure.
- `random 10`, `pick [red green blue]`, and `rerandom` draw from a generator seeded by the
  element's seed knob (shown when the program uses randomness) -- re-roll for a new arrangement,
  same seed for the same one.
- Strokes plot in the order the program drew them, pen by pen -- drawing order is part of the
  composition. "Global optimize" in the inspector hands them to the travel optimizer instead,
  which reorders (and reverses) them freely to minimize pen-up travel.

## Custom tools

Save a program as a tool (inspector, "Save as tool") and it appears in the tool sidebar for every
document: click it, then click the canvas to stamp a fresh element with that program, named after
the tool. Stamped elements are self-contained copies -- editing one never changes the tool.
Right-click a tool for rename/delete; the inspector's Preferences tab manages the whole library,
including import and export as a JSON file for sharing.

## Vocabulary

Motion: `forward`/`fd`, `back`/`bk`, `right`/`rt`, `left`/`lt`, `home`, `setxy`, `setpos`, `setx`,
`sety`, `setheading`/`seth`, `arc` (around the turtle, UCB-style), `arc2` (walk an arc; positive
degrees curve right). Reporters: `xcor`, `ycor`, `pos`, `heading`, `towards`.

Pen: `penup`/`pu`, `pendown`/`pd`, `setpressure`, `pressure`, `setpen`, `pen`.

Control: `repeat` + `repcount`, `if`, `ifelse`, `for [i start end step?]`, `while`, `foreach`,
`map`, `filter` (templates use `?`), `run`, `to` ... `end`, `output`/`op`, `stop`.

Variables: `make`, `local`, `localmake`, `thing`, `param`.

Math: `sum`, `difference`, `product`, `quotient`, `remainder`, `modulo`, `minus`, `abs`, `int`,
`round`, `sqrt`, `power`, `exp`, `ln`, `log10`, `sin`, `cos`, `tan`, `arctan` (degrees), `pi`,
`min`, `max`, and the infix operators `+ - * / = <> < > <= >=`.

Words and lists: `word`, `list`, `sentence`/`se`, `fput`, `lput`, `first`, `last`,
`butfirst`/`bf`, `butlast`/`bl`, `item`, `count`, `empty?`, `list?`, `number?`, `word?`,
`member?`, `reverse`.

Logic: `and`, `or`, `not`, `true`, `false`. Random: `random`, `pick`, `rerandom`.

`print` and `show` are accepted for compatibility but print nothing (there is no console).

## Limits

Programs are cut off deterministically, never by a timer: 5 million evaluation steps, 256 frames
of non-tail call depth (tail recursion is free), 2 million points, and 200,000 strokes. Hitting a
limit reports the offending line like any other error, and the canvas keeps the last successful
geometry.
