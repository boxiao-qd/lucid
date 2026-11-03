// Active run management — one handle per session.
// Replaces the bare Map<string, AbortController> in index.ts.
// Adds a steerQueue: string[] that the agent loop polls during streaming
// to receive user-supplemented information mid-run.

interface ActiveRunHandle {
  abortController: AbortController
  steerQueue: string[]
}

const activeRuns = new Map<string, ActiveRunHandle>()

export function startRun(sessionId: string): ActiveRunHandle {
  const handle: ActiveRunHandle = {
    abortController: new AbortController(),
    steerQueue: []
  }
  activeRuns.set(sessionId, handle)
  return handle
}

export function endRun(sessionId: string): void {
  activeRuns.delete(sessionId)
}

export function cancelRun(sessionId: string): boolean {
  const handle = activeRuns.get(sessionId)
  if (!handle) return false
  handle.abortController.abort()
  return true
}

export function trySteer(sessionId: string, content: string): boolean {
  const handle = activeRuns.get(sessionId)
  if (!handle) return false
  handle.steerQueue.push(content)
  return true
}

export function isActive(sessionId: string): boolean {
  return activeRuns.has(sessionId)
}

export function getSteerQueue(sessionId: string): string[] | null {
  return activeRuns.get(sessionId)?.steerQueue ?? null
}
