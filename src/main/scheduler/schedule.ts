// Schedule computation — calculates next fire time from cron expressions.
// Uses croner for cron expression parsing with an LRU cache.

import { Cron } from 'croner'
import type { CronSchedule } from './types'

const CRON_CACHE_MAX = 512
const cronCache = new Map<string, Cron>()

// LRU cache for Cron instances, keyed by `${tz}\0${expr}`
function resolveCachedCron(expr: string, tz?: string): Cron | undefined {
  const timezone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone
  const key = `${timezone}\0${expr}`

  const cached = cronCache.get(key)
  if (cached) {
    // Move to end (most recently used)
    cronCache.delete(key)
    cronCache.set(key, cached)
    return cached
  }

  try {
    const instance = new Cron(expr, { timezone })
    if (cronCache.size >= CRON_CACHE_MAX) {
      // Evict oldest (first entry)
      const oldest = cronCache.keys().next().value
      if (oldest) cronCache.delete(oldest)
    }
    cronCache.set(key, instance)
    return instance
  } catch {
    return undefined
  }
}

// Parse ISO timestamp string to epoch ms. Returns null on failure.
function parseAbsoluteTimeMs(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Pure epoch ms
  if (/^\d+$/.test(trimmed)) {
    const ms = parseInt(trimmed, 10)
    return Number.isFinite(ms) ? ms : null
  }

  // ISO date-only → normalize to UTC midnight
  let normalized = trimmed
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    normalized = `${normalized}T00:00:00Z`
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(normalized) && !/[Zz]|[+-]\d{2}:?\d{2}$/.test(normalized)) {
    normalized = `${normalized}Z`
  }

  const ms = Date.parse(normalized)
  return Number.isNaN(ms) ? null : ms
}

// Compute the next scheduled run timestamp after nowMs.
// Returns undefined for schedules that won't fire (past one-shots, invalid cron).
export function computeNextRunAtMs(
  schedule: CronSchedule,
  nowMs: number,
  staggerOffset = 0
): number | undefined {
  switch (schedule.kind) {
    case 'at': {
      const target = parseAbsoluteTimeMs(schedule.at)
      if (target === null) return undefined
      return target > nowMs ? target : undefined
    }

    case 'every': {
      if (schedule.everyMs <= 0) return undefined
      const anchor = schedule.anchorMs ?? 0
      // Align to anchor: next = anchor + ceil((now - anchor) / everyMs) * everyMs
      const elapsed = nowMs - anchor
      const intervals = Math.floor(elapsed / schedule.everyMs)
      let next = anchor + (intervals + 1) * schedule.everyMs
      if (next <= nowMs) next += schedule.everyMs
      return next
    }

    case 'cron': {
      const cron = resolveCachedCron(schedule.expr, schedule.tz)
      if (!cron) return undefined

      const nextRun = cron.nextRun(new Date(nowMs))
      if (!nextRun) return undefined

      // Apply stagger offset (deterministic per-job jitter for top-of-hour schedules)
      if (staggerOffset > 0) {
        return nextRun.getTime() + staggerOffset
      }

      return nextRun.getTime()
    }
  }
}

// Compute the previous scheduled run timestamp before nowMs (for missed catch-up).
export function computePreviousRunAtMs(
  schedule: CronSchedule,
  nowMs: number,
  staggerOffset = 0
): number | undefined {
  if (schedule.kind !== 'cron') return undefined

  const cron = resolveCachedCron(schedule.expr, schedule.tz)
  if (!cron) return undefined

  const prevRuns = cron.previousRuns(1, new Date(nowMs))
  const prevRun = prevRuns[0]
  if (!prevRun) return undefined

  if (staggerOffset > 0) {
    return prevRun.getTime() + staggerOffset
  }

  return prevRun.getTime()
}
