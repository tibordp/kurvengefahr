// The active drawing tool (a transient UI concern, like viewport). `select` is the default
// arrow/transform tool; the others put the canvas into a create-on-drag/click mode (see
// canvas/DrawingLayer.tsx). Tools auto-return to `select` after committing a shape (the pen
// continues until the path is finished).
import { create } from 'zustand'

export type Tool =
  | 'select'
  | 'handwriting'
  | 'text'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'pen'
  | 'freehand'
  | 'generative'
  | 'fiducial'

interface ToolsStore {
  tool: Tool
  setTool: (tool: Tool) => void
}

export const useTools = create<ToolsStore>((set) => ({
  tool: 'select',
  setTool: (tool) => set({ tool }),
}))
