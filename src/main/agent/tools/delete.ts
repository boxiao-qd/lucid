// delete tool — deletes files or directories under ~/.lucid/workspace/.
// Files are removed directly; directories are removed recursively.
//
// Security: all deletes are scoped to ~/.lucid/workspace/. Paths
// outside this directory are rejected with an error returned to the LLM.

import { resolve, relative, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, statSync, rmSync } from 'node:fs'
import { WORKSPACE_DIR } from '../../skills'
import { isWorkspaceGuardEnabled } from '../workspace-guard'
import type { ToolDef, ToolExecContext } from '../tool-def'

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'delete',
    description:
      '删除文件或目录。如果是目录则递归删除。\n' +
      '路径可以是 ~/ 开头的绝对路径或普通绝对路径。\n' +
      '安全限制：只能删除 ~/.lucid/workspace/ 目录内的文件和目录。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要删除的文件或目录路径，如 ~/.lucid/workspace/artifact/session1/old.md'
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

  // Security: only allow deleting within ~/.lucid/workspace/.
  // Safe mode (or unrestricted with the secondary toggle off) always enforces
  // this check; unrestricted + explicit user opt-out skips it.
  if (isWorkspaceGuardEnabled()) {
    const rel = relative(WORKSPACE_DIR, fullPath)
    if (rel.startsWith('..')) {
      return JSON.stringify({
        error:
          `Access denied: path outside workspace directory: ${rawPath}. ` +
          `本智能体只能操作 ~/.lucid/workspace/ 目录下的文件，` +
          `请让用户将文件放置在 ~/.lucid/workspace/ 目录下。`
      })
    }
  }

  if (!existsSync(fullPath)) {
    return JSON.stringify({ error: `File not found: ${rawPath}` })
  }

  try {
    const st = statSync(fullPath)
    const isDir = st.isDirectory()
    rmSync(fullPath, { recursive: isDir, force: true })
    return JSON.stringify({
      success: true,
      path: rawPath,
      type: isDir ? 'directory' : 'file'
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `Failed to delete: ${msg}` })
  }
}

export const deleteTool: ToolDef = {
  name: 'delete',
  openai: TOOL_DEF,
  execute
}
