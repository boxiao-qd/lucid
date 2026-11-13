// Browser command state helpers — ported from zcode browserCommandState.ts.

import type { BrowserPageState, ControlledViewWebContents } from '../../shared/browser-use'

export const DEFAULT_NAVIGATE_SETTLE_MS = 10_000

export class BrowserNavigationTimeoutError extends Error {
  override name = 'BrowserNavigationTimeoutError'
}

/** Only http/https and about:blank are allowed. */
export function isAllowedBrowserUrl(rawUrl: string): boolean {
  if (rawUrl === 'about:blank') return true
  try {
    const u = new URL(rawUrl)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function now(): number {
  return Date.now()
}

export function readState(wc: ControlledViewWebContents): BrowserPageState {
  return {
    url: safe(() => wc.getURL(), ''),
    title: safe(() => wc.getTitle(), ''),
    canGoBack: safe(() => wc.canGoBack(), false),
    canGoForward: safe(() => wc.canGoForward(), false)
  }
}

/** loadURL races against timeout + abort. Only real completion counts. */
export async function settleNavigation(
  loadPromise: Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new BrowserNavigationTimeoutError(`Navigation timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
  })
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException('aborted', 'AbortError'))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([loadPromise, timeout, aborted])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}
