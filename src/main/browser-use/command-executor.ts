// Browser command executor — routes command.method to handler.
// Ported from zcode browserCommandExecutor.ts.

import type { BrowserCommand, BrowserCommandResult, ControlledView } from '../../shared/browser-use'
import { now, readState } from './command-state'
import {
  handleClick,
  handleCheck,
  handleElementInfo,
  handleEvaluate,
  handleGetState,
  handleHover,
  handleNavigate,
  handlePress,
  handleScreenshot,
  handleScroll,
  handleSelect,
  handleSnapshot,
  handleType
} from './command-handlers'

/**
 * Execute a BrowserCommand on a ControlledView. Never throws — errors
 * are structured into the result so the tool layer always gets a result.
 */
export async function executeBrowserCommandOnView(
  view: ControlledView,
  command: BrowserCommand,
  opts?: { navigateSettleMs?: number; signal?: AbortSignal }
): Promise<BrowserCommandResult> {
  const startedAt = now()
  const done = (partial: Omit<BrowserCommandResult, 'elapsedMs'>): BrowserCommandResult => ({
    ...partial,
    elapsedMs: now() - startedAt
  })

  try {
    switch (command.method) {
      case 'navigate':
        return await handleNavigate(view, command, done, opts)
      case 'getState':
        return await handleGetState(view, done)
      case 'back':
        view.webContents.goBack()
        return done({ ok: true, state: readState(view.webContents) })
      case 'forward':
        view.webContents.goForward()
        return done({ ok: true, state: readState(view.webContents) })
      case 'reload':
        view.webContents.reload()
        return done({ ok: true, state: readState(view.webContents) })
      case 'screenshot':
        return await handleScreenshot(view, command, done)
      case 'snapshot':
        return await handleSnapshot(view, command, done)
      case 'click':
        return await handleClick(view, command, done)
      case 'type':
        return await handleType(view, command, done)
      case 'press':
        return await handlePress(view, command, done)
      case 'scroll':
        return await handleScroll(view, command, done)
      case 'hover':
        return await handleHover(view, command, done)
      case 'select':
        return await handleSelect(view, command, done)
      case 'check':
        return await handleCheck(view, command, done)
      case 'elementInfo':
        return await handleElementInfo(view, command, done)
      case 'evaluate':
        return await handleEvaluate(view, command, done)
      default:
        return done({
          ok: false,
          error: {
            code: 'capability_unsupported',
            message: `command ${command.method} is not supported`
          }
        })
    }
  } catch (error) {
    const cancelled =
      opts?.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
    const timedOut =
      !cancelled &&
      error instanceof Error &&
      (error.name === 'TimeoutError' || /\b(?:timed out|timeout exceeded)\b/iu.test(error.message))
    return done({
      ok: false,
      error: {
        code: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'execution_error',
        message: cancelled
          ? 'Browser command cancelled'
          : error instanceof Error
            ? error.message
            : String(error)
      }
    })
  }
}
