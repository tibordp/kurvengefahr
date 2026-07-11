// Typed HTTP client for the share API — the only module that talks to it. Response-status →
// error-kind mapping lives here and nowhere else; callers switch on `ShareApiError.kind`.
// The server contract (endpoints, codes, `/v1/info` shape) is share-api's; the PoW byte-level
// contract is pinned by share-api/testdata/pow_vectors.json.

import { POW_HEADER, SHARE_API_URL } from './config'

export interface PowParams {
  baseBits: number
  sizeStep: number
  maxBits: number
}

export interface ShareInfo {
  maxBytes: number
  pow: PowParams
  /** Days until the bucket's lifecycle rule expires a blob; null = kept indefinitely. */
  retentionDays: number | null
  version: string
}

export type ShareApiErrorKind = 'network' | 'not-found' | 'too-large' | 'bad-pow' | 'server'

export class ShareApiError extends Error {
  constructor(
    readonly kind: ShareApiErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'ShareApiError'
  }
}

function apiUrl(path: string): string {
  if (!SHARE_API_URL) throw new ShareApiError('server', 'Sharing is not configured in this build')
  return `${SHARE_API_URL}${path}`
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(apiUrl(path), init)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ShareApiError('network', 'Could not reach the share service')
  }
  if (res.ok) return res
  // The API's error bodies are `{code, message}` JSON; fall back to the status line.
  let message = `Share service error (${res.status})`
  try {
    const body = (await res.json()) as { message?: string }
    if (typeof body.message === 'string') message = body.message
  } catch {
    // non-JSON body (proxy error page, …) — keep the fallback
  }
  const kind: ShareApiErrorKind =
    res.status === 404
      ? 'not-found'
      : res.status === 413
        ? 'too-large'
        : res.status === 403
          ? 'bad-pow'
          : 'server'
  throw new ShareApiError(kind, message)
}

let infoPromise: Promise<ShareInfo> | null = null

/** `GET /v1/info`, memoized for the session; a failed fetch resets so the next call retries. */
export function fetchShareInfo(): Promise<ShareInfo> {
  infoPromise ??= (async () => {
    const res = await request('/v1/info')
    const raw = (await res.json()) as {
      max_blob_bytes: number
      pow: { base_bits: number; size_step: number; max_bits: number }
      retention_days: number | null
      version: string
    }
    return {
      maxBytes: raw.max_blob_bytes,
      pow: { baseBits: raw.pow.base_bits, sizeStep: raw.pow.size_step, maxBits: raw.pow.max_bits },
      retentionDays: raw.retention_days,
      version: raw.version,
    }
  })().catch((err: unknown) => {
    infoPromise = null
    throw err
  })
  return infoPromise
}

/** `HEAD /v1/blob/{hash}` — lets the client skip re-encrypt/PoW/upload for content already up. */
export async function blobExists(hash: string): Promise<boolean> {
  try {
    await request(`/v1/blob/${hash}`, { method: 'HEAD' })
    return true
  } catch (err) {
    if (err instanceof ShareApiError && err.kind === 'not-found') return false
    throw err
  }
}

/** `PUT /v1/blob/{hash}` with the solved proof-of-work nonce. */
export async function uploadBlob(hash: string, stored: Uint8Array, nonce: bigint): Promise<void> {
  await request(`/v1/blob/${hash}`, {
    method: 'PUT',
    headers: { [POW_HEADER]: nonce.toString(10), 'Content-Type': 'application/octet-stream' },
    body: stored as BodyInit,
  })
}

/** `GET /v1/blob/{hash}` — the encrypted stored blob. */
export async function fetchBlob(hash: string, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await request(`/v1/blob/${hash}`, { signal })
  return new Uint8Array(await res.arrayBuffer())
}

/** Test-only: forget the memoized `/v1/info`. */
export function resetShareInfoCache(): void {
  infoPromise = null
}
