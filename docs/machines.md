# Machines

The editor itself targets an abstract pen plotter: everything upstream of output speaks
machine-neutral terms -- positions in page millimeters, a pen index, a pressure from 0 to 1.
A **machine profile** is what turns that into physical motion. Profiles are editable copies seeded
from a preset, and a profile's *kind* (G-code plotter, AxiDraw, or GRBL) comes from that preset.

Common to all kinds:

- **Bed** -- the plottable area in mm. The canvas page is exactly the bed.
- **Pens** -- the palette. Colors are display-only (a plotter draws with whatever you clamp into
  it); what matters is that list order is plot order, and the job pauses between pens so you can
  swap.
- **Fiducial** -- an optional registration point. The plot first travels there and pauses, so you
  can line up the paper before the first stroke.

## G-code plotters (`prusa` kind)

Built for a 3D printer with a pen in a spring-loaded holder, but any G-code machine with X/Y motion
and a Z axis fits.

- **Pen offset.** The pen sits away from the nozzle; G-code commands the nozzle, so every commanded
  coordinate is `pen target − offset`, including Z. The area the pen can actually reach (the bed
  intersected with its offset copy) is the drawable region -- anything outside is greyed out in the
  editor and clipped from the job.
- **Pen Z.** `up` is travel height, `down` is full pressure. An optional `downLight` (the lightest
  touch) switches per-element pressure on: pressure 0..1 interpolates `downLight` to `down`, and Z
  ramps along a stroke only where pressure actually changes. Without `downLight`, the pen is
  strictly up/down and the pressure control is disabled.
- **Origin.** Bottom-left for most printers; the page-to-machine transform flips Y accordingly. The
  editor always shows top-left/+Y-down page space -- only the emitted coordinates and the status-bar
  readout are origin-aware.
- **Preamble / postamble** -- machine init and shutdown, verbatim. The initial pen-up is emitted by
  the app (offset-correct); the postamble ends with a high clearance lift on purpose.
- **Pause** -- an operator-pause macro with a `{message}` placeholder (e.g. `M0`), used for pen
  swaps and the fiducial stop. Leave it empty for machines with no way to pause.

## EBB plotters (`axidraw` kind)

AxiDraw machines and EBB-compatible plotters like the iDraw family. The app is the whole
toolchain for this kind: it plans the motion itself -- trapezoidal acceleration,
junction-deviation cornering -- and streams it to the EBB board live over Web Serial. Plotting
happens with the Plot button; there is no exported file in between.

- **No endstops.** Home is wherever you park the carriage (top-left, against both stops); the
  board's step counters are zeroed there when a plot starts, and position is dead-reckoned from
  then on.
  Every job -- including a cancelled one -- ends by walking back to home. If the connection drops
  mid-plot, re-park before plotting again.
- **Pausing lands at rest.** The plan guarantees zero-velocity points at least every few seconds;
  pause (from the app or the board's button) takes effect at the next one, so resume is exact.
- **Pauses prompt in the app.** There is no LCD, so pen swaps and the fiducial stop drain the
  motion queue and raise a dialog instead.
- **Motion and servo settings** -- speeds, acceleration, cornering tolerance, servo up/down
  positions and timing -- live on the profile and are editable like everything else.

## GRBL plotters (`grbl` kind)

Covers the wide world of GRBL 1.1 machines -- EleksDraw-style servo plotters, CNC conversions,
homebuilt CoreXY frames. Two outputs from the same job: download GRBL-flavored G-code for any
sender, or stream it live over Web Serial (the file and the stream are byte-for-byte the same
moves). Unlike the AxiDraw, the firmware does its own motion planning -- the app just streams
lines and follows along.

- **Pen actuation is a choice.** A real Z axis (with the same `up`/`down`/`downLight` pressure
  model as G-code plotters), or a servo on the spindle-PWM pin driven with `M3 S…` -- the common
  cheap-plotter setup. Servo `S` semantics vary between firmware forks; the profile's pen-test
  button is there to dial the values in.
- **Homing is a choice.** With limit switches, enable *Home first* and every job starts from `$H`.
  Without them (most hobby plotters), the job's origin is wherever the pen sits when it starts --
  park it at the page origin, like an AxiDraw. Either way the work zero is written with `G10 L20`,
  so even a cancelled job can walk back home.
- **The live view follows the machine.** While streaming, the board's own position reports drive
  the playhead and progress -- what you see is where the pen actually is, not an estimate.
- **Pausing lands between strokes** (pen up, queue drained), so resume is exact. Stopping a plot
  feed-holds, resets the controller, lifts the pen, and returns to the origin.
- **Connection.** Streaming uses Web Serial at the profile's baud rate (default 115200). GRBL
  boards have no fixed USB identity, so the port picker shows every serial device -- the app
  verifies it's talking to GRBL by its welcome banner.
