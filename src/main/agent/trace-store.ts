// File-based trace store — one JSONL file per session.
// Path: ~/.lucid/behavior/{sessionId}.jsonl
// Each line is a complete TurnTrace (events + metadata), appended on endTurn.
// In-progress turns are kept in memory; getTraces merges them with disk data
// so frontend polling still sees live progress.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { appendFileSync, readFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import type { TurnTrace, TraceEvent } from '../../shared/trace'

const BEHAVIOR_DIR = join(homedir(), '.lucid', 'behavior')

// In-memory index: turnId → TurnTrace (for fast addEvent during the run)
const activeTurns = new Map<string, TurnTrace>()

// Generate a short unique id for each turn.
function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// Get the JSONL file path for a session.
function sessionFile(sessionId: string): string {
  return join(BEHAVIOR_DIR, `${sessionId}.jsonl`)
}

// Start a new turn for a session. Returns the turnId.
export function startTurn(sessionId: string, userMessage: string): string {
  const turnId = genId()
  const turn: TurnTrace = {
    turnId,
    sessionId,
    userMessage,
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    stopReason: null,
    events: []
  }

  activeTurns.set(turnId, turn)
  return turnId
}

// Append an event to a turn. Silently drops if turnId not found (e.g. ended
// and evicted from memory) — avoids cross-turn pollution.
export function addEvent(turnId: string, type: string, data?: Record<string, unknown>): void {
  const turn = activeTurns.get(turnId)
  if (!turn) return

  const event: TraceEvent = { type, timestamp: Date.now() }
  if (data && Object.keys(data).length > 0) event.data = data
  turn.events.push(event)
}

// Mark a turn as ended and append it as one JSONL line to the session file.
export function endTurn(turnId: string, stopReason: string | null): void {
  const turn = activeTurns.get(turnId)
  if (!turn) return

  turn.endedAt = Date.now()
  turn.durationMs = turn.endedAt - turn.startedAt
  turn.stopReason = stopReason

  // Append the completed turn as one JSONL line
  mkdirSync(BEHAVIOR_DIR, { recursive: true })
  appendFileSync(sessionFile(turn.sessionId), JSON.stringify(turn) + '\n', 'utf-8')

  // Remove from memory — the file is now the source of truth
  activeTurns.delete(turnId)
}

// Get all traces for a session (oldest first).
// Reads completed turns from the JSONL file and merges in-progress turns from memory.
export function getTraces(sessionId: string): TurnTrace[] {
  const file = sessionFile(sessionId)
  const traces: TurnTrace[] = []

  if (existsSync(file)) {
    const content = readFileSync(file, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        traces.push(JSON.parse(trimmed) as TurnTrace)
      } catch {
        // Skip corrupted lines
      }
    }
  }

  // Merge in-progress turns from memory (not yet written to disk)
  for (const turn of activeTurns.values()) {
    if (turn.sessionId === sessionId) {
      traces.push(turn)
    }
  }

  // Sort by startedAt (oldest first)
  traces.sort((a, b) => a.startedAt - b.startedAt)
  return traces
}

// Get all traces across all sessions (oldest first).
// Reads all JSONL files in the behavior directory and merges in-progress turns from memory.
export function getAllTraces(): TurnTrace[] {
  const traces: TurnTrace[] = []

  if (existsSync(BEHAVIOR_DIR)) {
    const files = readdirSync(BEHAVIOR_DIR).filter((f) => f.endsWith('.jsonl'))
    for (const file of files) {
      try {
        const content = readFileSync(join(BEHAVIOR_DIR, file), 'utf-8')
        for (const line of content.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            traces.push(JSON.parse(trimmed) as TurnTrace)
          } catch {
            // Skip corrupted lines
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Merge in-progress turns from memory (not yet written to disk)
  for (const turn of activeTurns.values()) {
    traces.push(turn)
  }

  // Sort by startedAt (oldest first)
  traces.sort((a, b) => a.startedAt - b.startedAt)
  return traces
}

// Clear traces for a session — delete the JSONL file and remove in-memory active turns.
export function clearTraces(sessionId: string): void {
  // Remove in-memory active turns for this session
  for (const [turnId, turn] of activeTurns) {
    if (turn.sessionId === sessionId) {
      activeTurns.delete(turnId)
    }
  }

  const file = sessionFile(sessionId)
  if (existsSync(file)) {
    rmSync(file, { force: true })
  }
}
