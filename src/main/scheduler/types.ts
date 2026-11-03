// Scheduler types — job definitions and execution results.
// Adapted for lucid: simplified schedule/payload types, JSON storage,
// Electron IPC instead of gateway RPC.

// ── Schedule ──
export type CronSchedule =
  | { kind: 'at'; at: string } // ISO timestamp, one-shot
  | { kind: 'every'; everyMs: number; anchorMs?: number } // periodic interval
  | { kind: 'cron'; expr: string; tz?: string; staggerMs?: number } // cron expression

// ── Payload ──
export type CronPayload =
  | { kind: 'agentTurn'; message: string; timeoutSeconds?: number }
  | {
      kind: 'command'
      argv: string[]
      cwd?: string
      env?: Record<string, string>
      timeoutSeconds?: number
    }
  | { kind: 'memoryConsolidate' }

// ── Job state (mutable runtime state) ──
export interface CronJobState {
  nextRunAtMs?: number
  lastRunAtMs?: number
  runningAtMs?: number
  lastRunStatus?: 'ok' | 'error' | 'skipped'
  consecutiveErrors: number
  lastError?: string
  lastRunExitCode?: number
  lastRunSessionId?: string
}

// ── Job (persisted) ──
export interface CronJob {
  id: string
  name: string
  description?: string
  ownerType: 'system' | 'user'
  enabled: boolean
  deleteAfterRun?: boolean
  schedule: CronSchedule
  payload: CronPayload
  state: CronJobState
  createdAtMs: number
  updatedAtMs: number
}

// ── Store file ──
export interface CronStoreFile {
  version: 1
  jobs: CronJob[]
}

// ── Create/Patch inputs ──
export type CronJobCreate = Omit<
  CronJob,
  'id' | 'createdAtMs' | 'updatedAtMs' | 'state' | 'ownerType'
> & {
  id?: string
  ownerType?: 'system' | 'user'
  state?: Partial<CronJobState>
}

export type CronJobPatch = Partial<
  Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'ownerType'>
>

// ── Run outcome ──
export interface CronRunOutcome {
  status: 'ok' | 'error' | 'skipped'
  error?: string
  exitCode?: number
  sessionId?: string
  resultText?: string
  productFiles?: string[]
  durationMs: number
}

// ── Run record (persisted execution history entry) ──
export interface CronRunRecord {
  id: string
  jobId: string
  jobName: string
  startedAtMs: number
  finishedAtMs: number
  durationMs: number
  status: 'ok' | 'error' | 'skipped'
  error?: string
  exitCode?: number
  sessionId?: string
  resultText?: string
  productFiles?: string[]
  payloadKind: 'agentTurn' | 'command' | 'memoryConsolidate'
}

// ── Status summary ──
export interface CronStatusSummary {
  enabled: boolean
  jobCount: number
  nextWakeAtMs?: number
}
