// Agent trace types — per-turn structured event timeline for behavior analysis.
// Transported via IPC (trace:get channel), not the agent:event stream — this is
// a dev/analysis channel, separate from the UI-facing emit flow.

export interface TraceEvent {
  type: string
  timestamp: number
  data?: Record<string, unknown>
}

export interface TurnTrace {
  turnId: string
  sessionId: string
  userMessage: string
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  stopReason: string | null
  events: TraceEvent[]
}
