// Job helpers — create, update, delete, and list scheduled jobs.
// createJob, applyJobPatch, computeJobNextRunAtMs, isJobDue, errorBackoff,
// recomputeNextRuns, stagger offset computation.

import { randomUUID, createHash } from 'node:crypto'
import type { CronJob, CronJobCreate, CronJobPatch } from './types'
import { computeNextRunAtMs } from './schedule'

// Error backoff schedule: [30s, 60s, 5min, 15min, 1h]
const ERROR_BACKOFF_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]

// Default stagger for top-of-hour cron expressions (5 minutes)
const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000

// Check if a cron expression fires at minute 0 of every hour
function isRecurringTopOfHourCronExpr(expr: string): boolean {
  return /^0\s+\*\s+\*\s+\*\s+\*/.test(expr.trim())
}

// Resolve effective stagger: explicit value, then default for top-of-hour, else 0
function resolveStaggerMs(schedule: Extract<CronJob['schedule'], { kind: 'cron' }>): number {
  if (schedule.staggerMs !== undefined) return schedule.staggerMs
  if (isRecurringTopOfHourCronExpr(schedule.expr)) return DEFAULT_TOP_OF_HOUR_STAGGER_MS
  return 0
}

// Deterministic stagger offset based on jobId (prevents thundering herd)
function computeStaggerOffset(jobId: string, staggerMs: number): number {
  if (staggerMs <= 0) return 0
  const hash = createHash('sha256').update(jobId).digest('hex')
  return parseInt(hash.slice(0, 8), 16) % staggerMs
}

// Get the stagger offset for a job (used by schedule computation + timer)
export function getJobStaggerOffset(job: CronJob): number {
  if (job.schedule.kind !== 'cron') return 0
  const staggerMs = resolveStaggerMs(job.schedule)
  return computeStaggerOffset(job.id, staggerMs)
}

// Create a new job from input: normalize fields, compute initial nextRunAtMs
export function createJob(input: CronJobCreate, nowMs: number): CronJob {
  const id = input.id || randomUUID()
  const now = nowMs

  const job: CronJob = {
    id,
    name: input.name,
    description: input.description,
    ownerType: input.ownerType ?? 'user',
    enabled: input.enabled,
    deleteAfterRun: input.deleteAfterRun,
    schedule: input.schedule,
    payload: input.payload,
    state: {
      consecutiveErrors: 0,
      ...input.state
    },
    createdAtMs: now,
    updatedAtMs: now
  }

  // Compute initial next run
  const offset = getJobStaggerOffset(job)
  job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, nowMs, offset)

  // One-shot 'at' jobs default to deleteAfterRun
  if (job.schedule.kind === 'at' && job.deleteAfterRun === undefined) {
    job.deleteAfterRun = true
  }

  return job
}

// Apply a patch to an existing job. If schedule changes, recompute nextRunAtMs.
export function applyJobPatch(job: CronJob, patch: CronJobPatch, nowMs: number): void {
  const scheduleChanged = patch.schedule && patch.schedule !== job.schedule

  if (patch.name !== undefined) job.name = patch.name
  if (patch.description !== undefined) job.description = patch.description
  if (patch.enabled !== undefined) job.enabled = patch.enabled
  if (patch.deleteAfterRun !== undefined) job.deleteAfterRun = patch.deleteAfterRun
  if (patch.schedule !== undefined) job.schedule = patch.schedule
  if (patch.payload !== undefined) job.payload = patch.payload

  job.updatedAtMs = nowMs

  // Recompute next run if schedule or enabled state changed
  if (scheduleChanged || patch.enabled !== undefined) {
    if (job.enabled) {
      const offset = getJobStaggerOffset(job)
      job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, nowMs, offset)
    } else {
      // Disabled jobs don't have a next run
      job.state.nextRunAtMs = undefined
    }
  }
}

// Compute the next run time for a job
export function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined {
  const offset = getJobStaggerOffset(job)
  return computeNextRunAtMs(job.schedule, nowMs, offset)
}

// Check if a job is due to run now
export function isJobDue(job: CronJob, nowMs: number): boolean {
  return (
    job.enabled &&
    !job.state.runningAtMs &&
    job.state.nextRunAtMs !== undefined &&
    job.state.nextRunAtMs <= nowMs
  )
}

// Get the backoff delay after consecutive errors
export function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors, ERROR_BACKOFF_MS.length) - 1
  return ERROR_BACKOFF_MS[Math.max(0, idx)]
}

// Recompute missing/stale nextRunAtMs for all jobs (called at startup)
export function recomputeNextRuns(jobs: CronJob[], nowMs: number): boolean {
  let changed = false
  for (const job of jobs) {
    if (!job.state) {
      job.state = { consecutiveErrors: 0 }
      changed = true
    }

    // Clear stuck running markers (app crashed mid-run)
    if (job.state.runningAtMs) {
      console.warn(`[Scheduler] Clearing stuck run marker for job "${job.name}"`)
      job.state.runningAtMs = undefined
      job.state.lastRunStatus = 'error'
      job.state.lastError = 'Job interrupted by app restart'
      changed = true
    }

    // Recompute nextRunAtMs if missing or if enabled but no future run
    if (job.enabled) {
      const needsRecompute = job.state.nextRunAtMs === undefined || job.state.nextRunAtMs <= nowMs
      if (needsRecompute) {
        const offset = getJobStaggerOffset(job)
        const next = computeNextRunAtMs(job.schedule, nowMs, offset)
        if (next !== job.state.nextRunAtMs) {
          job.state.nextRunAtMs = next
          changed = true
        }
      }
    } else {
      if (job.state.nextRunAtMs !== undefined) {
        job.state.nextRunAtMs = undefined
        changed = true
      }
    }
  }
  return changed
}

// Find the earliest next wake time across all enabled jobs
export function nextWakeAtMs(jobs: CronJob[]): number | undefined {
  const times = jobs
    .filter((j) => j.enabled && j.state.nextRunAtMs && !j.state.runningAtMs)
    .map((j) => j.state.nextRunAtMs!)
  if (times.length === 0) return undefined
  return Math.min(...times)
}
