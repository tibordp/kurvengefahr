// Pure line-assembly math for the handwriting typesetter (genWorker.ts), factored out so vitest
// can cover it without a worker harness. All values in mm.

export type HwAlign = 'left' | 'center' | 'right' | 'justify'

/** Horizontal shift for a whole line within the wrap box. Justify lines are assembled at x=0 and
 *  stretched per word instead (see {@link justifyOffsets}), so they shift like left. */
export function lineShift(align: HwAlign, maxWidth: number, lineWidth: number): number {
  switch (align) {
    case 'center':
      return (maxWidth - lineWidth) * 0.5
    case 'right':
      return maxWidth - lineWidth
    default:
      return 0
  }
}

/** Per-word extra shifts that stretch a line's inter-word gaps to fill `maxWidth`. Only soft
 *  (wrap-broken) lines justify; hard breaks (paragraph end) stay ragged. A line with fewer than
 *  two words has no gaps to stretch. Never shrinks a line that already overflows. */
export function justifyOffsets(wordCount: number, maxWidth: number, lineWidth: number, soft: boolean): number[] {
  const shifts = new Array<number>(wordCount).fill(0)
  if (!soft || wordCount < 2) return shifts
  const extra = (maxWidth - lineWidth) / (wordCount - 1)
  if (extra <= 0) return shifts
  for (let i = 1; i < wordCount; i++) shifts[i] = i * extra
  return shifts
}
