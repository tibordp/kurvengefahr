// `crypto.randomUUID` is exposed only in *secure* contexts (HTTPS or localhost). When the dev
// server is reached over a plain-HTTP LAN origin — e.g. http://192.168.x.x:5173 to test on a phone
// — it's absent, and the app (which mints UUIDs for documents, elements, images, profiles) throws
// on boot. `crypto.getRandomValues`, by contrast, IS available on insecure origins, so we shim a
// spec-compliant RFC 4122 v4 UUID from it. Production is served over HTTPS, so the native
// implementation is present and this is a no-op there.
//
// Side-effect module: import it FIRST in main.tsx so the shim is installed before any store (which
// may call crypto.randomUUID) is evaluated.
type UUID = `${string}-${string}-${string}-${string}-${string}`

if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function' && crypto.getRandomValues) {
  crypto.randomUUID = function randomUUID(): UUID {
    const b = crypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40 // version 4
    b[8] = (b[8] & 0x3f) | 0x80 // variant 1 (10xx)
    const h: string[] = []
    for (const x of b) h.push(x.toString(16).padStart(2, '0'))
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}` as UUID
  }
}
