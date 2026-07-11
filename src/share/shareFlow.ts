// The share pipeline (no React): export the active document → encrypt → proof-of-work → upload,
// with two session caches that make retries and re-shares cheap:
//
//  - `shared` (fingerprint → ShareRef): a successful share of identical content re-issues the
//    same link (HEAD-confirmed, since the bucket's lifecycle rule may have expired it). Same
//    fingerprint = same link *within a session*; across sessions a fresh key is generated, so
//    re-sharing yields a different (equally valid) link.
//  - `pending`: the in-flight attempt's ciphertext, ref and solved nonce survive a failure, so
//    "Try again" after a network flake re-uses the paid-for proof-of-work instead of re-mining.
//
// Fingerprint mirrors documents.ts `contentKey()` minus selection — selection changes must not
// break link reuse.

import { exportActiveDocument } from '../output/documentContainer'
import { useDoc } from '../store/document'
import { useDocuments } from '../store/documents'
import { encryptContainer, fromBase64Url } from './crypto'
import { buildShareUrl, type ShareRef } from './link'
import { difficultyBits, solvePow, type PowProgress } from './pow'
import { blobExists, fetchShareInfo, uploadBlob } from './service'

export type SharePhase =
  | { step: 'exporting' }
  | { step: 'encrypting' }
  | { step: 'preflight' }
  | { step: 'pow'; attempts: number; probability: number }
  | { step: 'uploading' }

export interface ShareResult {
  url: string
  retentionDays: number | null
  /** The identical snapshot was already shared — same link, no upload happened. */
  reused: boolean
}

interface PendingShare {
  fingerprint: string
  stored: Uint8Array
  ref: ShareRef
  nonce?: bigint
}

const shared = new Map<string, ShareRef>()
let pending: PendingShare | null = null

function fingerprint(): string {
  const { activeName } = useDocuments.getState()
  const { elements, profile, fiducial } = useDoc.getState()
  return JSON.stringify({ activeName, elements, profile, fiducial })
}

/** Oversize is a user-facing condition (not a ShareApiError) — the dialog shows it verbatim. */
export class ShareTooLargeError extends Error {
  constructor(storedBytes: number, maxBytes: number) {
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')
    super(`This document is ${mb(storedBytes)} MB encrypted -- the share limit is ${mb(maxBytes)} MB`)
    this.name = 'ShareTooLargeError'
  }
}

export async function runShare(
  onPhase: (phase: SharePhase) => void,
  signal: AbortSignal,
): Promise<ShareResult> {
  const throwIfAborted = () => {
    if (signal.aborted) throw new DOMException('share aborted', 'AbortError')
  }
  const fp = fingerprint()
  const info = await fetchShareInfo()

  // Identical content already shared this session → same link, if the blob still exists.
  const prior = shared.get(fp)
  if (prior) {
    onPhase({ step: 'preflight' })
    if (await blobExists(prior.hash)) {
      return { url: buildShareUrl(prior), retentionDays: info.retentionDays, reused: true }
    }
    shared.delete(fp) // expired server-side — fall through to a fresh upload
  }

  // Resume a failed attempt for the same content (same ciphertext → same hash → the PoW and any
  // partially-successful upload still count); otherwise export + encrypt fresh.
  let attempt: PendingShare
  if (pending && pending.fingerprint === fp) {
    attempt = pending
  } else {
    onPhase({ step: 'exporting' })
    const container = await exportActiveDocument()
    const plain = new Uint8Array(await container.arrayBuffer())
    throwIfAborted()
    onPhase({ step: 'encrypting' })
    const { stored, hash, key } = await encryptContainer(plain)
    if (stored.length > info.maxBytes) throw new ShareTooLargeError(stored.length, info.maxBytes)
    attempt = { fingerprint: fp, stored, ref: { hash, key } }
    pending = attempt
  }
  throwIfAborted()

  onPhase({ step: 'preflight' })
  if (!(await blobExists(attempt.ref.hash))) {
    if (attempt.nonce === undefined) {
      const bits = difficultyBits(attempt.stored.length, info.pow)
      const hashBytes = fromBase64Url(attempt.ref.hash)!
      attempt.nonce = await solvePow(hashBytes, bits, {
        signal,
        onProgress: (p: PowProgress) => onPhase({ step: 'pow', ...p }),
      })
    }
    onPhase({ step: 'uploading' })
    await uploadBlob(attempt.ref.hash, attempt.stored, attempt.nonce)
  }

  shared.set(fp, attempt.ref)
  pending = null
  return { url: buildShareUrl(attempt.ref), retentionDays: info.retentionDays, reused: false }
}

/** Test-only: clear the session caches. */
export function resetShareCaches(): void {
  shared.clear()
  pending = null
}
