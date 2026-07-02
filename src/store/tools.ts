// The active drawing tool (a transient UI concern, like viewport). `select` is the default
// arrow/transform tool; the others put the canvas into a create-on-drag/click mode (see
// canvas/DrawingLayer.tsx). Tools auto-return to `select` after committing a shape (the pen
// continues until the path is finished).
import { create } from 'zustand'
import { usePreview } from './preview'

export type Tool =
  | 'select'
  | 'handwriting'
  | 'text'
  | 'rect'
  | 'ellipse'
  | 'polygon'
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
  // Tools and the toolpath preview are mutually exclusive modes: arming any tool (by button or
  // shortcut) drops out of the read-only preview back into editing, so a tool is never a dead,
  // unusable button while previewing. Entering preview resets the tool to `select` (see Toolbar).
  setTool: (tool) => {
    if (usePreview.getState().active) usePreview.getState().exit()
    set({ tool })
  },
}))
