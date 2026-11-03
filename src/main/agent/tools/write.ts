// write tool — creates or overwrites files under ~/.lucid/workspace/.
// Auto-creates parent directories. Creates or overwrites files with a
// hard workspace boundary check.
//
// Security: all writes are scoped to ~/.lucid/workspace/. Paths
// outside this directory are rejected with an error returned to the LLM.

import { resolve, relative, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { WORKSPACE_DIR } from '../../skills'
import { isWorkspaceGuardEnabled } from '../workspace-guard'
import type { ToolDef, ToolExecContext } from '../tool-def'

const MAX_WRITE_BYTES = 256 * 1024 // 256KB

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'write',
    description:
      '创建或覆盖文件。如果文件已存在则覆盖，不存在则创建。自动创建父目录。\n' +
      '路径可以是 ~/ 开头的绝对路径或普通绝对路径。\n' +
      '安全限制：只能写入 ~/.lucid/workspace/ 目录内的文件。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径，如 ~/.lucid/workspace/artifact/session1/report.md'
        },
        content: {
          type: 'string',
          description: '要写入的完整文件内容'
        }
      },
      required: ['path', 'content']
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
  let args: { path?: unknown; content?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
  const content = typeof args.content === 'string' ? args.content : ''

  if (!rawPath) {
    return JSON.stringify({ error: 'path is required' })
  }
  if (content.length > MAX_WRITE_BYTES) {
    return JSON.stringify({
      error: `Content too large (${content.length} bytes, max ${MAX_WRITE_BYTES})`
    })
  }

  const expanded = expandTilde(rawPath)
  const fullPath = resolve(expanded)

  // Security: only allow writing within ~/.lucid/workspace/.
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

  try {
    // No-op if content is identical
    if (existsSync(fullPath)) {
      const st = statSync(fullPath)
      if (st.isFile()) {
        try {
          const existing = readFileSync(fullPath, 'utf-8')
          if (existing === content) {
            return JSON.stringify({
              success: true,
              path: rawPath,
              message: 'No changes made. The file already has identical content.'
            })
          }
        } catch {
          // ignore read errors, proceed to write
        }
      }
    }

    // Create parent directories
    const dir = dirname(fullPath)
    mkdirSync(dir, { recursive: true })

    // Write the file
    writeFileSync(fullPath, content, 'utf-8')
    return JSON.stringify({ success: true, path: rawPath, size: content.length })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `Failed to write file: ${msg}` })
  }
}

export const writeTool: ToolDef = {
  name: 'write',
  openai: TOOL_DEF,
  execute
}
