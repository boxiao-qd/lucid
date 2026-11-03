import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
  unlinkSync
} from 'node:fs'
import type { SessionMeta, Message, MessageType } from '../shared/types'
import type { MessageExpertRef } from '../shared/subagent-types'

const SESSIONS_DIR = join(homedir(), '.lucid', 'session')
const INDEX_FILE = join(SESSIONS_DIR, 'sessions.json')

const DEFAULT_TITLE = '新任务'

function ensureDir(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true })
  if (process.platform !== 'win32') {
    chmodSync(SESSIONS_DIR, 0o700)
  }
}

function sessionFile(id: string): string {
  return join(SESSIONS_DIR, `${id}.jsonl`)
}

interface IndexShape {
  sessions: SessionMeta[]
}

function readIndex(): IndexShape {
  try {
    if (!existsSync(INDEX_FILE)) return { sessions: [] }
    const raw = readFileSync(INDEX_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<IndexShape>
    return { sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] }
  } catch {
    return { sessions: [] }
  }
}

function writeIndex(index: IndexShape): void {
  ensureDir()
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8')
  if (process.platform !== 'win32') {
    chmodSync(INDEX_FILE, 0o600)
  }
}

export function listSessions(): SessionMeta[] {
  return readIndex().sessions.sort((a, b) => b.createdAt - a.createdAt)
}

export function createSession(): SessionMeta {
  ensureDir()
  const now = Date.now()
  const id = randomUUID()
  const meta: SessionMeta = { id, title: DEFAULT_TITLE, createdAt: now, updatedAt: now }

  // Write JSONL header line
  const header = JSON.stringify({ type: 'session', id, createdAt: now })
  const file = sessionFile(id)
  writeFileSync(file, `${header}\n`, 'utf-8')
  if (process.platform !== 'win32') {
    chmodSync(file, 0o600)
  }

  // Add to index
  const index = readIndex()
  index.sessions.unshift(meta)
  writeIndex(index)

  return meta
}

export function getSessionMessages(id: string): Message[] {
  const file = sessionFile(id)
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
        messages.push({
          id: entry.id,
          role: entry.role as 'user' | 'assistant',
          content: entry.content,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
          type: (entry.messageType as MessageType) || 'text',
          ...((entry.attachments ?? entry.images)?.length
            ? { attachments: (entry.attachments ?? entry.images) as string[] }
            : {}),
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

export function appendSessionMessage(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  messageType: MessageType = 'text',
  metadata?: {
    toolCallId?: string
    toolName?: string
    isError?: boolean
    expert?: MessageExpertRef
  },
  attachments?: string[]
): Message {
  ensureDir()
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

  const entry = JSON.stringify(entryObj)
  const file = sessionFile(id)
  appendFileSync(file, `${entry}\n`, 'utf-8')
  if (process.platform !== 'win32') {
    chmodSync(file, 0o600)
  }

  // Update index: updatedAt, and title from first user message if still default
  const index = readIndex()
  const meta = index.sessions.find((s) => s.id === id)
  if (meta) {
    meta.updatedAt = now
    if (role === 'user' && meta.title === DEFAULT_TITLE && content.trim()) {
      meta.title = content.length > 20 ? content.slice(0, 20) + '…' : content
    }
    writeIndex(index)
  }

  return message
}

export function deleteSession(id: string): void {
  ensureDir()

  // Delete the JSONL file
  const file = sessionFile(id)
  if (existsSync(file)) {
    unlinkSync(file)
  }

  // Remove from index
  const index = readIndex()
  index.sessions = index.sessions.filter((s) => s.id !== id)
  writeIndex(index)
}
