// Upload proof-of-work: difficulty derivation (the one TS copy of the server's formula, pinned
// by the shared fixture) and the solver front-end. The scan itself is kg_core's `pow_scan`
// running in a dedicated one-shot worker — spawned per solve, terminated on completion or
// abort, so there's no job protocol to get wrong and cancel is instant.

import type { PowParams } from './service'

/** Required leading zero bits for a stored blob of `sizeBytes`. Mirrors share-api's
 *  `pow::difficulty` integer-exactly: n = max(1, ceil(size / step)); base + floor(log2(n)),
 *  clamped to maxBits. n < 2^32 always (the size cap is a few MB), so clz32 is exact. */
export function difficultyBits(sizeBytes: number, pow: PowParams): number {
  const n = Math.max(1, Math.ceil(Math.max(1, sizeBytes) / Math.max(1, pow.sizeStep)))
  return Math.min(pow.maxBits, pow.baseBits + (31 - Math.clz32(n)))
}

export interface PowProgress {
  attempts: number
  /** P(a valid nonce found by now) — PoW is memoryless, so this is the only honest "percent". */
  probability: number
}

type WorkerOut =
  | { type: 'progress'; attempts: number }
  | { type: 'found'; nonce: bigint }
  | { type: 'error'; message: string }

/** Solve for a nonce whose PoW digest has ≥ `bits` leading zeros. Rejects with an AbortError
 *  when `signal` fires (the worker is terminated mid-scan). */
export function solvePow(
  hashBytes: Uint8Array,
  bits: number,
  opts: { signal: AbortSignal; onProgress?: (p: PowProgress) => void },
): Promise<bigint> {
  return new Promise((resolve, reject) => {
    const abortError = () => new DOMException('proof-of-work aborted', 'AbortError')
    if (opts.signal.aborted) {
      reject(abortError())
      return
    }
    const worker = new Worker(new URL('./powWorker.ts', import.meta.url), { type: 'module' })
    const cleanup = () => {
      worker.terminate()
      opts.signal.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(abortError())
    }
    opts.signal.addEventListener('abort', onAbort)
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data
      if (msg.type === 'progress') {
        opts.onProgress?.({
          attempts: msg.attempts,
          probability: 1 - Math.exp(-msg.attempts / 2 ** bits),
        })
      } else if (msg.type === 'found') {
        cleanup()
        resolve(msg.nonce)
      } else {
        cleanup()
        reject(new Error(msg.message))
      }
    }
    // A hard crash (failed module/WASM fetch) never posts a structured error.
    worker.onerror = (e) => {
      cleanup()
      reject(new Error(e.message || 'proof-of-work worker crashed'))
    }
    worker.postMessage({ type: 'solve', hash: hashBytes, bits })
  })
}
