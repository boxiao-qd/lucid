// Task run records — the association hub for sub-agent executions.
//
// Each run lives at ~/.lucid/subagent/runs/{runId}.json with an index at
// index.json for fast list rendering. The run record is the single source of
// truth for the three-layer association: main session ↔ leader session ↔
// member sessions (see docs/专家模块数据结构设计.md §5.6).

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import type {
  AgentType,
  RunMemberSession,
  RunStatus,
  TaskRun,
  TaskRunIndexEntry
} from '../../shared/subagent-types'
import { SUBAGENT_DIR } from './subagent-config'

const RUNS_DIR = join(SUBAGENT_DIR, 'runs')
const INDEX_FILE = join(RUNS_DIR, 'index.json')

function ensureRunsDir(): void {
  mkdirSync(RUNS_DIR, { recursive: true })
  if (process.platform !== 'win32') {
    chmodSync(RUNS_DIR, 0o700)
  }
}

function runFile(runId: string): string {
  return join(RUNS_DIR, `${runId}.json`)
}

// --- Index I/O ---

interface IndexShape {
  version: number
  runs: TaskRunIndexEntry[]
}

function readIndex(): IndexShape {
  try {
    if (!existsSync(INDEX_FILE)) return { version: 1, runs: [] }
    const raw = readFileSync(INDEX_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<IndexShape>
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      runs: Array.isArray(parsed.runs) ? parsed.runs : []
    }
  } catch {
    return { version: 1, runs: [] }
  }
}

function writeIndex(index: IndexShape): void {
  ensureRunsDir()
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8')
  if (process.platform !== 'win32') {
    chmodSync(INDEX_FILE, 0o600)
  }
}

function entryFromRun(run: TaskRun): TaskRunIndexEntry {
  return {
    runId: run.runId,
    parentSessionId: run.parentSessionId,
    parentMessageId: run.parentMessageId,
    expertAgentId: run.expertAgentId,
    expertName: run.expertName,
    ...(run.expertEmoji ? { expertEmoji: run.expertEmoji } : {}),
    expertType: run.expertType,
    leaderSessionId: run.leaderSessionId,
    status: run.status,
    task: run.task,
    createdAt: run.createdAt,
    completedAt: run.completedAt
  }
}

function upsertIndexEntry(entry: TaskRunIndexEntry): void {
  const index = readIndex()
  const existing = index.runs.findIndex((r) => r.runId === entry.runId)
  if (existing >= 0) {
    index.runs[existing] = entry
  } else {
    index.runs.unshift(entry)
  }
  writeIndex(index)
}

// --- Run file I/O ---

function readRunFile(runId: string): TaskRun | null {
  const file = runFile(runId)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<TaskRun>
    if (!parsed.runId || !parsed.parentSessionId) return null
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      runId: parsed.runId,
      parentSessionId: parsed.parentSessionId,
      parentMessageId: parsed.parentMessageId ?? '',
      expertAgentId: parsed.expertAgentId ?? '',
      expertName: parsed.expertName ?? '',
      ...(parsed.expertEmoji ? { expertEmoji: parsed.expertEmoji } : {}),
      expertType: parsed.expertType ?? 'single',
      leaderSessionId: parsed.leaderSessionId ?? '',
      memberSessions: Array.isArray(parsed.memberSessions) ? parsed.memberSessions : [],
      status: parsed.status ?? 'pending',
      task: parsed.task ?? '',
      createdAt: parsed.createdAt ?? 0,
      startedAt: parsed.startedAt ?? 0,
      completedAt: parsed.completedAt ?? null,
      result: parsed.result ?? null
    }
  } catch {
    return null
  }
}

function writeRunFile(run: TaskRun): void {
  ensureRunsDir()
  writeFileSync(runFile(run.runId), JSON.stringify(run, null, 2), 'utf-8')
  if (process.platform !== 'win32') {
    chmodSync(runFile(run.runId), 0o600)
  }
}

// --- Public API ---

export interface CreateTaskRunOpts {
  parentSessionId: string
  parentMessageId: string
  expertAgentId: string
  expertName: string
  expertEmoji?: string
  expertType: AgentType
  leaderSessionId: string
  task: string
}

export function createTaskRun(opts: CreateTaskRunOpts): TaskRun {
  const now = Date.now()
  const runId = randomUUID()
  const run: TaskRun = {
    version: 1,
    runId,
    parentSessionId: opts.parentSessionId,
    parentMessageId: opts.parentMessageId,
    expertAgentId: opts.expertAgentId,
    expertName: opts.expertName,
    ...(opts.expertEmoji ? { expertEmoji: opts.expertEmoji } : {}),
    expertType: opts.expertType,
    leaderSessionId: opts.leaderSessionId,
    memberSessions: [],
    status: 'pending',
    task: opts.task,
    createdAt: now,
    startedAt: now,
    completedAt: null,
    result: null
  }
  writeRunFile(run)
  upsertIndexEntry(entryFromRun(run))
  return run
}

export function getTaskRun(runId: string): TaskRun | null {
  return readRunFile(runId)
}

export function listTaskRuns(): TaskRunIndexEntry[] {
  return readIndex().runs.sort((a, b) => b.createdAt - a.createdAt)
}

export function listTaskRunsByParentSession(parentSessionId: string): TaskRunIndexEntry[] {
  return listTaskRuns().filter((r) => r.parentSessionId === parentSessionId)
}

export function updateTaskRun(
  runId: string,
  partial: Partial<Omit<TaskRun, 'runId' | 'parentSessionId' | 'expertAgentId'>>
): TaskRun | null {
  const run = readRunFile(runId)
  if (!run) return null
  const updated: TaskRun = {
    ...run,
    ...partial,
    runId: run.runId,
    parentSessionId: run.parentSessionId,
    expertAgentId: run.expertAgentId
  }
  writeRunFile(updated)
  upsertIndexEntry(entryFromRun(updated))
  return updated
}

export function setRunStatus(
  runId: string,
  status: RunStatus,
  result?: string | null
): TaskRun | null {
  const now = Date.now()
  const patch: Partial<TaskRun> = { status }
  if (status === 'completed' || status === 'failed') {
    patch.completedAt = now
    if (result !== undefined) patch.result = result
  }
  if (status === 'running') {
    patch.startedAt = now
  }
  return updateTaskRun(runId, patch)
}

export function addMemberSession(
  runId: string,
  member: { agentId: string; sessionId: string }
): TaskRun | null {
  const run = readRunFile(runId)
  if (!run) return null
  const existing = run.memberSessions.find((m) => m.agentId === member.agentId)
  if (existing) {
    // Agent already registered — update sessionId and reset status for retry
    existing.sessionId = member.sessionId
    existing.status = 'running'
    existing.startedAt = Date.now()
    existing.completedAt = null
    existing.result = null
    writeRunFile(run)
    upsertIndexEntry(entryFromRun(run))
    return run
  }
  const entry: RunMemberSession = {
    agentId: member.agentId,
    sessionId: member.sessionId,
    status: 'running',
    startedAt: Date.now(),
    completedAt: null,
    result: null
  }
  run.memberSessions.push(entry)
  writeRunFile(run)
  upsertIndexEntry(entryFromRun(run))
  return run
}

export function updateMemberSession(
  runId: string,
  agentId: string,
  partial: Partial<Pick<RunMemberSession, 'status' | 'result' | 'completedAt'>>
): TaskRun | null {
  const run = readRunFile(runId)
  if (!run) return null
  const member = run.memberSessions.find((m) => m.agentId === agentId)
  if (!member) return run
  if (partial.status !== undefined) member.status = partial.status
  if (partial.result !== undefined) member.result = partial.result
  if (partial.completedAt !== undefined) member.completedAt = partial.completedAt
  if (partial.status === 'completed' || partial.status === 'failed') {
    if (member.completedAt === null) member.completedAt = Date.now()
  }
  writeRunFile(run)
  upsertIndexEntry(entryFromRun(run))
  return run
}

export { entryFromRun }
