// Tiny promise wrapper around IndexedDB — just enough for the single `images` blob store. A leaf
// module with no other imports (so it's usable from the main thread AND a Web Worker, neither of
// which it assumes a DOM for). All callers tolerate rejection: IndexedDB can be unavailable
// (private mode, disabled storage), in which case image features degrade rather than crash.

const DB_NAME = 'kurvengefahr'
const DB_VERSION = 1
export const IMAGES_STORE = 'images'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(IMAGES_STORE)) {
        db.createObjectStore(IMAGES_STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }).catch((e) => {
    dbPromise = null // allow a later retry
    throw e
  })
  return dbPromise
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = run(t.objectStore(store))
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => reject(req.error)
      }),
  )
}

export function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  return tx<T | undefined>(store, 'readonly', (s) => s.get(key))
}

export function idbPut(store: string, value: unknown): Promise<void> {
  return tx<IDBValidKey>(store, 'readwrite', (s) => s.put(value)).then(() => undefined)
}

export function idbDelete(store: string, key: string): Promise<void> {
  return tx<undefined>(store, 'readwrite', (s) => s.delete(key)).then(() => undefined)
}

export function idbGetAllKeys(store: string): Promise<string[]> {
  return tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()).then((keys) =>
    keys.map((k) => String(k)),
  )
}
