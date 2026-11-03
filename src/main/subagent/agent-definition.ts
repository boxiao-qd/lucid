// Sub-agent (专家) definition management — AGENT.md read/write.
//
// AGENT.md lives at ~/.lucid/subagent/agents/{agentId}/AGENT.md and contains
// YAML frontmatter (metadata) + Markdown body (system prompt). The format
// mirrors super-agent's AGENT.md, with fields tailored for lucid's expert
// module (type, tools, exposed, etc.).
//
// The frontmatter parser here is intentionally minimal — it handles the
// documented fields only. For anything richer, swap in a proper YAML lib.

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
import type { AgentDefinitionFull, AgentToolsConfig, AgentType } from '../../shared/subagent-types'

const LUCID_DIR = join(homedir(), '.lucid')
const SUBAGENT_DIR = join(LUCID_DIR, 'subagent')
const AGENTS_DIR = join(SUBAGENT_DIR, 'agents')

// --- Path helpers ---

export function agentDir(agentId: string): string {
  return join(AGENTS_DIR, agentId)
}

export function agentMdPath(agentId: string): string {
  return join(agentDir(agentId), 'AGENT.md')
}

export function graphYamlPath(agentId: string): string {
  return join(agentDir(agentId), 'graph.yaml')
}

// --- Frontmatter parsing ---

interface RawFrontmatter {
  [key: string]: unknown
}

/**
 * Parse a minimal YAML subset covering the AGENT.md frontmatter:
 * - `key: value` (string/number/boolean)
 * - `key: "quoted value"`
 * - nested `tools:` block with `allow:` / `deny:` inline arrays
 * - inline arrays `["a", "b"]`
 *
 * This is not a general YAML parser — it covers the fields defined in
 * docs/专家模块数据结构设计.md §2.2 only.
 */
function parseFrontmatter(fmRaw: string): RawFrontmatter {
  const result: RawFrontmatter = {}
  const lines = fmRaw.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      i++
      continue
    }
    const idx = line.indexOf(':')
    if (idx === -1) {
      i++
      continue
    }
    const key = line.slice(0, idx).trim()
    const valPart = line.slice(idx + 1).trim()
    // Nested block (e.g. `tools:` with nothing after the colon → parse indented block)
    if (valPart === '') {
      const nested: RawFrontmatter = {}
      let j = i + 1
      while (j < lines.length) {
        const sub = lines[j]
        if (sub.trim() === '') {
          j++
          continue
        }
        // Must be indented deeper than the parent key to be part of the block
        const subIndent = sub.match(/^[ \t]*/)?.[0].length ?? 0
        const parentIndent = line.match(/^[ \t]*/)?.[0].length ?? 0
        if (subIndent <= parentIndent) break
        const subIdx = sub.indexOf(':')
        if (subIdx === -1) {
          j++
          continue
        }
        const subKey = sub.slice(0, subIdx).trim()
        const subVal = sub.slice(subIdx + 1).trim()
        nested[subKey] = parseScalarOrArray(subVal)
        j++
      }
      result[key] = nested
      i = j
      continue
    }
    result[key] = parseScalarOrArray(valPart)
    i++
  }
  return result
}

function parseScalarOrArray(raw: string): unknown {
  const v = raw.trim()
  if (v === '') return ''
  // Inline array: ["a", "b", 3]
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map((s) => {
      const x = s.trim().replace(/^["']|["']$/g, '')
      return convertScalar(x)
    })
  }
  return convertScalar(v.replace(/^["']|["']$/g, ''))
}

function convertScalar(v: string): unknown {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~') return null
  // number?
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    const n = Number(v)
    if (!Number.isNaN(n)) return n
  }
  return v
}

interface ParsedAgentMd {
  frontmatter: RawFrontmatter
  body: string
}

function parseAgentMd(raw: string): ParsedAgentMd {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {}, body: raw }
  }
  return {
    frontmatter: parseFrontmatter(match[1]),
    body: match[2]
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number'
    ? v
    : typeof v === 'string' && /^\d+$/.test(v)
      ? Number(v)
      : undefined
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : typeof v === 'string' ? v === 'true' : undefined
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.map((x) => String(x))
}

function asTools(v: unknown): AgentToolsConfig | undefined {
  if (v == null || typeof v !== 'object') return undefined
  const obj = v as Record<string, unknown>
  const allow = asStringArray(obj.allow)
  const deny = asStringArray(obj.deny)
  if (allow === undefined && deny === undefined) return undefined
  return {
    ...(allow !== undefined ? { allow } : {}),
    ...(deny !== undefined ? { deny } : {})
  }
}

function rawToDefinition(
  fm: RawFrontmatter,
  fileStat: { birthtimeMs: number; mtimeMs: number }
): AgentDefinitionFull | null {
  const agentId = asString(fm.agentId)
  const name = asString(fm.name)
  const type = asString(fm.type) as AgentType | undefined
  if (!agentId || !name || !type) return null
  if (type !== 'single' && type !== 'expert_panel') return null
  return {
    agentId,
    name,
    description: asString(fm.description) ?? '',
    ...(asString(fm.emoji) ? { emoji: asString(fm.emoji)! } : {}),
    type,
    ...(asNumber(fm.maxTurns) !== undefined ? { maxTurns: asNumber(fm.maxTurns) } : {}),
    ...(asTools(fm.tools) ? { tools: asTools(fm.tools)! } : {}),
    ...(asBool(fm.exposed) !== undefined ? { exposed: asBool(fm.exposed) } : {}),
    ...(asString(fm.color) ? { color: asString(fm.color)! } : {}),
    ...(asBool(fm.background) !== undefined ? { background: asBool(fm.background) } : {}),
    createdAt: fileStat.birthtimeMs,
    updatedAt: fileStat.mtimeMs,
    systemPrompt: ''
  }
}

// --- AGENT.md build ---

function quoteIfNeeded(v: string): string {
  // Quote if it contains special chars or spaces
  if (/[:#\[\]{}&*!|>'"%@`,\s]/.test(v)) {
    return `"${v.replace(/"/g, '\\"')}"`
  }
  return v
}

function buildAgentMd(def: AgentDefinitionFull): string {
  const fmLines: string[] = [
    `agentId: ${def.agentId}`,
    `name: ${quoteIfNeeded(def.name)}`,
    `description: ${quoteIfNeeded(def.description)}`,
    `type: ${def.type}`
  ]
  if (def.emoji) fmLines.push(`emoji: ${quoteIfNeeded(def.emoji)}`)
  if (def.maxTurns !== undefined) fmLines.push(`maxTurns: ${def.maxTurns}`)
  if (def.tools) {
    fmLines.push('tools:')
    if (def.tools.allow !== undefined) {
      const items = def.tools.allow.map((t) => quoteIfNeeded(t)).join(', ')
      fmLines.push(`  allow: [${items}]`)
    }
    if (def.tools.deny !== undefined) {
      const items = def.tools.deny.map((t) => quoteIfNeeded(t)).join(', ')
      fmLines.push(`  deny: [${items}]`)
    }
  }
  if (def.exposed !== undefined) fmLines.push(`exposed: ${def.exposed}`)
  if (def.color) fmLines.push(`color: ${quoteIfNeeded(def.color)}`)
  if (def.background !== undefined) fmLines.push(`background: ${def.background}`)
  return `---\n${fmLines.join('\n')}\n---\n${def.systemPrompt}`
}

// --- Public API ---

export function listAgentDefinitions(): AgentDefinitionFull[] {
  if (!existsSync(AGENTS_DIR)) return []
  const result: AgentDefinitionFull[] = []
  for (const name of readdirSync(AGENTS_DIR)) {
    const dir = agentDir(name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(dir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const filePath = agentMdPath(name)
    if (!existsSync(filePath)) continue
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = parseAgentMd(raw)
      const def = rawToDefinition(parsed.frontmatter, {
        birthtimeMs: statSync(filePath).birthtimeMs,
        mtimeMs: statSync(filePath).mtimeMs
      })
      if (def) {
        def.systemPrompt = parsed.body.trim()
        result.push(def)
      }
    } catch {
      continue
    }
  }
  result.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return result
}

export function loadAgentDefinition(agentId: string): AgentDefinitionFull | null {
  const filePath = agentMdPath(agentId)
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = parseAgentMd(raw)
    const st = statSync(filePath)
    const def = rawToDefinition(parsed.frontmatter, {
      birthtimeMs: st.birthtimeMs,
      mtimeMs: st.mtimeMs
    })
    if (!def) return null
    def.systemPrompt = parsed.body.trim()
    return def
  } catch {
    return null
  }
}

/** List only agents with `exposed !== false` — what users can pick in the UI. */
export function listExposedAgents(): AgentDefinitionFull[] {
  return listAgentDefinitions().filter((a) => a.exposed !== false)
}

export function createAgentDefinition(data: {
  agentId: string
  name: string
  description: string
  emoji?: string
  type: AgentType
  maxTurns?: number
  tools?: AgentToolsConfig
  exposed?: boolean
  color?: string
  background?: boolean
  systemPrompt: string
}): AgentDefinitionFull {
  const existing = new Set(listAgentDefinitions().map((a) => a.agentId))
  if (existing.has(data.agentId)) {
    throw new Error(`Agent already exists: ${data.agentId}`)
  }
  if (!/^[a-z][a-z0-9_]*$/.test(data.agentId)) {
    throw new Error(
      `agentId must be lowercase letters, digits, and underscores (got: ${data.agentId})`
    )
  }
  const now = Date.now()
  const def: AgentDefinitionFull = {
    ...data,
    createdAt: now,
    updatedAt: now,
    systemPrompt: data.systemPrompt
  }
  mkdirSync(agentDir(data.agentId), { recursive: true })
  writeFileSync(agentMdPath(data.agentId), buildAgentMd(def), 'utf-8')
  return def
}

export function updateAgentDefinition(
  agentId: string,
  data: Partial<Omit<AgentDefinitionFull, 'agentId' | 'createdAt'>>
): AgentDefinitionFull | null {
  const filePath = agentMdPath(agentId)
  if (!existsSync(filePath)) return null
  const existing = loadAgentDefinition(agentId)
  if (!existing) return null
  const merged: AgentDefinitionFull = {
    ...existing,
    ...data,
    agentId,
    updatedAt: Date.now()
  }
  writeFileSync(filePath, buildAgentMd(merged), 'utf-8')
  return merged
}

export function deleteAgentDefinition(agentId: string): void {
  const dir = agentDir(agentId)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- Bundled agents seeding ---

/**
 * Bundled agents directory — shipped in resources/subagent/agents/ and
 * unpacked from the asar (electron-builder.yml asarUnpack: resources/**).
 * In dev, resolves to <project>/resources/subagent/agents. In production,
 * resolves into the app bundle.
 */
const BUNDLED_AGENTS_DIR = join(__dirname, '../../resources/subagent/agents')

/**
 * Seed bundled expert definitions to ~/.lucid/subagent/agents/ on first run.
 * Existing agents are NOT overwritten — user customizations take priority.
 */
export function seedBundledAgents(): void {
  if (!existsSync(BUNDLED_AGENTS_DIR)) return
  mkdirSync(AGENTS_DIR, { recursive: true })

  for (const agentId of readdirSync(BUNDLED_AGENTS_DIR)) {
    const bundledAgentDir = join(BUNDLED_AGENTS_DIR, agentId)
    if (!statSync(bundledAgentDir).isDirectory()) continue

    const destAgentDir = agentDir(agentId)
    const destMd = agentMdPath(agentId)
    const bundledMd = join(bundledAgentDir, 'AGENT.md')

    // Don't overwrite existing AGENT.md
    if (!existsSync(destMd) && existsSync(bundledMd)) {
      mkdirSync(destAgentDir, { recursive: true })
      writeFileSync(destMd, readFileSync(bundledMd, 'utf-8'), 'utf-8')
    }

    // Copy graph.yaml if present (expert_panel only)
    const bundledGraph = join(bundledAgentDir, 'graph.yaml')
    const destGraph = graphYamlPath(agentId)
    if (!existsSync(destGraph) && existsSync(bundledGraph)) {
      mkdirSync(destAgentDir, { recursive: true })
      writeFileSync(destGraph, readFileSync(bundledGraph, 'utf-8'), 'utf-8')
    }
  }
}
