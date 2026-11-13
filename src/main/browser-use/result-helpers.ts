// Browser command result helpers — ported from zcode browserCommandResult.ts.

import type { BrowserCommandResult } from '../../shared/browser-use'

export type BrowserCommandDone = (
  partial: Omit<BrowserCommandResult, 'elapsedMs'>
) => BrowserCommandResult

/** Construct ref_not_found structured error (hint: take a fresh snapshot first). */
export function refNotFound(ref: string): Omit<BrowserCommandResult, 'elapsedMs'> {
  return {
    ok: false,
    error: {
      code: 'ref_not_found',
      message: `ref ${ref} not found (take a fresh snapshot() first)`
    }
  }
}

/** Construct execution_error structured result. */
export function executionError(message: string): Omit<BrowserCommandResult, 'elapsedMs'> {
  return { ok: false, error: { code: 'execution_error', message } }
}
