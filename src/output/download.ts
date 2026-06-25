// Small client-side file helpers for import/export (documents + profiles). Mirrors the anchor-click
// download used by `sink.ts`, plus a hidden-input file picker that returns parsed JSON.

/** Download `obj` as a pretty-printed JSON file. */
export function downloadJson(filename: string, obj: unknown): void {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.json') ? filename : `${filename}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Prompt for a `.json` file and resolve its parsed contents. Resolves `null` if the user cancels;
 *  rejects only on read/parse failure (callers route that through the tolerant schema loaders). */
export function pickJsonFile(): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.style.display = 'none'
    // `cancel` fires on modern browsers when the dialog is dismissed; fall back to resolving null.
    input.addEventListener('cancel', () => resolve(null))
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      input.remove()
      if (!file) return resolve(null)
      try {
        resolve(JSON.parse(await file.text()))
      } catch (e) {
        reject(e)
      }
    })
    document.body.appendChild(input)
    input.click()
  })
}

/** Download an already-built Blob under `filename` (e.g. a `.kgz` container). */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Prompt for a file matching `accept` and resolve the raw `File` (so the caller can sniff bytes —
 *  e.g. a zip container). Resolves `null` if the user cancels. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    input.addEventListener('cancel', () => resolve(null))
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null
      input.remove()
      resolve(file)
    })
    document.body.appendChild(input)
    input.click()
  })
}

/** Prompt for an image file. */
export function pickImageFile(): Promise<File | null> {
  return pickFile('image/*')
}

/** Turn an arbitrary document name into a safe-ish filename stem. */
export function safeFilename(name: string, fallback = 'untitled'): string {
  const stem = name.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
  return stem || fallback
}
