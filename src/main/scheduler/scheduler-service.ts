// Scheduler service — singleton encapsulating timer + store + CRUD.
// Initialized at app startup, stopped on app quit.

import { existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { loadStore, saveStore, OLD_STORE_PATH } from './store'
import {
  createJob,
  applyJobPatch,
  computeJobNextRunAtMs,
  recomputeNextRuns,
  nextWakeAtMs
} from './jobs'
import { armTimer, runMissedJobs, stopTimer, type SchedulerState } from './timer'
import { executePayload } from './payload-executors'
import {
  addRunRecord,
  listRunRecords,
  clearRunRecords,
  listRunRecordsByJob,
  listRunRecordsGrouped,
  clearJobRunRecords,
  OLD_RUNS_PATH,
  RECORD_DIR
} from './run-store'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronStatusSummary,
  CronRunOutcome,
  CronRunRecord
} from './types'

let state: SchedulerState | null = null

// Stable ID for the system memory consolidation job
const SYSTEM_MEMORY_CONSOLIDATE_ID = 'system-memory-consolidate'

// One-time migration from old paths to new workspace/cron layout
function migrateOldStore(): void {
  // Migrate jobs.json → cron.json
  if (existsSync(OLD_STORE_PATH)) {
    const newStorePath = join(homedir(), '.lucid', 'workspace', 'cron', 'cron.json')
    if (!existsSync(newStorePath)) {
      try {
        const raw = readFileSync(OLD_STORE_PATH, 'utf-8')
        const parsed = JSON.parse(raw) as { version: number; jobs: CronJob[] }
        if (parsed && Array.isArray(parsed.jobs)) {
          // Add ownerType: 'user' to any job missing it
          for (const job of parsed.jobs) {
            if (!job.ownerType) {
              job.ownerType = 'user'
            }
          }
          mkdirSync(join(homedir(), '.lucid', 'workspace', 'cron'), { recursive: true })
          saveStore({ version: 1, jobs: parsed.jobs })
          console.log(`[Scheduler] Migrated ${parsed.jobs.length} job(s) to new path`)
        }
      } catch (e) {
        console.error('[Scheduler] Failed to migrate old store:', e)
      }
    }
  }

  // Migrate runs.json → per-job JSONL files
  if (existsSync(OLD_RUNS_PATH)) {
    try {
      const raw = readFileSync(OLD_RUNS_PATH, 'utf-8')
      const parsed = JSON.parse(raw) as { version: number; records: CronRunRecord[] }
      if (parsed && Array.isArray(parsed.records) && parsed.records.length > 0) {
        mkdirSync(RECORD_DIR, { recursive: true })
        // Group by jobId
        const groups = new Map<string, CronRunRecord[]>()
        for (const record of parsed.records) {
          const list = groups.get(record.jobId) ?? []
          list.push(record)
          groups.set(record.jobId, list)
        }
        // Write each group as JSONL
        for (const [jobId, records] of groups) {
          const path = join(RECORD_DIR, `${jobId}.jsonl`)
          // Sort by time ascending, then cap at 200 (keep newest)
          records.sort((a, b) => a.startedAtMs - b.startedAtMs)
          const capped = records.slice(-200)
          const lines = capped.map((r) => JSON.stringify(r)).join('\n')
          const tmp = `${path}.tmp`
          writeFileSync(tmp, lines + '\n', 'utf-8')
          renameSync(tmp, path)
        }
        console.log(`[Scheduler] Migrated ${parsed.records.length} run record(s) to per-job JSONL`)
      }
      // Delete old runs.json after successful migration
      unlinkSync(OLD_RUNS_PATH)
    } catch (e) {
      console.error('[Scheduler] Failed to migrate old runs store:', e)
    }
  }
}

// Seed system built-in jobs (idempotent — only adds if missing)
function seedSystemJobs(): void {
  if (!state) return
  const existing = state.jobs.find((j) => j.id === SYSTEM_MEMORY_CONSOLIDATE_ID)
  if (existing) return

  const now = Date.now()
  const systemJob = createJob(
    {
      id: SYSTEM_MEMORY_CONSOLIDATE_ID,
      name: '记忆整理',
      description: '每天凌晨3点执行：短期记忆升级为长期记忆 + 去重',
      ownerType: 'system',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 3 * * *' },
      payload: { kind: 'memoryConsolidate' }
    },
    now
  )
  state.jobs.push(systemJob)
  saveStore({ version: 1, jobs: state.jobs })
  console.log('[Scheduler] Seeded system job: 记忆整理')
}

// Initialize: migrate old data, load store, seed system jobs, catch up, arm timer
export function initScheduler(): void {
  if (state) return

  // One-time migration from old paths
  migrateOldStore()

  const store = loadStore()
  state = {
    jobs: store.jobs,
    timer: null,
    running: false,
    started: true
  }

  // Seed system jobs (idempotent)
  seedSystemJobs()

  recomputeNextRuns(state.jobs, Date.now())
  saveStore({ version: 1, jobs: state.jobs })

  console.log(`[Scheduler] Initialized with ${state.jobs.length} job(s)`)

  // Catch up missed jobs, then arm the timer
  void runMissedJobs(state).then(() => {
    armTimer(state!)
  })
}

// Stop: clear timer, persist state
export function stopScheduler(): void {
  if (!state) return
  stopTimer(state)
  saveStore({ version: 1, jobs: state.jobs })
  state = null
  console.log('[Scheduler] Stopped')
}

// List all jobs — system jobs first, then user jobs, each by createdAtMs ascending
export function listJobs(): CronJob[] {
  if (!state) return []
  return [...state.jobs].sort((a, b) => {
    if (a.ownerType !== b.ownerType) {
      return a.ownerType === 'system' ? -1 : 1
    }
    return a.createdAtMs - b.createdAtMs
  })
}

// Add a new job
export function addJob(input: CronJobCreate): CronJob {
  if (!state) throw new Error('Scheduler not initialized')
  const job = createJob(input, Date.now())
  state.jobs.push(job)
  saveStore({ version: 1, jobs: state.jobs })
  armTimer(state)
  return job
}

// Update a job by id. System jobs cannot be disabled.
export function updateJob(id: string, patch: CronJobPatch): CronJob | null {
  if (!state) throw new Error('Scheduler not initialized')
  const job = state.jobs.find((j) => j.id === id)
  if (!job) return null
  if (job.ownerType === 'system' && patch.enabled === false) {
    throw new Error('系统内置任务不可禁用')
  }
  applyJobPatch(job, patch, Date.now())
  saveStore({ version: 1, jobs: state.jobs })
  armTimer(state)
  return job
}

// Remove a job by id. System jobs cannot be deleted.
export function removeJob(id: string): boolean {
  if (!state) throw new Error('Scheduler not initialized')
  const job = state.jobs.find((j) => j.id === id)
  if (!job) return false
  if (job.ownerType === 'system') {
    throw new Error('系统内置任务不可删除')
  }
  const before = state.jobs.length
  state.jobs = state.jobs.filter((j) => j.id !== id)
  if (state.jobs.length === before) return false
  saveStore({ version: 1, jobs: state.jobs })
  armTimer(state)
  return true
}

// Manually trigger a job now (force run, ignores schedule)
export async function runJobNow(id: string): Promise<CronRunOutcome | null> {
  if (!state) return null
  const job = state.jobs.find((j) => j.id === id)
  if (!job) return null

  const start = Date.now()
  let outcome: CronRunOutcome
  try {
    outcome = await executePayload(job)
  } catch (e) {
    outcome = {
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - start
    }
  }
  applyManualRunResult(job, outcome, start)
  saveStore({ version: 1, jobs: state.jobs })
  armTimer(state)

  // Persist run record
  addRunRecord({
    jobId: job.id,
    jobName: job.name,
    startedAtMs: start,
    finishedAtMs: Date.now(),
    durationMs: outcome.durationMs,
    status: outcome.status,
    error: outcome.error,
    exitCode: outcome.exitCode,
    sessionId: outcome.sessionId,
    resultText: outcome.resultText,
    productFiles: outcome.productFiles,
    payloadKind: job.payload.kind
  })

  return outcome
}

// Apply a manual run result (doesn't use the timer's applyJobResult to avoid
// deleteAfterRun side-effects on manual runs)
function applyManualRunResult(job: CronJob, outcome: CronRunOutcome, start: number): void {
  job.state.lastRunAtMs = start
  job.state.lastRunStatus = outcome.status
  job.state.lastError = outcome.error
  job.state.lastRunExitCode = outcome.exitCode
  job.state.lastRunSessionId = outcome.sessionId

  if (outcome.status === 'error') {
    job.state.consecutiveErrors++
  } else {
    job.state.consecutiveErrors = 0
  }

  // Recompute next run from schedule (manual run doesn't change the schedule)
  job.state.nextRunAtMs = computeJobNextRunAtMs(job, Date.now())
}

// Get scheduler status summary
export function getStatus(): CronStatusSummary {
  if (!state) return { enabled: false, jobCount: 0 }
  return {
    enabled: true,
    jobCount: state.jobs.length,
    nextWakeAtMs: nextWakeAtMs(state.jobs)
  }
}

// Re-export run record functions
export {
  listRunRecords,
  clearRunRecords,
  listRunRecordsByJob,
  listRunRecordsGrouped,
  clearJobRunRecords
}
export type { CronRunRecord }
