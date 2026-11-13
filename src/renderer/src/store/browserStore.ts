// Browser panel state — tracks whether the browser panel is open, which
// session it belongs to, plus layout state (collapse / full-width expand /
// drag-resized width, persisted to localStorage like zcode's side pane).
//
// Width is stored as a FRACTION of the content area (not absolute px) so the
// split stays proportional when the window is resized or restored at a
// different size — a stored 720px would eat most of a non-maximized window.

import { create } from 'zustand'

const FRACTION_STORAGE_KEY = 'lucid:browser-panel-width-fraction'

/** Browser ≥ 25% of content; chat column ≥ 35% (mirrors zcode's panel
 *  minSize of 35% for the conversation column). */
const MIN_FRACTION = 0.25
const MAX_FRACTION = 0.65

function clampFraction(f: number): number {
  return Math.round(Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, f)) * 1000) / 1000
}

function loadStoredFraction(): number {
  try {
    const raw = window.localStorage.getItem(FRACTION_STORAGE_KEY)
    if (!raw) return 0
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? clampFraction(n) : 0
  } catch {
    return 0
  }
}

function persistFraction(f: number): void {
  try {
    window.localStorage.setItem(FRACTION_STORAGE_KEY, String(f))
  } catch {
    /* best-effort */
  }
}

interface BrowserState {
  isOpen: boolean
  sessionId: string | null
  /** Collapsed — panel shrinks to a slim strip, webview stays mounted. */
  collapsed: boolean
  /** Expanded — browser takes the full content width, chat is hidden. */
  expanded: boolean
  /** Panel width as a fraction of the content area (0.25–0.65). */
  fraction: number
  open: (sessionId: string) => void
  close: () => void
  toggleCollapse: () => void
  toggleExpanded: () => void
  /** @param persist false while drag-resizing (commit once on pointerup) */
  setFraction: (f: number, persist?: boolean) => void
}

export const useBrowserStore = create<BrowserState>((set) => ({
  isOpen: false,
  sessionId: null,
  collapsed: false,
  expanded: false,
  fraction: loadStoredFraction() || 0.5,
  open: (sessionId) =>
    set((s) => ({
      isOpen: true,
      // Switching sessions re-uses the panel; only reset layout when it
      // was closed (fresh open should show the panel fully).
      collapsed: s.isOpen ? s.collapsed : false,
      expanded: s.isOpen ? s.expanded : false,
      sessionId
    })),
  close: () => set({ isOpen: false, sessionId: null, collapsed: false, expanded: false }),
  // Collapsing clears full-width mode (and vice versa) so the two never
  // combine into "chat hidden + browser shrunk to a strip".
  toggleCollapse: () =>
    set((s) => (s.collapsed ? { collapsed: false } : { collapsed: true, expanded: false })),
  toggleExpanded: () => set((s) => ({ expanded: !s.expanded, collapsed: false })),
  setFraction: (f, persist = true) =>
    set(() => {
      const clamped = clampFraction(f)
      if (persist) persistFraction(clamped)
      return { fraction: clamped }
    })
}))
