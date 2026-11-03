import { create } from 'zustand'

type View = 'chat' | 'files' | 'skills' | 'extensions' | 'scheduled-tasks' | 'trace' | 'execution'

interface UIState {
  view: View
  setView: (v: View) => void
  fileHighlightPath: string | null
  setFileHighlight: (path: string | null) => void
  executionRunId: string | null
  openExecution: (runId: string) => void
  closeExecution: () => void
}

export const useUIStore = create<UIState>((set) => ({
  view: 'chat',
  setView: (view) => set({ view }),
  fileHighlightPath: null,
  setFileHighlight: (fileHighlightPath) => set({ fileHighlightPath }),
  executionRunId: null,
  openExecution: (runId) => set({ view: 'execution', executionRunId: runId }),
  closeExecution: () => set({ view: 'chat', executionRunId: null })
}))
