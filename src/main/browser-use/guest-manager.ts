// Browser guest manager — manages webview guests, CDP debugger attach/detach,
// and command routing. Adapted from zcode BrowserGuestManager (simplified:
// single-tab, single-session, no scope/residency/tab-recovery).

import { webContents } from 'electron'
import type { BrowserCommand, BrowserCommandResult, ControlledView } from '../../shared/browser-use'
import type { Emit } from '../agent/event-bus'
import { executeBrowserCommandOnView } from './command-executor'

const ENSURE_GUEST_TIMEOUT_MS = 30_000

interface GuestEntry {
  view: ControlledView
  emit: Emit
}

class BrowserGuestManager {
  private guests = new Map<string, GuestEntry>()
  private pendingAttach = new Map<
    string,
    {
      resolve: (view: ControlledView) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  /**
   * Called by IPC when renderer mounts <webview> and reports its webContentsId.
   * Attaches CDP debugger, enables Page + Runtime domains, stores the guest.
   */
  attachGuest(sessionId: string, webContentsId: number, emit: Emit): void {
    console.log(`[BrowserUse] attachGuest called: sessionId=${sessionId} wcId=${webContentsId}`)
    const wc = webContents.fromId(webContentsId)
    if (!wc || wc.isDestroyed()) {
      console.error(`[BrowserUse] attachGuest: webContents ${webContentsId} not found or destroyed`)
      this.rejectPending(sessionId, new Error('webContents not found or destroyed'))
      emit('browser_closed', { sessionId })
      return
    }

    // Attach CDP debugger if not already attached.
    // Note: attach() takes an optional protocolVersion (e.g. "1.3"), NOT a
    // session title. Omit it to use the latest CDP protocol version supported
    // by Electron's Chromium — passing a custom string like "lucid-browser-use"
    // is rejected as an invalid protocol version.
    const attachCdp = async (): Promise<void> => {
      console.log(`[BrowserUse] attaching CDP debugger to wcId=${webContentsId}...`)
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach()
      }
      await wc.debugger.sendCommand('Page.enable')
      await wc.debugger.sendCommand('Runtime.enable')
      console.log(`[BrowserUse] CDP debugger attached + Page/Runtime enabled`)
    }

    const view: ControlledView = {
      webContents: wc as unknown as ControlledView['webContents'],
      cdp: {
        send: (method: string, params?: unknown): Promise<unknown> =>
          wc.debugger.sendCommand(method, params as Record<string, unknown> | undefined)
      }
    }

    attachCdp()
      .then(() => {
        console.log(`[BrowserUse] guest stored, resolving pending for sessionId=${sessionId}`)
        this.guests.set(sessionId, { view, emit })
        this.resolvePending(sessionId, view)
      })
      .catch((err) => {
        // Serialize the error properly — Error objects JSON.stringify to {}
        // because their properties are non-enumerable.
        const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        console.error(`[BrowserUse] CDP attach failed: ${errMsg}`)
        this.rejectPending(
          sessionId,
          new Error(`CDP attach failed: ${errMsg}`)
        )
        // Tell the renderer to close the panel. Without this, the panel stays
        // open with no guest attached — every subsequent browser_open is a
        // no-op (store already {isOpen:true}) and ensureGuest times out.
        emit('browser_closed', { sessionId })
      })
  }

  /** Called by IPC when webview is unmounted or browser is closed. */
  detachGuest(sessionId: string): void {
    const entry = this.guests.get(sessionId)
    if (!entry) return
    try {
      const wc = entry.view.webContents
      // wc is the real Electron WebContents — detach debugger
      const realWc = webContents.fromId((wc as unknown as { id: number }).id)
      if (realWc && !realWc.isDestroyed() && realWc.debugger.isAttached()) {
        realWc.debugger.detach()
      }
    } catch {
      // best-effort — webContents may already be destroyed
    }
    this.guests.delete(sessionId)
    entry.emit('browser_closed', { sessionId })
  }

  /**
   * Called by the browser_use tool. Ensures a guest is attached for the session.
   * If no guest exists, emits browser_open so the renderer mounts the BrowserPanel,
   * then waits for attachGuest() to resolve the pending promise.
   */
  async ensureGuest(sessionId: string, emit: Emit): Promise<ControlledView> {
    const existing = this.guests.get(sessionId)
    if (existing) {
      console.log(`[BrowserUse] ensureGuest: guest already attached for sessionId=${sessionId}`)
      return existing.view
    }

    console.log(
      `[BrowserUse] ensureGuest: no guest, emitting browser_open for sessionId=${sessionId}`
    )
    // Create pending attach promise
    const promise = new Promise<ControlledView>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAttach.delete(sessionId)
        console.error(
          `[BrowserUse] ensureGuest: TIMEOUT after ${ENSURE_GUEST_TIMEOUT_MS / 1000}s — renderer did not attach guest`
        )
        // Close the panel if it's stuck open so a retry can re-mount it.
        emit('browser_closed', { sessionId })
        reject(
          new Error(
            `Browser panel did not open within ${ENSURE_GUEST_TIMEOUT_MS / 1000}s — renderer may be unresponsive`
          )
        )
      }, ENSURE_GUEST_TIMEOUT_MS)

      this.pendingAttach.set(sessionId, { resolve, reject, timer })
    })

    // Tell renderer to open the browser panel
    emit('browser_open', { sessionId })
    console.log(`[BrowserUse] browser_open emitted, waiting for renderer to attach guest...`)

    return promise
  }

  /** Execute a browser command on the session's guest. */
  async execute(
    sessionId: string,
    command: BrowserCommand,
    signal: AbortSignal,
    emit: Emit
  ): Promise<BrowserCommandResult> {
    console.log(`[BrowserUse] execute: method=${command.method} sessionId=${sessionId}`)
    if (command.method === 'close') {
      this.detachGuest(sessionId)
      return { ok: true, elapsedMs: 0 }
    }

    const view = await this.ensureGuest(sessionId, emit)
    console.log(`[BrowserUse] execute: guest ready, dispatching command ${command.method}`)
    return executeBrowserCommandOnView(view, command, { signal })
  }

  /** Check if a guest is attached for the session. */
  hasGuest(sessionId: string): boolean {
    return this.guests.has(sessionId)
  }

  private resolvePending(sessionId: string, view: ControlledView): void {
    const pending = this.pendingAttach.get(sessionId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingAttach.delete(sessionId)
      pending.resolve(view)
    }
  }

  private rejectPending(sessionId: string, error: Error): void {
    const pending = this.pendingAttach.get(sessionId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingAttach.delete(sessionId)
      pending.reject(error)
    }
  }
}

export const browserGuestManager = new BrowserGuestManager()
