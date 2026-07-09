// The machine-neutral face of a streaming plot session — what the plot-session store sees. Both
// streaming drivers (ebb/session.ts, grbl/session.ts) report through these hooks; everything
// else about them (flow control, drain, cancel recovery) is protocol-specific by design.
export type PromptKind = 'fiducial' | 'penSwap'

export interface SessionHooks {
  /** Segment `i` was acknowledged by the board. */
  onProgress(i: number): void
  /** A requested pause has actually landed (machine drained, pen up). */
  onPaused(): void
  onResumed(): void
  /** Operator stop (fiducial align / pen swap). Resolve true to continue, false to stop the plot.
   *  The machine is drained and the pen is up while this is pending. */
  prompt(kind: PromptKind, pen: number): Promise<boolean>
}

/** The driver contract the plot-session store runs: pause/resume/cancel requests plus the tape
 *  execution itself. */
export interface PlotDriver {
  requestPause(): void
  requestResume(): void
  requestCancel(): void
  run(): Promise<'done' | 'cancelled'>
}
