// Browser command handlers — combined port of zcode's interaction + page handlers.
// Each handler takes (view, command, done) and returns BrowserCommandResult.

import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserPoint,
  BrowserSnapshotDomNode,
  BrowserSnapshotElement
} from '../../shared/browser-use'
import {
  CHECK_SCRIPT,
  ELEMENT_AT_POINT_SCRIPT,
  EVALUATE_SCRIPT,
  SELECT_SCRIPT,
  SNAPSHOT_SCRIPT,
  VIEWPORT_SCRIPT
} from './command-scripts'
import {
  DEFAULT_NAVIGATE_SETTLE_MS,
  BrowserNavigationTimeoutError,
  isAllowedBrowserUrl,
  readState,
  settleNavigation
} from './command-state'
import { dispatchClickAt, dispatchKey, modifiersBitmask, resolveRefCenter } from './command-input'
import type { ControlledView } from '../../shared/browser-use'
import type { BrowserCommandDone } from './result-helpers'
import { executionError, refNotFound } from './result-helpers'

// --- Page handlers ---

export async function handleNavigate(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: 'navigate' }>,
  done: BrowserCommandDone,
  opts?: { navigateSettleMs?: number; signal?: AbortSignal }
): Promise<BrowserCommandResult> {
  if (!isAllowedBrowserUrl(command.url)) {
    return done({
      ok: false,
      error: { code: 'navigation_blocked', message: `Blocked URL: ${command.url}` }
    })
  }
  try {
    await settleNavigation(
      view.webContents.loadURL(command.url),
      opts?.navigateSettleMs ?? DEFAULT_NAVIGATE_SETTLE_MS,
      opts?.signal
    )
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    // ERR_ABORTED can happen on SPA redirects — check if URL actually changed.
    if (isElectronNavigationAborted(error) && (await confirmAbortedNavigation(view))) {
      return done({ ok: true, state: readState(view.webContents) })
    }
    return done({
      ok: false,
      error: {
        code: error instanceof BrowserNavigationTimeoutError ? 'timeout' : 'execution_error',
        message: error instanceof Error ? error.message : String(error),
        sideEffect: 'uncertain'
      }
    })
  }
  return done({ ok: true, state: readState(view.webContents) })
}

export async function handleGetState(
  view: ControlledView,
  done: BrowserCommandDone
): Promise<BrowserCommandResult> {
  const state = readState(view.webContents)
  try {
    const raw = (await view.webContents.executeJavaScript(VIEWPORT_SCRIPT)) as {
      scrollX?: unknown
      scrollY?: unknown
      innerWidth?: unknown
      innerHeight?: unknown
    } | null
    if (raw && typeof raw === 'object') {
      if (typeof raw.scrollX === 'number') state.scrollX = raw.scrollX
      if (typeof raw.scrollY === 'number') state.scrollY = raw.scrollY
      if (typeof raw.innerWidth === 'number') state.viewportWidth = raw.innerWidth
      if (typeof raw.innerHeight === 'number') state.viewportHeight = raw.innerHeight
    }
  } catch {
    /* keep base state */
  }
  return done({ ok: true, state })
}

export async function handleScreenshot(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: 'screenshot' }>,
  done: BrowserCommandDone
): Promise<BrowserCommandResult> {
  const params: Record<string, unknown> = {
    format: 'png',
    captureBeyondViewport: command.clip !== undefined || command.fullPage === true
  }

  if (command.clip) {
    params.clip = {
      x: command.clip.x,
      y: command.clip.y,
      width: command.clip.width,
      height: command.clip.height,
      scale: 1
    }
  } else if (command.fullPage === true) {
    // Read content size for full-page capture
    const metrics = (await view.cdp.send('Page.getLayoutMetrics')) as {
      cssContentSize?: { x?: number; y?: number; width?: number; height?: number }
      contentSize?: { x?: number; y?: number; width?: number; height?: number }
    }
    const cs = metrics.cssContentSize ?? metrics.contentSize
    if (cs && typeof cs.width === 'number' && typeof cs.height === 'number') {
      params.clip = {
        x: typeof cs.x === 'number' ? cs.x : 0,
        y: typeof cs.y === 'number' ? cs.y : 0,
        width: cs.width,
        height: cs.height,
        scale: 1
      }
    }
  }

  const res = (await view.cdp.send('Page.captureScreenshot', params)) as { data?: string }
  if (!res?.data) {
    return done({
      ok: false,
      error: { code: 'execution_error', message: 'screenshot returned empty data' }
    })
  }
  return done({
    ok: true,
    image: { base64: res.data, mimeType: 'image/png' },
    state: readState(view.webContents)
  })
}

export async function handleSnapshot(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: 'snapshot' }>,
  done: BrowserCommandDone
): Promise<BrowserCommandResult> {
  const raw = await view.webContents.executeJavaScript(
    SNAPSHOT_SCRIPT(command.maxElements, command.includeHidden)
  )
  if (!raw || typeof raw !== 'object') {
    return done(executionError('invalid snapshot result shape'))
  }
  const snap = raw as {
    url: string
    title: string
    elements: BrowserSnapshotElement[]
    truncated: boolean
    dom?: BrowserSnapshotDomNode[]
    domTruncated?: boolean
  }
  return done({ ok: true, snapshot: snap })
}

export async function handleEvaluate(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: 'evaluate' }>,
  done: BrowserCommandDone
): Promise<BrowserCommandResult> {
  const raw = (await view.webContents.executeJavaScript(EVALUATE_SCRIPT(command.expression))) as {
    ok?: boolean
    kind?: string
    data?: string
    message?: string
  } | null
  if (!raw || typeof raw !== 'object')
    return done(executionError('evaluate returned invalid result'))
  if (raw.ok === false) return done(executionError(raw.message ?? 'evaluate error'))

  let value: unknown
  if (raw.kind === 'json' && typeof raw.data === 'string') {
    try {
      value = JSON.parse(raw.data)
    } catch {
      value = raw.data
    }
  } else {
    value = raw.data
  }
  return done({ ok: true, value })
}

// --- Interaction handlers ---

export async function handleClick(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: 'click' }>,
  done: BrowserCommandDone
): Promise<BrowserCommandResult> {
  const center = await resolveCommandPoint(view, command, 'click')
  if (center.kind === 'error') return done(center.error)
  await dispatchClickAt(
    view,
    center.point,
    command.button ?? 'left',
    command.doubleClick === true,
    modifiersBitmask(command.modifiers)
  )
  return done({ ok: true, state: readState(view.webContents) })
}

export async function handleType(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: 'type' }>,
  done: BrowserCommandDone
): Promise<BrowserCommandResult> {
  // Focus element via ref if provided
  if (command.ref) {
    const center = await resolveRefCenter(view, command.ref)
    if (!center) return done(refNotFound(command.ref))
    await dispatchClickAt(view, center, 'left', false)
  }
  // Use CDP Input.insertText for bulk text input (simpler than virtual clipboard)
  await view.cdp.send('Input.insertText', { text: command.text })
  return done({ ok: true, state: readState(view.webContents) })
}

export async function handlePress(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: 'press' }>,
  done: BrowserCommandDone
): Promise<BrowserCommandResult> {
  if (command.ref) {
    const center = await resolveRefCenter(view, command.ref)
    if (!center) return done(refNotFound(command.ref))
    await dispatchClickAt(view, center, 'left', false)
  }
  await dispatchKey(view, command.key, modifiersBitmask(command.modifiers))
  return done({ ok: true, state: readState(view.webContents) })
}

export async function handleScroll(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: 'scroll' }>,
  done: BrowserCommandDone
): Promise<BrowserCommandResult> {
  if (command.ref) {
    const center = await resolveRefCenter(view, command.ref)
    if (!center) return done(refNotFound(command.ref))
    return done({ ok: true, state: readState(view.webContents) })
  }
  await view.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 0,
    y: 0,
    deltaX: command.x ?? 0,
    deltaY: command.y ?? 0
  })
  return done({ ok: true, state: readState(view.webContents) })
}

export async function handleHover(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: 'hover' }>,
  done: BrowserCommandDone
): Promise<BrowserCommandResult> {
  const center = await resolveCommandPoint(view, command, 'hover')
  if (center.kind === 'error') return done(center.error)
  const mod = modifiersBitmask(command.modifiers)
  await view.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: center.point.cx,
    y: center.point.cy,
    ...(mod > 0 ? { modifiers: mod } : {})
  })
  return done({ ok: true, state: readState(view.webContents) })
}

export async function handleSelect(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: 'select' }>,
  done: BrowserCommandDone
): Promise<BrowserCommandResult> {
  const raw = (await view.webContents.executeJavaScript(
    SELECT_SCRIPT(command.ref, command.values)
  )) as { ok?: boolean; error?: string } | null
  if (!raw || typeof raw !== 'object') return done(executionError('select returned invalid result'))
  if (raw.error === 'ref_not_found') return done(refNotFound(command.ref))
  if (raw.error === 'not_select')
    return done(executionError(`element ${command.ref} is not a <select>`))
  if (raw.error === 'no_match')
    return done(executionError(`no <option> matched values ${JSON.stringify(command.values)}`))
  if (raw.error) return done(executionError(`select failed: ${raw.error}`))
  return done({ ok: true, state: readState(view.webContents) })
}

export async function handleCheck(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: 'check' }>,
  done: BrowserCommandDone
): Promise<BrowserCommandResult> {
  const raw = (await view.webContents.executeJavaScript(
    CHECK_SCRIPT(command.ref, command.checked ?? true)
  )) as { ok?: boolean; error?: string } | null
  if (!raw || typeof raw !== 'object') return done(executionError('check returned invalid result'))
  if (raw.error === 'ref_not_found') return done(refNotFound(command.ref))
  if (raw.error === 'not_checkable')
    return done(executionError(`element ${command.ref} is not a checkbox/radio`))
  if (raw.error) return done(executionError(`check failed: ${raw.error}`))
  return done({ ok: true, state: readState(view.webContents) })
}

export async function handleElementInfo(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: 'elementInfo' }>,
  done: BrowserCommandDone
): Promise<BrowserCommandResult> {
  const raw = await view.webContents.executeJavaScript(
    ELEMENT_AT_POINT_SCRIPT(command.x, command.y)
  )
  if (raw == null) {
    return done({ ok: true })
  }
  const element = raw as BrowserSnapshotElement
  if (typeof element.ref !== 'string' || typeof element.tag !== 'string') {
    return done(executionError('invalid element result shape'))
  }
  return done({ ok: true, element })
}

// --- Helpers ---

async function resolveCommandPoint(
  view: ControlledView,
  command: { ref?: string; x?: number; y?: number },
  label: 'click' | 'hover'
): Promise<
  | { kind: 'ok'; point: BrowserPoint }
  | { kind: 'error'; error: Omit<BrowserCommandResult, 'elapsedMs'> }
> {
  if (command.ref) {
    const point = await resolveRefCenter(view, command.ref)
    if (!point) return { kind: 'error', error: refNotFound(command.ref) }
    return { kind: 'ok', point }
  }
  if (typeof command.x === 'number' && typeof command.y === 'number') {
    return { kind: 'ok', point: { cx: command.x, cy: command.y } }
  }
  return { kind: 'error', error: executionError(`${label} requires ref or (x,y)`) }
}

function isElectronNavigationAborted(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown }
  return (
    candidate.code === 'ERR_ABORTED' ||
    candidate.errno === -3 ||
    (typeof candidate.message === 'string' && /\bERR_ABORTED\b|\(-3\)/u.test(candidate.message))
  )
}

/** Simplified ERR_ABORTED confirmation: check if URL changed and document is ready. */
async function confirmAbortedNavigation(view: ControlledView): Promise<boolean> {
  try {
    const docState = (await view.webContents.executeJavaScript(
      '(() => ({ href: globalThis.location?.href ?? "", readyState: document.readyState }))()'
    )) as { href?: string; readyState?: string } | null
    const currentUrl = view.webContents.getURL()
    if (
      currentUrl !== '' &&
      docState?.href === currentUrl &&
      (docState.readyState === 'interactive' || docState.readyState === 'complete')
    ) {
      // URL changed from the abort — navigation likely succeeded
      return true
    }
  } catch {
    // guest switching document — treat as not confirmed
  }
  return false
}
