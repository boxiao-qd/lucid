// Expert management — stores user-created experts as EXPERT.md files
// (YAML frontmatter + markdown body) under
// ~/.lucid/workspace/experts/{slug}/EXPERT.md
//
// Experts are always user-created (no SkillHub integration).

import { join } from 'node:path'
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
import type { Expert } from '../shared/types'

const LUCID_DIR = join(homedir(), '.lucid')
const WORKSPACE_DIR = join(LUCID_DIR, 'workspace')
const EXPERTS_DIR = join(WORKSPACE_DIR, 'experts')

// --- Frontmatter parsing (minimal, no third-party deps) ---

interface ParsedExpertMd {
  name: string
  description: string
  emoji?: string
  content: string
}

function parseExpertMd(raw: string): ParsedExpertMd {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { name: '', description: '', content: raw }
  }
  const fmRaw = match[1]
  const body = match[2]
  const fm: Record<string, string> = {}
  for (const line of fmRaw.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const val = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    fm[key] = val
  }
  return {
    name: fm.name ?? fm.name_cn ?? '',
    description: fm.description ?? fm.description_cn ?? '',
    emoji: fm.emoji || undefined,
    content: body
  }
}

function buildExpertMd(data: {
  name: string
  description: string
  emoji?: string
  content: string
}): string {
  const fmLines = [`name: ${data.name}`, `description: ${data.description}`]
  if (data.emoji) fmLines.push(`emoji: ${data.emoji}`)
  return `---\n${fmLines.join('\n')}\n---\n${data.content}`
}

// --- slug generation ---

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  )
}

function ensureUniqueSlug(base: string, existingSlugs: Set<string>): string {
  if (!existingSlugs.has(base)) return base
  let i = 2
  while (existingSlugs.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

// --- Expert CRUD ---

function expertDir(slug: string): string {
  return join(EXPERTS_DIR, slug)
}

function expertFilePath(slug: string): string {
  return join(expertDir(slug), 'EXPERT.md')
}

// Build the prompt-facing path for an expert, with ~ prefix for the home dir
export function expertPromptPath(slug: string): string {
  return `~/.lucid/workspace/experts/${slug}/EXPERT.md`
}

export function listExperts(): Expert[] {
  if (!existsSync(EXPERTS_DIR)) return []
  const experts: Expert[] = []
  for (const slug of readdirSync(EXPERTS_DIR)) {
    const dir = expertDir(slug)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(dir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const filePath = expertFilePath(slug)
    if (!existsSync(filePath)) continue
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = parseExpertMd(raw)
      const fileStat = statSync(filePath)
      experts.push({
        slug,
        name: parsed.name || slug,
        description: parsed.description,
        emoji: parsed.emoji,
        content: parsed.content,
        createdAt: fileStat.birthtimeMs,
        updatedAt: fileStat.mtimeMs
      })
    } catch {
      continue
    }
  }
  experts.sort((a, b) => b.updatedAt - a.updatedAt)
  return experts
}

export function createExpert(data: {
  name: string
  description: string
  emoji?: string
  content: string
}): Expert {
  const existing = new Set(listExperts().map((e) => e.slug))
  const slug = ensureUniqueSlug(slugify(data.name), existing)
  const dir = expertDir(slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(expertFilePath(slug), buildExpertMd(data), 'utf-8')
  const st = statSync(expertFilePath(slug))
  return {
    slug,
    name: data.name,
    description: data.description,
    emoji: data.emoji,
    content: data.content,
    createdAt: st.birthtimeMs,
    updatedAt: st.mtimeMs
  }
}

export function updateExpert(
  slug: string,
  data: Partial<{ name: string; description: string; emoji?: string; content: string }>
): Expert {
  const filePath = expertFilePath(slug)
  if (!existsSync(filePath)) throw new Error(`Expert not found: ${slug}`)
  const raw = readFileSync(filePath, 'utf-8')
  const parsed = parseExpertMd(raw)
  const merged = {
    name: data.name ?? parsed.name,
    description: data.description ?? parsed.description,
    emoji: data.emoji !== undefined ? data.emoji : parsed.emoji,
    content: data.content ?? parsed.content
  }
  writeFileSync(filePath, buildExpertMd(merged), 'utf-8')
  const st = statSync(filePath)
  return {
    slug,
    name: merged.name,
    description: merged.description,
    emoji: merged.emoji,
    content: merged.content,
    createdAt: st.birthtimeMs,
    updatedAt: st.mtimeMs
  }
}

export function deleteExpert(slug: string): void {
  const dir = expertDir(slug)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Load a single expert by slug — used by agent-runner for system prompt injection
export function loadExpertBySlug(slug: string): Expert | null {
  const filePath = expertFilePath(slug)
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = parseExpertMd(raw)
    const st = statSync(filePath)
    return {
      slug,
      name: parsed.name || slug,
      description: parsed.description,
      emoji: parsed.emoji,
      content: parsed.content,
      createdAt: st.birthtimeMs,
      updatedAt: st.mtimeMs
    }
  } catch {
    return null
  }
}
