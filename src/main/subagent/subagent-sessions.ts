// Sub-agent session storage — JSONL sessions under
// ~/.lucid/subagent/sessions/{agentId}/{sessionId}.jsonl with an index at
// sessions.json in the same folder.
//
// Mirrors src/main/sessions.ts but with:
//   - sub-agent root path
//   - per-agent folder layout
//   - extended first-line header (parentRunId / parentSessionId / task)
//   - sessions.json index with status tracking

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
  readdirSync
} from 'node:fs'
import type { Message, MessageType } from '../../shared/types'
import type { MessageExpertRef } from '../../shared/subagent-types'
import type {
  SessionStatus,
  SubagentSessionHeader,
  SubagentSessionMeta
} from '../../shared/subagent-types'
import { SUBAGENT_DIR } from './subagent-config'

const SESSIONS_ROOT = join(SUBAGENT_DIR, 'sessions')

const DEFAULT_TITLE = '子智能体任务'

function agentSessionsDir(agentId: string): string {
  return join(SESSIONS_ROOT, agentId)
}

function agentIndexFile(agentId: string): string {
  return join(agentSessionsDir(agentId), 'sessions.json')
}

function sessionFile(agentId: string, sessionId: string): string {
  return join(agentSessionsDir(agentId), `${sessionId}.jsonl`)
}

function ensureAgentDir(agentId: string): void {
  mkdirSync(agentSessionsDir(agentId), { recursive: true })
  if (process.platform !== 'win32') {
    chmodSync(agentSessionsDir(agentId), 0o700)
  }
}

interface IndexShape {
  version: number
  agentId: string
  sessions: SubagentSessionMeta[]
}

function readIndex(agentId: string): IndexShape {
  const file = agentIndexFile(agentId)
  try {
    if (!existsSync(file)) {
      return { version: 1, agentId, sessions: [] }
    }
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<IndexShape>
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      agentId,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
    }
  } catch {
    return { version: 1, agentId, sessions: [] }
  }
}

function writeIndex(agentId: string, index: IndexShape): void {
  ensureAgentDir(agentId)
  writeFileSync(agentIndexFile(agentId), JSON.stringify(index, null, 2), 'utf-8')
  if (process.platform !== 'win32') {
    chmodSync(agentIndexFile(agentId), 0o600)
  }
}

export interface CreateSubagentSessionOpts {
  parentRunId: string
  parentSessionId: string
  task: string
  title?: string
}

export function createSubagentSession(
  agentId: string,
  opts: CreateSubagentSessionOpts
): SubagentSessionMeta {
  ensureAgentDir(agentId)
  const now = Date.now()
  const id = randomUUID()
  const title = opts.title ?? (opts.task.length > 20 ? opts.task.slice(0, 20) + '…' : opts.task)

  // First line: header with association info
  const header: SubagentSessionHeader = {
    type: 'session',
    id,
    agentId,
    createdAt: now,
    parentRunId: opts.parentRunId,
    parentSessionId: opts.parentSessionId,
    task: opts.task
  }
  const file = sessionFile(agentId, id)
  writeFileSync(file, `${JSON.stringify(header)}\n`, 'utf-8')
  if (process.platform !== 'win32') {
    chmodSync(file, 0o600)
  }

  // Update index
  const meta: SubagentSessionMeta = {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    parentRunId: opts.parentRunId,
    parentSessionId: opts.parentSessionId,
    status: 'running'
  }
  const index = readIndex(agentId)
  index.sessions.unshift(meta)
  writeIndex(agentId, index)

  return meta
}

export function getSubagentSessionMessages(agentId: string, sessionId: string): Message[] {
  const file = sessionFile(agentId, sessionId)
  try {
    if (!existsSync(file)) return []
    const raw = readFileSync(file, 'utf-8')
    const messages: Message[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let entry: {
        type?: string
        messageType?: string
        id?: string
        role?: string
        content?: string
        createdAt?: number
        attachments?: string[]
        images?: string[]
        toolCallId?: string
        toolName?: string
        isError?: boolean
        expert?: MessageExpertRef
      }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.type === 'message' && entry.id && entry.role && typeof entry.content === 'string') {
        const expert =
          entry.expert && typeof entry.expert === 'object'
            ? (entry.expert as MessageExpertRef)
            : undefined
        const atts = entry.attachments ?? entry.images
        messages.push({
          id: entry.id,
          role: entry.role as 'user' | 'assistant',
          content: entry.content,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
          type: (entry.messageType as MessageType) || 'text',
          ...(atts?.length ? { attachments: atts as string[] } : {}),
          ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
          ...(entry.toolName ? { toolName: entry.toolName } : {}),
          ...(entry.isError !== undefined ? { isError: entry.isError } : {}),
          ...(expert ? { expert } : {})
        })
      }
    }
    return messages
  } catch {
    return []
  }
}

export interface AppendMessageMetadata {
  toolCallId?: string
  toolName?: string
  isError?: boolean
  expert?: MessageExpertRef
}

export function appendSubagentSessionMessage(
  agentId: string,
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  messageType: MessageType = 'text',
  metadata?: AppendMessageMetadata,
  attachments?: string[]
): Message {
  ensureAgentDir(agentId)
  const now = Date.now()
  const msgId = randomUUID()
  const message: Message = {
    id: msgId,
    role,
    content,
    createdAt: now,
    type: messageType,
    ...(attachments?.length ? { attachments } : {}),
    ...(metadata?.toolCallId ? { toolCallId: metadata.toolCallId } : {}),
    ...(metadata?.toolName ? { toolName: metadata.toolName } : {}),
    ...(metadata?.isError !== undefined ? { isError: metadata.isError } : {}),
    ...(metadata?.expert ? { expert: metadata.expert } : {})
  }

  const entryObj: Record<string, unknown> = {
    type: 'message',
    messageType,
    id: msgId,
    role,
    content,
    createdAt: now
  }
  if (attachments?.length) entryObj.attachments = attachments
  if (metadata?.toolCallId) entryObj.toolCallId = metadata.toolCallId
  if (metadata?.toolName) entryObj.toolName = metadata.toolName
  if (metadata?.isError !== undefined) entryObj.isError = metadata.isError
  if (metadata?.expert) entryObj.expert = metadata.expert

  const file = sessionFile(agentId, sessionId)
  appendFileSync(file, `${JSON.stringify(entryObj)}\n`, 'utf-8')
  if (process.platform !== 'win32') {
    chmodSync(file, 0o600)
  }

  // Update index updatedAt (and title from first user message if still default)
  const index = readIndex(agentId)
  const meta = index.sessions.find((s) => s.id === sessionId)
  if (meta) {
    meta.updatedAt = now
    if (role === 'user' && meta.title === DEFAULT_TITLE && content.trim()) {
      meta.title = content.length > 20 ? content.slice(0, 20) + '…' : content
    }
    writeIndex(agentId, index)
  }

  return message
}

export function listSubagentSessions(agentId: string): SubagentSessionMeta[] {
  return readIndex(agentId).sessions.sort((a, b) => b.createdAt - a.createdAt)
}

export function updateSubagentSessionStatus(
  agentId: string,
  sessionId: string,
  status: SessionStatus
): void {
  const index = readIndex(agentId)
  const meta = index.sessions.find((s) => s.id === sessionId)
  if (meta) {
    meta.status = status
    meta.updatedAt = Date.now()
    writeIndex(agentId, index)
  }
}

/** Look up a sub-agent session by ID across all agents. Used when only the sessionId is known (e.g. from a Message expert ref). */
export function findSubagentSession(
  sessionId: string
): { agentId: string; meta: SubagentSessionMeta } | null {
  if (!existsSync(SESSIONS_ROOT)) return null
  try {
    for (const agentId of getSubdirs(SESSIONS_ROOT)) {
      const index = readIndex(agentId)
      const meta = index.sessions.find((s) => s.id === sessionId)
      if (meta) return { agentId, meta }
    }
  } catch {
    // ignore
  }
  return null
}

function getSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

export function getSubagentSessionHeader(
  agentId: string,
  sessionId: string
): SubagentSessionHeader | null {
  const file = sessionFile(agentId, sessionId)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf-8')
    const firstLine = raw.split('\n')[0]
    if (!firstLine) return null
    const header = JSON.parse(firstLine)
    if (header?.type === 'session') {
      return header as SubagentSessionHeader
    }
  } catch {
    // ignore
  }
  return null
}
