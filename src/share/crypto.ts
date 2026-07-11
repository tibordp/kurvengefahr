// Client-side encryption for shared documents: AES-128-GCM via WebCrypto, key generated fresh
// per share and carried only in the URL fragment. The server stores bytes it cannot read.
//
// Stored blob layout (pinned; version byte buys format agility):
//   0x01 || iv (12 bytes) || AES-GCM ciphertext+tag
// The blob's content address is the SHA-256 of that whole stored blob, so the server can verify
// what it stores and the viewer can verify what it fetched — before touching the key at all.

export const STORED_VERSION = 0x01
const IV_BYTES = 12
const KEY_BYTES = 16
const GCM_TAG_BYTES = 16

export function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  // Chunked so a multi-MB blob doesn't blow the argument limit of String.fromCharCode.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/** Encrypt a plaintext `.kgz`: fresh random key + IV, returns the stored blob, its content
 *  address, and the key — both already in link form (unpadded base64url). */
export async function encryptContainer(
  plain: Uint8Array,
): Promise<{ stored: Uint8Array; hash: string; key: string }> {
  const rawKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey as BufferSource, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, cryptoKey, plain as BufferSource),
  )
  const stored = new Uint8Array(1 + IV_BYTES + ct.length)
  stored[0] = STORED_VERSION
  stored.set(iv, 1)
  stored.set(ct, 1 + IV_BYTES)
  return { stored, hash: toBase64Url(await sha256(stored)), key: toBase64Url(rawKey) }
}

export type DecryptResult =
  | { status: 'ok'; plain: Uint8Array }
  /** GCM authentication failed — in practice a wrong/truncated key (the caller has already
   *  verified the stored blob's hash, so the bytes themselves are what was shared). */
  | { status: 'wrong-key' }
  /** Not a stored blob we could ever decrypt: bad version byte, truncated, undecodable key. */
  | { status: 'corrupt' }

/** Total — never throws. `key` is the link's unpadded-base64url key segment. */
export async function decryptContainer(stored: Uint8Array, key: string): Promise<DecryptResult> {
  if (stored.length < 1 + IV_BYTES + GCM_TAG_BYTES || stored[0] !== STORED_VERSION) {
    return { status: 'corrupt' }
  }
  const rawKey = fromBase64Url(key)
  if (!rawKey || rawKey.length !== KEY_BYTES) return { status: 'corrupt' }
  const iv = stored.subarray(1, 1 + IV_BYTES)
  const ct = stored.subarray(1 + IV_BYTES)
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', rawKey as BufferSource, 'AES-GCM', false, ['decrypt'])
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, cryptoKey, ct as BufferSource)
    return { status: 'ok', plain: new Uint8Array(plain) }
  } catch {
    return { status: 'wrong-key' }
  }
}
