// One-shot proof-of-work worker: owns its own WASM instance (like the generator workers) and
// scans in chunks so progress flows and `terminate()` (the cancel mechanism — no message
// protocol) never loses more than one chunk of work. Chunk size targets ~50–150 ms per call.
import init, { pow_scan } from '@wasm/kg_core.js'
import wasmUrl from '@wasm/kg_core_bg.wasm?url'

const post = (msg: unknown) =>
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg)

const CHUNK = 262_144

const ready = init({ module_or_path: wasmUrl })

self.onmessage = async (e: MessageEvent<{ type: 'solve'; hash: Uint8Array; bits: number }>) => {
  const { hash, bits } = e.data
  try {
    await ready
    // Random 64-bit start: two people sharing identical bytes shouldn't race down the same
    // nonce range. (PoW is outside the deterministic-generation contract — nothing memoizes it.)
    const seed = crypto.getRandomValues(new Uint8Array(8))
    let nonce = new DataView(seed.buffer).getBigUint64(0)
    let attempts = 0
    for (;;) {
      const found = pow_scan(hash, nonce, CHUNK, bits)
      if (found !== undefined) {
        post({ type: 'found', nonce: found })
        return
      }
      nonce = BigInt.asUintN(64, nonce + BigInt(CHUNK))
      attempts += CHUNK
      post({ type: 'progress', attempts })
    }
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) })
  }
}
