// Run store — per-job JSONL storage at ~/.lucid/workspace/cron/record/{jobId}.jsonl.
// Each job has its own file, one JSON record per line, capped at 200 records per job.
// Atomic writes via temp file + rename (same pattern as store.ts).

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
  unlinkSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { CronRunRecord } from './types'

const RECORD_DIR = join(homedir(), '.lucid', 'workspace', 'cron', 'record')
const MAX_RECORDS = 200

// Old path — used by migrateOldStore() for one-time migration
const OLD_RUNS_PATH = join(homedir(), '.lucid', 'scheduler', 'runs.json')

export { RECORD_DIR, OLD_RUNS_PATH }

function recordPath(jobId: string): string {
  return join(RECORD_DIR, `${jobId}.jsonl`)
}

// Append a record to the job's JSONL file. Caps at MAX_RECORDS (drops oldest).
export function addRunRecord(record: Omit<CronRunRecord, 'id'>): CronRunRecord {
  mkdirSync(RECORD_DIR, { recursive: true })
  const fullRecord: CronRunRecord = { ...record, id: randomUUID() }
  const path = recordPath(record.jobId)

  // Read existing records for this job
  const existing = readJobRecords(path)

  // Prepend new record, cap at MAX_RECORDS (drop oldest at the end)
  existing.unshift(fullRecord)
  const capped = existing.slice(0, MAX_RECORDS)

  // Write all records as JSONL
  const lines = capped.map((r) => JSON.stringify(r)).join('\n')
  const tmp = `${path}.tmp`
  writeFileSync(tmp, lines + '\n', 'utf-8')
  renameSync(tmp, path)

  return fullRecord
}

// Read records from a single JSONL file
function readJobRecords(path: string): CronRunRecord[] {
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf-8')
    return raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as CronRunRecord)
  } catch {
    console.error(`[Scheduler] Failed to read run records from ${path}`)
    return []
  }
}

// List all records across all jobs, sorted by startedAtMs descending
export function listRunRecords(): CronRunRecord[] {
  if (!existsSync(RECORD_DIR)) return []
  const all: CronRunRecord[] = []
  for (const file of readdirSync(RECORD_DIR)) {
    if (!file.endsWith('.jsonl')) continue
    all.push(...readJobRecords(join(RECORD_DIR, file)))
  }
  all.sort((a, b) => b.startedAtMs - a.startedAtMs)
  return all
}

// List records for a single job, sorted by startedAtMs descending
export function listRunRecordsByJob(jobId: string): CronRunRecord[] {
  const records = readJobRecords(recordPath(jobId))
  records.sort((a, b) => b.startedAtMs - a.startedAtMs)
  return records
}

// Group all records by jobId. Each group is sorted by time descending.
// Groups are sorted by latest record time descending.
export function listRunRecordsGrouped(): Map<string, CronRunRecord[]> {
  if (!existsSync(RECORD_DIR)) return new Map()
  const groups = new Map<string, CronRunRecord[]>()
  for (const file of readdirSync(RECORD_DIR)) {
    if (!file.endsWith('.jsonl')) continue
    const jobId = file.slice(0, -6) // strip ".jsonl"
    const records = readJobRecords(join(RECORD_DIR, file))
    records.sort((a, b) => b.startedAtMs - a.startedAtMs)
    groups.set(jobId, records)
  }
  // Sort groups by latest record time descending
  const sorted = new Map(
    [...groups.entries()].sort((a, b) => {
      const aLatest = a[1][0]?.startedAtMs ?? 0
      const bLatest = b[1][0]?.startedAtMs ?? 0
      return bLatest - aLatest
    })
  )
  return sorted
}

// Clear all run records
export function clearRunRecords(): void {
  if (!existsSync(RECORD_DIR)) return
  for (const file of readdirSync(RECORD_DIR)) {
    if (file.endsWith('.jsonl')) {
      unlinkSync(join(RECORD_DIR, file))
    }
  }
}

// Clear run records for a single job
export function clearJobRunRecords(jobId: string): void {
  const path = recordPath(jobId)
  if (existsSync(path)) {
    unlinkSync(path)
  }
}
