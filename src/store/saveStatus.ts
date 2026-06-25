// A tiny status flag behind the toolbar's "unsaved changes" dot. True from the moment an edit makes
// the active document differ from what's in localStorage until the debounced autosave catches up (or
// while a continuous gesture keeps producing changes); false once they match again — and false for a
// blank scratch tab that isn't worth persisting yet. Driven entirely by documents.ts (the autosave
// owner); the UI only reads it. Kept separate from the documents store so toggling the dot doesn't
// re-render the document list / name.
import { create } from 'zustand'

interface SaveStatus {
  /** The active doc has changes not yet written to localStorage. */
  dirty: boolean
}

export const useSaveStatus = create<SaveStatus>(() => ({ dirty: false }))

export const setDirty = (dirty: boolean): void => {
  if (useSaveStatus.getState().dirty !== dirty) useSaveStatus.setState({ dirty })
}
