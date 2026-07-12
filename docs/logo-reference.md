# Logo reference

The dialect is UCB-style Logo: procedures with real recursion, dynamic scoping, lists as both
data and code, and seeded randomness. Programs are deterministic -- the same source, parameter
values, and seed always draw the same thing. New to Logo? Start with the
[tutorial](logo-tutorial.md).

## Syntax

Comments run from `;` to the end of the line. Names are case-insensitive (`FD`, `fd`, and `Fd`
are the same command).

The values:

- **Numbers** -- `40`, `-3.5`. All distances are millimeters, all angles degrees.
- **Words** -- `"petal` is the word itself (quoted, not evaluated); words also arrive as list
  items. Booleans are the words `true` and `false`.
- **Lists** -- `[fd 10 rt 90]` or `[30 45 60]`. A list literal is *data*: nothing inside runs
  until something like `run`, `repeat`, or `if` executes it as code, or `pick`/`foreach` walks it
  as values.
- **Variables** -- `:size` reads the variable `size` (shorthand for `thing "size`).

Logo has no statement separators; it parses **greedily by arity**. Every command has a known
number of inputs, so `fd 10 rt 90` is unambiguous: `fd` takes one input, then `rt` starts a new
call. User procedures parse the same way, which is why they can be called before their `to`
definition appears -- the whole program is scanned for procedure headers first.

Infix arithmetic mixes freely with prefix calls, binding tighter than the command around it:
`fd :n + 5` moves by `:n + 5`. Precedence, loosest to tightest: comparisons
(`= <> < > <= >=`), then `+ -`, then `* /`, then unary minus. Parentheses group, and also pass
extra inputs to the variadic reporters: `(sum 1 2 3)`, `(max :a :b :c)`.

Procedures are defined with `to … end` at the top level:

```logo
to name :input1 :input2
  …
  output :input1 + :input2   ; optional -- makes it a reporter
end
```

`output` returns a value from the procedure; `stop` returns without one. A procedure call in
tail position runs in constant space -- tail recursion is the canonical Logo loop and never
exhausts the call depth; only non-tail recursion (work left to do after the recursive call, like
the fractal tree's `bk`) counts against the depth limit.

Scoping is **dynamic**, textbook Logo: `:x` finds the nearest binding up the call stack, then the
globals. `make "x 5` assigns the nearest existing binding, creating a global if none exists;
`local "x` (or `localmake "x 5`) binds `x` in the current procedure so callees see it but callers
keep theirs.

Inside `map`, `filter`, and `foreach` templates, `?` is the current item:
`map [? * 2] [1 2 3]` is `[2 4 6]`.

## The turtle

The turtle starts at the element's anchor (where you clicked when creating it), heading 0,
**pen down**, pressure 1, pen 0. Heading 0 is up and positive turns are clockwise -- textbook
Logo -- so `fd` moves up the page and `rt 90` faces right. Coordinates are mm, x right, y up,
relative to the start.

### Motion

| Command | Aliases | Inputs | Does |
| --- | --- | --- | --- |
| `forward` | `fd` | dist | Move forward dist mm, drawing if the pen is down. |
| `back` | `bk` | dist | Move backward dist mm, drawing if the pen is down. |
| `right` | `rt` | deg | Turn clockwise by deg degrees. |
| `left` | `lt` | deg | Turn counterclockwise by deg degrees. |
| `home` | | | Return to (0 0) heading 0, drawing if the pen is down. |
| `setxy` | | x y | Move to (x y) in mm, drawing if the pen is down. |
| `setpos` | | pos | Move to pos, a two-number list `[x y]`. |
| `setx` | | x | Move horizontally to x, keeping y. |
| `sety` | | y | Move vertically to y, keeping x. |
| `setheading` | `seth` | deg | Face heading deg (0 = up, clockwise). |
| `arc` | | deg radius | Draw an arc of deg degrees at radius around the turtle, starting at its heading, clockwise. The turtle does not move. |
| `arc2` | | deg radius | Walk an arc of deg degrees along a circle of the given radius; positive deg curves right. The turtle ends on the arc, turned by deg. |

### Position reporters

| Reporter | Inputs | Reports |
| --- | --- | --- |
| `xcor` | | The turtle's x coordinate (mm). |
| `ycor` | | The turtle's y coordinate (mm). |
| `pos` | | The turtle's position as a list `[x y]`. |
| `heading` | | The turtle's heading in degrees (0 = up, clockwise). |
| `towards` | pos | The heading from the turtle to pos, a two-number list `[x y]`. |

### Pen

| Command | Aliases | Inputs | Does |
| --- | --- | --- | --- |
| `penup` | `pu` | | Lift the pen: moves stop drawing. |
| `pendown` | `pd` | | Lower the pen: moves draw. |
| `setpressure` | | p | Set pen pressure for what follows: 0 lightest to 1 full. |
| `pressure` | | | Reports the current pressure. |
| `setpen` | | n | Switch to pen n of the machine's palette (0 is the first pen). |
| `pen` | | | Reports the current pen number. |

## Control

| Command | Aliases | Inputs | Does |
| --- | --- | --- | --- |
| `repeat` | | n block | Run block n times. |
| `repcount` | | | The current `repeat` iteration, counting from 1. |
| `if` | | cond block | Run block if cond is true. |
| `ifelse` | | cond then else | Run then if cond is true, else otherwise. Outputs the branch's value if it has one. |
| `for` | | control block | `for [i start end step?] […]` -- run the block with `:i` counting from start to end. |
| `while` | | cond block | Run block as long as the cond list evaluates true. |
| `foreach` | | data template | Run template once per item of data, with `?` as the item. |
| `map` | | template data | The list made by evaluating template (with `?`) for each item of data. |
| `filter` | | template data | The items of data for which template (with `?`) is true. |
| `run` | | block | Run a list as instructions; outputs its value if it has one. |
| `output` | `op` | value | Return value from the current procedure. |
| `stop` | | | Return from the current procedure without a value. |

## Variables

| Command | Inputs | Does |
| --- | --- | --- |
| `make` | name value | Set variable name (a quoted word) to value. Creates a global if no local exists. |
| `local` | name | Declare name (a quoted word, or list of them) local to the current procedure. |
| `localmake` | name value | Declare name local and set it to value. |
| `thing` | name | The value of the named variable -- `thing "x` is the same as `:x`. |
| `param` | name default | Declare an inspector-adjustable parameter (see below). |

### `param`

```logo
param "size 40           ; number field, default 40
param "petals 6 [3 24]   ; slider from 3 to 24
param "sides 5 [3 12 1]  ; slider with step 1 (snaps to integers)
```

`param` defines the variable (`:size`) *and* surfaces it as an inspector control. The element
stores only values you changed, so the program text keeps its own defaults, and sliders re-run
the program live. To become a knob, a declaration must be literal and at the top level; a
computed or nested `param` still runs as an ordinary definition, with a warning in the editor.

## Math

| Reporter | Inputs | Reports |
| --- | --- | --- |
| `sum` | a b… | a + b. Parenthesize for more: `(sum 1 2 3)`. |
| `difference` | a b | a − b. |
| `product` | a b… | a × b. Parenthesize for more. |
| `quotient` | a b | a ÷ b. |
| `remainder` | a b | Remainder of a ÷ b, with the sign of a. |
| `modulo` | a b | a modulo b, with the sign of b. |
| `minus` | a | −a. |
| `abs` | a | Absolute value. |
| `int` | a | Truncate toward zero. |
| `round` | a | Round to the nearest integer. |
| `sqrt` | a | Square root. |
| `power` | a b | a raised to b. |
| `exp` | a | e to the a. |
| `ln` | a | Natural logarithm. |
| `log10` | a | Base-10 logarithm. |
| `sin` `cos` `tan` | deg | Trigonometry on angles in degrees. |
| `arctan` | a | Arctangent, in degrees. |
| `pi` | | 3.14159… |
| `min` | a b… | The smallest input. Parenthesize for more. |
| `max` | a b… | The largest input. Parenthesize for more. |

The infix operators `+ - * /` and `= <> < > <= >=` map onto the same arithmetic and comparisons
(`<>` is "not equal").

## Logic

| Reporter | Inputs | Reports |
| --- | --- | --- |
| `and` | a b… | True if all inputs are true. |
| `or` | a b… | True if any input is true. |
| `not` | a | True if a is false. |
| `true` / `false` | | The boolean constants. |

## Words and lists

| Reporter | Aliases | Inputs | Reports |
| --- | --- | --- | --- |
| `word` | | a b… | The words joined into one word. |
| `list` | | a b… | A list of the inputs. |
| `sentence` | `se` | a b… | A flat list: list inputs are spliced in. |
| `fput` | | item list | A copy of list with item added at the front. |
| `lput` | | item list | A copy of list with item added at the end. |
| `first` | | x | The first item of a list, or first character of a word. |
| `last` | | x | The last item of a list, or last character of a word. |
| `butfirst` | `bf` | x | Everything but the first item/character. |
| `butlast` | `bl` | x | Everything but the last item/character. |
| `item` | | n x | The nth item (1-based) of a list or word. |
| `count` | | x | The number of items in a list, or characters in a word. |
| `empty?` | `emptyp` | x | True if x is an empty list or word. |
| `list?` | `listp` | x | True if x is a list. |
| `number?` | `numberp` | x | True if x is a number. |
| `word?` | `wordp` | x | True if x is a word (numbers count). |
| `member?` | `memberp` | item x | True if item is in the list x (or a substring of the word x). |
| `reverse` | | x | The list (or word) reversed. |

## Randomness

| Command | Inputs | Does |
| --- | --- | --- |
| `random` | n | A random integer from 0 to n−1. |
| `pick` | list | A random item of the list. |
| `rerandom` | n | Re-seed the random sequence with n. |

Randomness draws from a generator seeded by the element's seed knob (the knob appears as soon as
a program uses any of these). The same seed reproduces the same drawing; the re-roll die
explores variations.

`print` and `show` are accepted for compatibility with textbook programs but do nothing -- there
is no console to print to.

## Limits

Programs are cut off deterministically, never by a timer:

- 5 million evaluation steps
- 256 frames of non-tail call depth (tail recursion is free)
- 2 million points
- 200,000 strokes

Hitting a limit reports the offending line like any other error, and the canvas keeps the last
successful drawing. Parse errors squiggle as you type; runtime errors point at the exact line
after the run.
