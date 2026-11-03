// Per-session FIFO task queue — when a run is already active, new submissions
// are enqueued and drained sequentially after the active run finishes.

interface QueueEntry {
  content: string
  attachments?: string[]
  createdAt: number
}

const taskQueues = new Map<string, QueueEntry[]>()

export function enqueueTask(sessionId: string, content: string, attachments?: string[]): void {
  let queue = taskQueues.get(sessionId)
  if (!queue) {
    queue = []
    taskQueues.set(sessionId, queue)
  }
  queue.push({ content, attachments, createdAt: Date.now() })
}

export function dequeueTask(sessionId: string): QueueEntry | null {
  const queue = taskQueues.get(sessionId)
  if (!queue || queue.length === 0) return null
  return queue.shift() ?? null
}

export function hasQueuedTasks(sessionId: string): boolean {
  const queue = taskQueues.get(sessionId)
  return !!queue && queue.length > 0
}

export function getQueueDepth(sessionId: string): number {
  return taskQueues.get(sessionId)?.length ?? 0
}

export function removeFromQueue(sessionId: string, content: string): boolean {
  const queue = taskQueues.get(sessionId)
  if (!queue) return false
  const idx = queue.findIndex((e) => e.content === content)
  if (idx === -1) return false
  queue.splice(idx, 1)
  return true
}

export function clearQueue(sessionId: string): void {
  taskQueues.delete(sessionId)
}
