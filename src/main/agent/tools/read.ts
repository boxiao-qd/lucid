// read tool — reads files under ~/.lucid/workspace/.
// The system prompt provides skill locations as ~/prefixed absolute paths;
// the agent uses this tool to load SKILL.md and any reference/script files
// referenced within it.
//
// Security: all reads are scoped to ~/.lucid/workspace/. Paths
// outside this directory are rejected with an error returned to the LLM.

import { resolve, relative, join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { WORKSPACE_DIR } from '../../skills'
import { isWorkspaceGuardEnabled } from '../workspace-guard'
import type { ToolDef, ToolExecContext } from '../tool-def'

const MAX_READ_BYTES = 256 * 1024 // 256KB

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'read',
    description:
      '读取文件内容。支持文本文件。\n' +
      '路径可以是 ~/ 开头的绝对路径或普通绝对路径。\n' +
      '安全限制：只能读取 ~/.lucid/workspace/ 目录内的文件。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径，如 ~/.lucid/workspace/skills/translator/SKILL.md'
        }
      },
      required: ['path']
    }
  }
}

// Expand ~ prefix to the home directory
function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

async function execute(argsStr: string, _ctx: ToolExecContext): Promise<string> {
  let args: { path?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
  if (!rawPath) {
    return JSON.stringify({ error: 'path is required' })
  }

  const expanded = expandTilde(rawPath)
  const fullPath = resolve(expanded)

  // Security: only allow reading within ~/.lucid/workspace/.
  // Safe mode (or unrestricted with the secondary toggle off) always enforces
  // this check; unrestricted + explicit user opt-out skips it.
  if (isWorkspaceGuardEnabled()) {
    const rel = relative(WORKSPACE_DIR, fullPath)
    if (rel.startsWith('..')) {
      return JSON.stringify({
        error: `Access denied: path outside workspace directory: ${rawPath}`
      })
    }
  }

  if (!existsSync(fullPath)) {
    return JSON.stringify({ error: `File not found: ${rawPath}` })
  }

  try {
    const st = statSync(fullPath)
    if (!st.isFile()) {
      return JSON.stringify({ error: `Not a file: ${rawPath}` })
    }
    if (st.size > MAX_READ_BYTES) {
      return JSON.stringify({ error: `File too large (${st.size} bytes, max ${MAX_READ_BYTES})` })
    }
    const content = readFileSync(fullPath, 'utf-8')
    return JSON.stringify({ path: rawPath, content })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `Failed to read file: ${msg}` })
  }
}

export const readTool: ToolDef = {
  name: 'read',
  openai: TOOL_DEF,
  execute
}
