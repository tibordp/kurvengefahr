// The single gate for the share feature. Sharing is compiled in only when the build sets
// VITE_SHARE_API_URL (self-hosters without a share service simply don't set it — no share UI
// exists at all); at runtime it additionally needs WebCrypto, which is absent on insecure
// (LAN-IP HTTP) origins — there the feature hides the same way.

/** Share API base URL (no trailing slash), or null when sharing is compiled out. */
export const SHARE_API_URL: string | null =
  (import.meta.env.VITE_SHARE_API_URL ?? '').replace(/\/+$/, '') || null

export function shareAvailable(): boolean {
  return !!SHARE_API_URL && typeof crypto !== 'undefined' && !!crypto.subtle
}

/** Upload proof-of-work header; the nonce travels as a decimal u64 string. */
export const POW_HEADER = 'X-KG-PoW'
