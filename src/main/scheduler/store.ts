// Scheduler store — JSON file storage at ~/.lucid/workspace/cron/cron.json.
// Atomic writes via temp file + rename.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import type { CronStoreFile } from './types'

const STORE_DIR = join(homedir(), '.lucid', 'workspace', 'cron')
const STORE_PATH = join(STORE_DIR, 'cron.json')

// Old path — used by migrateOldStore() for one-time migration
const OLD_STORE_DIR = join(homedir(), '.lucid', 'scheduler')
const OLD_STORE_PATH = join(OLD_STORE_DIR, 'jobs.json')

export { STORE_PATH, OLD_STORE_PATH }

export function loadStore(): CronStoreFile {
  if (!existsSync(STORE_PATH)) return { version: 1, jobs: [] }
  try {
    const raw = readFileSync(STORE_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as CronStoreFile
    if (parsed && Array.isArray(parsed.jobs)) return parsed
    return { version: 1, jobs: [] }
  } catch {
    console.error('[Scheduler] Failed to load store, starting fresh')
    return { version: 1, jobs: [] }
  }
}

// Atomic write: write to temp file, then rename (prevents corruption on crash)
export function saveStore(store: CronStoreFile): void {
  mkdirSync(STORE_DIR, { recursive: true })
  const tmp = `${STORE_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8')
  renameSync(tmp, STORE_PATH)
}
