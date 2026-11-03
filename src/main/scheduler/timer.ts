// Timer loop — polls for due jobs and executes them.
// setTimeout-based loop: armTimer computes next wake, onTimer collects due
// jobs, executes them with concurrency limit, applies results, re-arms.

import type { CronJob, CronRunOutcome } from './types'
import { isJobDue, computeJobNextRunAtMs, errorBackoffMs } from './jobs'
import { saveStore } from './store'
import { addRunRecord } from './run-store'

const MAX_TIMER_DELAY_MS = 60_000 // setTimeout clamp (1 min)
const MIN_REFIRE_GAP_MS = 2_000 // minimum re-arm delay
const MAX_CONCURRENT_RUNS = 3 // max parallel job executions per tick
const MAX_MISSED_JOBS = 5 // startup catch-up limit

export interface SchedulerState {
  jobs: CronJob[]
  timer: NodeJS.Timeout | null
  running: boolean
  started: boolean
}

// Arm the timer for the next wake. Computes the earliest nextRunAtMs across
// all enabled, non-running jobs, sets a setTimeout clamped to [2s, 60s].
export function armTimer(state: SchedulerState): void {
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
  if (!state.started) return

  const now = Date.now()
  const nextWake = state.jobs
    .filter((j) => j.enabled && j.state.nextRunAtMs && !j.state.runningAtMs)
    .map((j) => j.state.nextRunAtMs!)
    .reduce((min, v) => Math.min(min, v), Infinity)

  if (!isFinite(nextWake)) return

  const delay = Math.max(MIN_REFIRE_GAP_MS, Math.min(nextWake - now, MAX_TIMER_DELAY_MS))
  state.timer = setTimeout(() => void onTimer(state), delay)
  // Don't keep the process alive just for the timer — let the app control lifecycle
  state.timer.unref?.()
}

// Timer tick: collect due jobs → mark running → execute → apply results → persist → re-arm
async function onTimer(state: SchedulerState): Promise<void> {
  if (state.running) return // re-entrancy guard
  state.running = true
  try {
    const now = Date.now()
    const due = state.jobs.filter((j) => isJobDue(j, now)).slice(0, MAX_CONCURRENT_RUNS)

    if (due.length === 0) return

    // Reserve: mark as running before execution (crash recovery)
    for (const job of due) {
      job.state.runningAtMs = now
    }
    saveStore({ version: 1, jobs: state.jobs })

    // Execute all due jobs concurrently
    const { executePayload } = await import('./payload-executors')
    await Promise.allSettled(
      due.map(async (job) => {
        let outcome: CronRunOutcome
        try {
          outcome = await executePayload(job)
        } catch (e) {
          outcome = {
            status: 'error',
            error: e instanceof Error ? e.message : String(e),
            durationMs: 0
          }
        }
        applyJobResult(state, job, outcome)
        addRunRecord({
          jobId: job.id,
          jobName: job.name,
          startedAtMs: now,
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
      })
    )

    saveStore({ version: 1, jobs: state.jobs })
  } finally {
    state.running = false
    armTimer(state)
  }
}

// Apply a run outcome to a job's state.
function applyJobResult(state: SchedulerState, job: CronJob, outcome: CronRunOutcome): void {
  const now = Date.now()
  job.state.lastRunAtMs = now
  job.state.runningAtMs = undefined
  job.state.lastRunStatus = outcome.status
  job.state.lastError = outcome.error
  job.state.lastRunExitCode = outcome.exitCode
  job.state.lastRunSessionId = outcome.sessionId

  if (outcome.status === 'error') {
    job.state.consecutiveErrors++
    // Backoff: nextRunAtMs = now + errorBackoff
    job.state.nextRunAtMs = now + errorBackoffMs(job.state.consecutiveErrors)
  } else {
    job.state.consecutiveErrors = 0
    // Normal: compute next run from schedule
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, now)
  }

  // One-shot tasks: delete after successful/error execution
  if (job.deleteAfterRun && outcome.status !== 'skipped') {
    state.jobs = state.jobs.filter((j) => j.id !== job.id)
  }
}

// Startup catch-up: run jobs that were due while the app was down.
// Limited to MAX_MISSED_JOBS to prevent flood on long downtime.
export async function runMissedJobs(state: SchedulerState): Promise<void> {
  const now = Date.now()
  const missed = state.jobs
    .filter(
      (j) => j.enabled && j.state.nextRunAtMs && j.state.nextRunAtMs < now && !j.state.runningAtMs
    )
    .slice(0, MAX_MISSED_JOBS)

  if (missed.length === 0) return

  console.log(`[Scheduler] Catching up ${missed.length} missed job(s)`)
  const { executePayload } = await import('./payload-executors')

  for (const job of missed) {
    job.state.runningAtMs = now
    let outcome: CronRunOutcome
    try {
      outcome = await executePayload(job)
    } catch (e) {
      outcome = {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
        durationMs: 0
      }
    }
    applyJobResult(state, job, outcome)
    addRunRecord({
      jobId: job.id,
      jobName: job.name,
      startedAtMs: now,
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
  }
  saveStore({ version: 1, jobs: state.jobs })
}

export function stopTimer(state: SchedulerState): void {
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
  state.started = false
}
