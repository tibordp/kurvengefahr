// Share-link fragment codec. The whole share reference lives in the URL *fragment* —
// `#s=<hash>.<key>` — so neither the Pages host nor the share API ever sees the blob id or the
// decryption key in a request. `.` separates cleanly because it's not in the base64url alphabet.
// Format is pinned: 43-char unpadded base64url SHA-256 + '.' + 22-char unpadded base64url
// AES-128 key.

export interface ShareRef {
  /** Blob id: unpadded base64url SHA-256 of the stored (encrypted) blob. */
  hash: string
  /** Unpadded base64url raw AES-128-GCM key. Never sent anywhere. */
  key: string
}

const FRAGMENT_RE = /^#s=([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/

/**
 * Parse a location fragment. `null` = not a share fragment at all (boot the editor);
 * `'invalid'` = it *tried* to be one (`#s=` prefix) but is malformed — show the bad-link screen
 * rather than silently opening an empty editor.
 */
export function parseShareFragment(fragment: string): ShareRef | 'invalid' | null {
  if (!fragment.startsWith('#s=')) return null
  const m = FRAGMENT_RE.exec(fragment)
  return m ? { hash: m[1], key: m[2] } : 'invalid'
}

/** The full share URL for the current app origin (or an explicit base for tests). */
export function buildShareUrl(ref: ShareRef, base?: string): string {
  const b = base ?? `${location.origin}${location.pathname}`
  return `${b}#s=${ref.hash}.${ref.key}`
}
