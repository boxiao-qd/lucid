// Browser-use shared types — mirrors zcode's zod schemas as plain TypeScript.
// No zod dependency; validation is done at the tool execute() layer.

// --- Modifiers / buttons ---

export type BrowserKeyModifier = 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift'
export type BrowserMouseButton = 'left' | 'right' | 'middle'

// --- Page state ---

export interface BrowserPageState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  scrollX?: number
  scrollY?: number
  viewportWidth?: number
  viewportHeight?: number
}

// --- Snapshot ---

export interface BrowserElementRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserSnapshotElement {
  ref: string
  tag: string
  role?: string
  name?: string
  text?: string
  value?: string
  disabled?: boolean
  checked?: boolean
  selector: string
  xpath: string
  rect: BrowserElementRect
  inViewport: boolean
  parentRef?: string
  attributes?: Record<string, string>
}

export interface BrowserSnapshotDomNode {
  tag: string
  depth: number
  inViewport: boolean
  ref?: string
  role?: string
  name?: string
  text?: string
  attributes?: Record<string, string>
}

export interface BrowserSnapshot {
  url: string
  title: string
  dom?: BrowserSnapshotDomNode[]
  domTruncated?: boolean
  elements: BrowserSnapshotElement[]
  truncated: boolean
}

// --- Command (discriminated union — 17 core methods) ---

export type BrowserCommand =
  | { method: 'navigate'; url: string }
  | { method: 'back' }
  | { method: 'forward' }
  | { method: 'reload' }
  | {
      method: 'screenshot'
      fullPage?: boolean
      clip?: { x: number; y: number; width: number; height: number }
    }
  | { method: 'snapshot'; maxElements?: number; includeHidden?: boolean }
  | {
      method: 'click'
      ref?: string
      x?: number
      y?: number
      button?: BrowserMouseButton
      doubleClick?: boolean
      modifiers?: BrowserKeyModifier[]
    }
  | { method: 'type'; ref?: string; text: string }
  | { method: 'press'; key: string; ref?: string; modifiers?: BrowserKeyModifier[] }
  | { method: 'scroll'; ref?: string; x?: number; y?: number }
  | {
      method: 'hover'
      ref?: string
      x?: number
      y?: number
      modifiers?: BrowserKeyModifier[]
    }
  | { method: 'select'; ref: string; values: string[] }
  | { method: 'check'; ref: string; checked?: boolean }
  | { method: 'getState' }
  | { method: 'evaluate'; expression: string }
  | { method: 'elementInfo'; x: number; y: number }
  | { method: 'close' }

export const BROWSER_COMMAND_METHODS = [
  'navigate',
  'back',
  'forward',
  'reload',
  'screenshot',
  'snapshot',
  'click',
  'type',
  'press',
  'scroll',
  'hover',
  'select',
  'check',
  'getState',
  'evaluate',
  'elementInfo',
  'close'
] as const

// --- Result ---

export type BrowserErrorCode =
  | 'capability_unsupported'
  | 'ref_not_found'
  | 'navigation_blocked'
  | 'timeout'
  | 'renderer_unreachable'
  | 'cancelled'
  | 'execution_error'

export interface BrowserCommandResult {
  ok: boolean
  state?: BrowserPageState
  snapshot?: BrowserSnapshot
  image?: { base64: string; mimeType: 'image/png' }
  value?: unknown
  element?: BrowserSnapshotElement
  error?: { code: BrowserErrorCode; message: string; sideEffect?: 'none' | 'uncertain' }
  elapsedMs: number
}

// --- ControlledView (main-process abstraction over webview webContents + CDP) ---

export interface ControlledViewWebContents {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  executeJavaScript(script: string): Promise<unknown>
}

export interface ControlledViewCdp {
  send(method: string, params?: unknown): Promise<unknown>
}

export interface ControlledView {
  webContents: ControlledViewWebContents
  cdp: ControlledViewCdp
}

export interface BrowserPoint {
  cx: number
  cy: number
}
