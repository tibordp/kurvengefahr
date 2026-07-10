# Contributing to Kurvengefahr

Thanks for your interest! A few house rules -- some of them a little unusual -- so expectations
are clear up front.

## Issues first

Issues, bug reports, and feature requests are the preferred form of contribution -- they are
valuable on their own and never go to waste. Code contributions are welcome too, but with a
caveat: there is no guarantee a pull request will be merged, and merged code may be substantially
rewritten to fit the architecture and style of the project. Contribution credit and attribution
will be preserved to the extent reasonable, even when the code itself changes shape.

If you are considering a larger change, opening an issue to discuss it first will save everyone
time.

## AI contributions

AI-assisted and AI-generated contributions are welcome and encouraged -- much of this codebase is
built that way. You are encouraged to share the prompts or the workflow you used alongside the
change or issue itself; it is often as interesting as the change, and it helps with review.

## Hardware integration changes

When changing the hardware integration (G-code emission, the AxiDraw/EBB planner and serial
protocol, GRBL support) or adding a new machine type, you are expected to have tested the change
on real hardware, and to say so in the pull request (which machine, what you plotted). Limited
exceptions apply for extremely obvious, low-risk fixes -- a typo in a comment does not need a pen
plot. When in doubt, it needs the plot: these code paths move physical machines, and a bug can
mean a gouged bed, a torn page, or a plotter walking off its rails.

## Practical notes

- `CLAUDE.md` and the module headers document the architecture and its invariants -- read the
  header of a subsystem before changing it (this applies to humans and AI agents alike).
- Build and test: `npm run dev`, `npm test`, and `cargo test` in `crate/`. See the
  [README](README.md) for prerequisites.
- License: [GPL-2.0-only](LICENSE). By contributing you agree to license your contribution under
  the same terms.
