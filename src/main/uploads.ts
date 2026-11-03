// Workspace file management — saves/uploads per-session files under
// ~/.lucid/workspace/artifact/{sessionId}/{upload|product}/
//
// Structure:
//   ~/.lucid/workspace/artifact/{sessionId}/upload/{uuid}.{ext}   — user-uploaded images
//   ~/.lucid/workspace/artifact/{sessionId}/product/{filename}    — agent-generated artifacts

import { join, resolve, relative } from 'node:path'
import { homedir } from 'node:os'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { WorkspaceFile, SessionFiles, FileKind } from '../shared/types'
import { listSessions } from './sessions'
import { listTaskRuns } from './subagent/task-runs'

const WORKSPACE_BASE = join(homedir(), '.lucid', 'workspace')
const ARTIFACT_BASE = join(WORKSPACE_BASE, 'artifact')

function sessionDir(sessionId: string): string {
  return join(ARTIFACT_BASE, sessionId)
}

function uploadDir(sessionId: string): string {
  return join(sessionDir(sessionId), 'upload')
}

function productDir(sessionId: string): string {
  return join(sessionDir(sessionId), 'product')
}

// Parse a data URL like "data:image/png;base64,iVBOR..." → { mime, base64 }
// mime may be empty (e.g. "data:;base64,..." when the browser doesn't recognize
// the file type) — callers should fall back to the original filename's extension.
function parseDataUrl(dataUrl: string): { mime: string; base64: string } {
  const match = dataUrl.match(/^data:([^;]*);base64,(.+)$/)
  if (!match) {
    throw new Error('Invalid data URL format')
  }
  return { mime: match[1], base64: match[2] }
}

// Infer file extension from MIME type
function inferExt(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'application/json': 'json',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls',
    'application/msword': 'doc'
  }
  return map[mime] ?? 'bin'
}

// Reverse mapping: extension → MIME
function inferMime(ext: string): string {
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    doc: 'application/msword'
  }
  return map[ext] ?? 'application/octet-stream'
}

// Save a base64 data URL to ~/.lucid/workspace/artifact/{sessionId}/upload/{filename}
// When fileName is provided, uses the original filename (sanitized, with
// extension normalized to match the MIME type). Falls back to UUID.
// Returns the absolute file path.
export function saveUpload(sessionId: string, dataUrl: string, fileName?: string): string {
  const { mime, base64 } = parseDataUrl(dataUrl)
  // Prefer the extension from the original filename — browsers often return
  // application/octet-stream or empty MIME for formats like .md, .csv, etc.
  const nameExt =
    fileName?.lastIndexOf('.') !== undefined && fileName.lastIndexOf('.') > 0
      ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
      : ''
  const ext = nameExt || inferExt(mime)
  const dir = uploadDir(sessionId)
  mkdirSync(dir, { recursive: true })

  let filename: string
  if (fileName) {
    // Sanitize — strip path separators and unsafe chars, keep CJK + CJK punctuation
    const safe = fileName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff\u3000-\u303f\uFF00-\uFFEF]/g, '_')
    // Drop any extension, we normalize it from MIME
    const baseName = safe.replace(/\.[^.]+$/, '') || 'file'
    let candidate = `${baseName}.${ext}`
    let counter = 1
    while (existsSync(join(dir, candidate))) {
      candidate = `${baseName}(${counter}).${ext}`
      counter++
    }
    filename = candidate
  } else {
    filename = `${randomUUID()}.${ext}`
  }

  const filePath = join(dir, filename)
  writeFileSync(filePath, Buffer.from(base64, 'base64'))
  return filePath
}

// Read a file from disk and convert to base64 data URL for LLM image_url.
export function readUploadAsDataUrl(filePath: string): string {
  const buf = readFileSync(filePath)
  const ext = filePath.split('.').pop()?.toLowerCase() ?? 'bin'
  const mime = inferMime(ext)
  return `data:${mime};base64,${buf.toString('base64')}`
}

// Read a text file from disk as a UTF-8 string (for markdown preview, etc.)
export function readFileText(filePath: string): string {
  return readFileSync(filePath, 'utf-8')
}

// Save an agent-generated product (text content) to
// ~/.lucid/workspace/artifact/{sessionId}/product/{runId}/{filename}
// When runId is provided (sub-agent execution), files are isolated per
// expert invocation so multiple invocations in the same session don't
// overwrite each other.
// Returns the absolute file path.
export function saveProduct(
  sessionId: string,
  content: string,
  filename: string,
  runId?: string
): string {
  const baseDir = productDir(sessionId)
  const dir = runId ? join(baseDir, runId) : baseDir
  mkdirSync(dir, { recursive: true })
  // Sanitize filename — strip path separators, keep it simple
  const safeName = filename.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff\u3000-\u303f\uFF00-\uFFEF]/g, '_')
  const filePath = join(dir, safeName)
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

// Save an agent-generated binary product (image, etc.) to
// ~/.lucid/workspace/artifact/{sessionId}/product/{runId}/{filename}
// Same directory/sanitization/runId logic as saveProduct, but writes binary
// data (Buffer) instead of UTF-8 text.
// Returns the absolute file path.
export function saveProductBinary(
  sessionId: string,
  buffer: Buffer,
  filename: string,
  runId?: string
): string {
  const baseDir = productDir(sessionId)
  const dir = runId ? join(baseDir, runId) : baseDir
  mkdirSync(dir, { recursive: true })
  const safeName = filename.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff\u3000-\u303f\uFF00-\uFFEF]/g, '_')
  const filePath = join(dir, safeName)
  writeFileSync(filePath, buffer)
  return filePath
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])
const TEXT_EXTS = new Set([
  'txt',
  'md',
  'json',
  'csv',
  'log',
  'ts',
  'js',
  'py',
  'go',
  'rs',
  'java',
  'html',
  'css',
  'xml',
  'yml',
  'yaml'
])

function fileKind(ext: string): FileKind {
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'other'
}

function scanDir(dir: string): WorkspaceFile[] {
  if (!existsSync(dir)) return []
  const files: WorkspaceFile[] = []
  for (const name of readdirSync(dir)) {
    const filePath = join(dir, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(filePath)
    } catch {
      continue
    }
    const isDir = st.isDirectory()
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    files.push({
      name,
      path: filePath,
      size: st.size,
      mtime: st.mtimeMs,
      kind: isDir ? 'other' : fileKind(ext),
      isDirectory: isDir
    })
  }
  files.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1
    if (!a.isDirectory && b.isDirectory) return 1
    return b.mtime - a.mtime
  })
  return files
}

// Build a runId → task map from the index file (one disk read).
// Used to enrich product directory names (runId UUIDs) with human-readable
// task text for display.
function buildTaskMap(): Map<string, string> {
  const map = new Map<string, string>()
  for (const r of listTaskRuns()) {
    if (r.task) map.set(r.runId, r.task)
  }
  return map
}

// Enrich directory entries whose name matches a runId with the task text
// as displayName. Non-runId directories (e.g. "subagent") and regular
// files are left unchanged.
function enrichWithTaskName(files: WorkspaceFile[], taskMap: Map<string, string>): WorkspaceFile[] {
  return files.map((f) => {
    if (!f.isDirectory) return f
    const task = taskMap.get(f.name)
    if (task) {
      const display = task.length > 40 ? task.slice(0, 40) + '…' : task
      return { ...f, displayName: display }
    }
    return f
  })
}

// List product files for a specific session (used by scheduler to capture
// artifacts produced during a scheduled agent run).
export function listProducts(sessionId: string): WorkspaceFile[] {
  const taskMap = buildTaskMap()
  return enrichWithTaskName(scanDir(productDir(sessionId)), taskMap)
}

// List contents (files + directories) of a sub-path within a session's product dir.
// relativePath is relative to the product directory root (e.g. "" or "subfolder").
// Returns empty array if the resolved path escapes the product directory.
export function listProductSubDir(sessionId: string, relativePath: string): WorkspaceFile[] {
  const base = productDir(sessionId)
  const full = resolve(base, relativePath)
  const rel = relative(base, full)
  if (rel.startsWith('..')) return []
  const taskMap = buildTaskMap()
  return enrichWithTaskName(scanDir(full), taskMap)
}

// List all workspace files across all sessions, grouped by session.
// Each session has uploads (素材) and products (产物), both sorted by
// modification time descending (newest first). Sessions are sorted by
// their updatedAt descending.
export function listWorkspaceFiles(): SessionFiles[] {
  const taskMap = buildTaskMap()
  const sessions = listSessions()
  const result: SessionFiles[] = []
  for (const s of sessions) {
    const uploads = scanDir(uploadDir(s.id))
    const products = enrichWithTaskName(scanDir(productDir(s.id)), taskMap)
    if (uploads.length === 0 && products.length === 0) continue
    result.push({
      sessionId: s.id,
      sessionTitle: s.title,
      uploads,
      products,
      productDir: productDir(s.id)
    })
  }
  result.sort((a, b) => {
    // Sort by the newest file across both dirs
    const aNewest = Math.max(a.uploads[0]?.mtime ?? 0, a.products[0]?.mtime ?? 0)
    const bNewest = Math.max(b.uploads[0]?.mtime ?? 0, b.products[0]?.mtime ?? 0)
    return bNewest - aNewest
  })
  return result
}

// Assert a path resolves inside ~/.lucid/workspace/ — rejects anything escaping
// to prevent arbitrary filesystem access from agent-provided paths.
export function assertWithinWorkspace(filePath: string): void {
  const full = resolve(filePath)
  const rel = relative(WORKSPACE_BASE, full)
  if (rel.startsWith('..') || rel === '') {
    throw new Error(`路径不在 workspace 内，拒绝访问: ${filePath}`)
  }
}

// Delete a file or directory by absolute path. The path must resolve inside
// ~/.lucid/workspace/ — anything escaping is rejected to prevent arbitrary
// filesystem deletion. Directories are removed recursively.
export function deleteFile(filePath: string): void {
  const workspaceRoot = WORKSPACE_BASE
  const full = resolve(filePath)
  const rel = relative(workspaceRoot, full)
  if (rel.startsWith('..') || rel === '') {
    throw new Error(`Refused to delete path outside workspace: ${filePath}`)
  }
  if (!existsSync(full)) return
  rmSync(full, { recursive: true, force: true })
}
