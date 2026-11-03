// Skill management — stores user-created and ClawHub-installed skills as
// SKILL.md files (YAML frontmatter + markdown body) under
// ~/.lucid/workspace/skills/{slug}/SKILL.md
//
// ClawHub integration:
//   Search: GET https://clawhub.ai/api/v1/search?q={query}
//   Card:  GET https://clawhub.ai/api/v1/skills/{slug}/card  (raw SKILL.md)
//
// Bundled skills:
//   5 bundled skills are seeded from resources/skills/ on
//   first run via ensureBundledSkills().

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
import type { Skill, HubSkill } from '../shared/types'

const LUCID_DIR = join(homedir(), '.lucid')
export const WORKSPACE_DIR = join(LUCID_DIR, 'workspace')
export const SKILLS_DIR = join(WORKSPACE_DIR, 'skills')
const BUNDLED_SKILLS_DIR = join(__dirname, '../../resources/skills')

const CLAWHUB_BASE_URL = 'https://clawhub.ai'
const CLAWHUB_TIMEOUT_MS = 30_000
const SKILL_CARD_MAX_BYTES = 256 * 1024

// --- Frontmatter parsing (minimal, no third-party deps) ---

interface ParsedSkillMd {
  name: string
  description: string
  emoji?: string
  content: string
}

function parseSkillMd(raw: string): ParsedSkillMd {
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

function buildSkillMd(data: {
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

// --- Skill CRUD ---

function skillDir(slug: string): string {
  return join(SKILLS_DIR, slug)
}

function skillFilePath(slug: string): string {
  return join(skillDir(slug), 'SKILL.md')
}

// Build the prompt-facing path for a skill, with ~ prefix for the home dir
export function skillPromptPath(slug: string): string {
  return `~/.lucid/workspace/skills/${slug}/SKILL.md`
}

// Determine skill source: 'user' if .user-created marker exists, else 'hub'
function inferSource(slug: string): 'user' | 'hub' {
  return existsSync(join(skillDir(slug), '.user-created')) ? 'user' : 'hub'
}

export function listSkills(): Skill[] {
  if (!existsSync(SKILLS_DIR)) return []
  const skills: Skill[] = []
  for (const slug of readdirSync(SKILLS_DIR)) {
    const dir = skillDir(slug)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(dir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const filePath = skillFilePath(slug)
    if (!existsSync(filePath)) continue
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = parseSkillMd(raw)
      const fileStat = statSync(filePath)
      skills.push({
        slug,
        name: parsed.name || slug,
        description: parsed.description,
        emoji: parsed.emoji,
        content: parsed.content,
        source: inferSource(slug),
        createdAt: fileStat.birthtimeMs,
        updatedAt: fileStat.mtimeMs
      })
    } catch {
      continue
    }
  }
  skills.sort((a, b) => b.updatedAt - a.updatedAt)
  return skills
}

export function createSkill(data: {
  name: string
  description: string
  emoji?: string
  content: string
}): Skill {
  const existing = new Set(listSkills().map((s) => s.slug))
  const slug = ensureUniqueSlug(slugify(data.name), existing)
  const dir = skillDir(slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(skillFilePath(slug), buildSkillMd(data), 'utf-8')
  // Mark as user-created
  writeFileSync(join(dir, '.user-created'), '', 'utf-8')
  const st = statSync(skillFilePath(slug))
  return {
    slug,
    name: data.name,
    description: data.description,
    emoji: data.emoji,
    content: data.content,
    source: 'user',
    createdAt: st.birthtimeMs,
    updatedAt: st.mtimeMs
  }
}

export function updateSkill(
  slug: string,
  data: Partial<{ name: string; description: string; emoji?: string; content: string }>
): Skill {
  const filePath = skillFilePath(slug)
  if (!existsSync(filePath)) throw new Error(`Skill not found: ${slug}`)
  const raw = readFileSync(filePath, 'utf-8')
  const parsed = parseSkillMd(raw)
  const merged = {
    name: data.name ?? parsed.name,
    description: data.description ?? parsed.description,
    emoji: data.emoji !== undefined ? data.emoji : parsed.emoji,
    content: data.content ?? parsed.content
  }
  writeFileSync(filePath, buildSkillMd(merged), 'utf-8')
  const st = statSync(filePath)
  return {
    slug,
    name: merged.name,
    description: merged.description,
    emoji: merged.emoji,
    content: merged.content,
    source: inferSource(slug),
    createdAt: st.birthtimeMs,
    updatedAt: st.mtimeMs
  }
}

export function deleteSkill(slug: string): void {
  const dir = skillDir(slug)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Load a single skill by slug — used by agent-runner for system prompt injection
export function loadSkillBySlug(slug: string): Skill | null {
  const filePath = skillFilePath(slug)
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = parseSkillMd(raw)
    const st = statSync(filePath)
    return {
      slug,
      name: parsed.name || slug,
      description: parsed.description,
      emoji: parsed.emoji,
      content: parsed.content,
      source: inferSource(slug),
      createdAt: st.birthtimeMs,
      updatedAt: st.mtimeMs
    }
  } catch {
    return null
  }
}

// --- Bundled skills — seed 5 bundled skills on first run ---

export function ensureBundledSkills(): void {
  if (!existsSync(BUNDLED_SKILLS_DIR)) return
  mkdirSync(SKILLS_DIR, { recursive: true })
  for (const slug of readdirSync(BUNDLED_SKILLS_DIR)) {
    const bundledPath = join(BUNDLED_SKILLS_DIR, slug, 'SKILL.md')
    if (!existsSync(bundledPath)) continue
    const destDir = skillDir(slug)
    const destPath = skillFilePath(slug)
    if (existsSync(destPath)) continue // don't overwrite existing
    mkdirSync(destDir, { recursive: true })
    writeFileSync(destPath, readFileSync(bundledPath, 'utf-8'), 'utf-8')
  }
}

// --- ClawHub API ---

// Search ClawHub for skills. Returns results without content (content is
// fetched on install via the card endpoint).
export async function hubSearch(query: string): Promise<HubSkill[]> {
  const url = new URL('/api/v1/search', CLAWHUB_BASE_URL)
  url.searchParams.set('q', query.trim())
  if (!query.trim()) {
    // Empty query — return empty results (ClawHub may require a query)
    url.searchParams.set('limit', '50')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CLAWHUB_TIMEOUT_MS)
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    })
    if (!res.ok) {
      throw new Error(`ClawHub search failed (${res.status}): ${res.statusText}`)
    }
    const data = (await res.json()) as {
      results: Array<{
        slug: string
        displayName: string
        summary?: string
        version?: string
        updatedAt?: number
      }>
    }
    return (data.results ?? []).map((r) => ({
      slug: r.slug,
      name: r.displayName,
      description: r.summary ?? '',
      content: undefined
    }))
  } finally {
    clearTimeout(timeout)
  }
}

// Install a skill from ClawHub — fetch the raw SKILL.md content from the
// card endpoint, parse frontmatter, and write to ~/.lucid/workspace/skills/.
export async function hubInstall(slug: string): Promise<Skill> {
  const url = new URL(`/api/v1/skills/${encodeURIComponent(slug)}/card`, CLAWHUB_BASE_URL)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CLAWHUB_TIMEOUT_MS)
  let rawContent: string
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: 'text/markdown, text/plain, */*' }
    })
    if (!res.ok) {
      throw new Error(`ClawHub card fetch failed (${res.status}): ${res.statusText}`)
    }
    // Read the response body as text, capping at SKILL_CARD_MAX_BYTES
    const reader = res.body?.getReader()
    if (!reader) {
      rawContent = await res.text()
    } else {
      const chunks: Uint8Array[] = []
      let totalBytes = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        totalBytes += value.byteLength
        if (totalBytes > SKILL_CARD_MAX_BYTES) {
          throw new Error(`Skill card for ${slug} exceeded ${SKILL_CARD_MAX_BYTES} bytes`)
        }
        chunks.push(value)
      }
      rawContent = new TextDecoder().decode(Buffer.concat(chunks))
    }
  } finally {
    clearTimeout(timeout)
  }

  const parsed = parseSkillMd(rawContent)
  const dir = skillDir(slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(skillFilePath(slug), rawContent, 'utf-8')
  const st = statSync(skillFilePath(slug))
  return {
    slug,
    name: parsed.name || slug,
    description: parsed.description,
    emoji: parsed.emoji,
    content: parsed.content,
    source: 'hub',
    createdAt: st.birthtimeMs,
    updatedAt: st.mtimeMs
  }
}
