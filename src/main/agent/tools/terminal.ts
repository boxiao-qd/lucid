// terminal tool — executes shell commands with structured path validation.
//
// LLM passes: command (full text with operators), commands (array of
// sub-commands for per-command validation), session_id, timeout.
//
// Two-phase execution (strictly separated):
//   Phase 1 — Path validation (automatic, no user interaction):
//     For each sub-command: validate read_paths (workspace) and
//     write_paths (product dir). Any failure → return error, no dialog.
//   Phase 2 — Command confirmation (user interaction):
//     All path validations passed. Collect sub-commands needing
//     confirmation (interpreter calls, non-file operations, redirects).
//     Show ONE dialog with ALL sub-commands. Execute only after approval.
//
// Why two-phase: if path validation and confirmation are interleaved and
// a later sub-command fails path validation, the user's earlier
// confirmation is wasted — the LLM regenerates and the user must confirm
// again. All paths must be validated first.
//
// Platform: process.platform selects shell at runtime.
//   macOS/Linux: bash + shell-guard.sh
//   Windows: PowerShell (guard TODO — relies on path validation + confirmation)

import { spawn } from 'node:child_process'
import { resolve, relative, join } from 'node:path'
import { homedir } from 'node:os'
import { WORKSPACE_DIR } from '../../skills'
import { SHELL_GUARD_PATH } from '../guard/guard-scripts'
import { isWorkspaceGuardEnabled } from '../workspace-guard'
import { requestConfirmation } from '../tool-confirmation'
import type { ToolDef, ToolExecContext } from '../tool-def'
import type { ToolConfirmCommandBlock } from '../../../shared/agent-events'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 60_000

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'terminal',
    description:
      '在工作目录下执行 shell 命令。支持链式命令（&&、||、;、|）。\n\n' +
      '【参数说明】\n' +
      '- purpose: 执行此命令的目的（如「安装项目依赖」「编译 TypeScript」），必填\n' +
      '- command: 完整原始命令文本（含 &&、||、;、| 等操作符），原样不动，用于实际 bash 执行\n' +
      '- commands: 把 command 按操作符拆成独立命令后的数组，每条独立验证。拆分规则见下\n' +
      '- session_id: 当前会话 ID\n' +
      '- timeout: 超时毫秒，默认 30000，最大 60000\n\n' +
      '【commands 数组拆分规则 — 必须严格遵守】\n' +
      '把 command 字符串按 &&、||、;、| 四种操作符切开，每一段就是 commands 数组的一个元素。\n' +
      '切的时候去掉操作符本身，只保留命令文本，两端 trim 空白。\n' +
      '如果 command 不含任何操作符（单条命令），commands 数组只有一个元素。\n\n' +
      '拆分示例 1：\n' +
      '  command: "cd ~/.lucid/workspace/skills/ppt-master && python3 scripts/check.py"\n' +
      '  commands: [\n' +
      '    { command: "cd ~/.lucid/workspace/skills/ppt-master" },\n' +
      '    { command: "python3 scripts/check.py", read_paths: ["~/.lucid/workspace/skills/ppt-master/scripts/check.py"] }\n' +
      '  ]\n\n' +
      '拆分示例 2：\n' +
      '  command: "ls -la | grep foo"\n' +
      '  commands: [\n' +
      '    { command: "ls -la", read_paths: ["."] },\n' +
      '    { command: "grep foo" }\n' +
      '  ]\n\n' +
      '拆分示例 3：\n' +
      '  command: "mkdir -p out && cp src/a.txt out/ && rm src/a.txt"\n' +
      '  commands: [\n' +
      '    { command: "mkdir -p out", write_paths: ["out"] },\n' +
      '    { command: "cp src/a.txt out/", read_paths: ["src/a.txt"], write_paths: ["out/a.txt"] },\n' +
      '    { command: "rm src/a.txt", write_paths: ["src/a.txt"] }\n' +
      '  ]\n\n' +
      '拆分示例 4（单条命令，无操作符）：\n' +
      '  command: "ls -la ~/.lucid/workspace/"\n' +
      '  commands: [\n' +
      '    { command: "ls -la ~/.lucid/workspace/", read_paths: ["~/.lucid/workspace/"] }\n' +
      '  ]\n\n' +
      '【每个 commands 元素的字段】\n' +
      '- command: 单条子命令文本（不含操作符）\n' +
      '- read_paths: 该子命令读取的路径（ls/cat/grep 的目标、cp 的源）。读路径必须在 workspace 内\n' +
      '- write_paths: 该子命令写入/创建/删除的路径（cp/mv 的目标、touch、mkdir、rm）。写路径必须在 product 内\n\n' +
      '【执行规则】\n' +
      '- 先验证所有子命令的读路径和写路径，全过才弹窗\n' +
      '- 读路径在 workspace 外 → 禁止执行，返回错误\n' +
      '- 写路径在 product 外 → 返回错误 + 建议路径\n' +
      '- 任一子命令需要确认（非文件操作/解释器调用/workspace 外重定向）→ 弹窗显示所有子命令\n' +
      '- 所有子命令均为安全文件操作且无解释器 → 自动执行',
    parameters: {
      type: 'object',
      properties: {
        purpose: {
          type: 'string',
          description: '执行此命令的目的（如「安装项目依赖」「编译 TypeScript」），必填'
        },
        command: {
          type: 'string',
          description: '完整的原始命令文本（含 &&、||、;、| 等操作符），原样不动用于 bash 执行'
        },
        commands: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              command: { type: 'string', description: '单条子命令文本（不含操作符）' },
              read_paths: {
                type: 'array',
                items: { type: 'string' },
                description: '该子命令读取的路径'
              },
              write_paths: {
                type: 'array',
                items: { type: 'string' },
                description: '该子命令写入的路径'
              }
            },
            required: ['command']
          },
          description: '按 &&、||、;、| 拆分后的独立命令数组'
        },
        session_id: { type: 'string', description: '当前会话 ID' },
        timeout: { type: 'number', description: '超时毫秒，默认 30000，最大 60000' }
      },
      required: ['command', 'session_id', 'purpose']
    }
  }
}

// Expand ~ prefix to home directory
function expandPath(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

type PathResult = { ok: true } | { ok: false; error: string; path: string; suggestion: string }

// Validate read paths: must be inside WORKSPACE_DIR.
// Safe mode (or unrestricted with the secondary toggle off) always enforces
// this; unrestricted + explicit user opt-out short-circuits to ok.
function validateReadPaths(readPaths: string[]): PathResult {
  if (!isWorkspaceGuardEnabled()) return { ok: true }
  for (const rawPath of readPaths) {
    const expanded = expandPath(rawPath)
    const fullPath = resolve(expanded)
    const rel = relative(WORKSPACE_DIR, fullPath)
    if (rel.startsWith('..')) {
      const baseName =
        fullPath
          .split(/[\\\/]/)
          .filter(Boolean)
          .pop() ?? ''
      const suggestion = baseName
        ? `请改用 ./${baseName} 或 ${WORKSPACE_DIR}/${baseName}`
        : `请改用 ./ 或 ${WORKSPACE_DIR}/`
      return {
        ok: false,
        error: `读取路径 ${rawPath} 在 workspace 外，禁止读取非安全目录`,
        path: rawPath,
        suggestion
      }
    }
  }
  return { ok: true }
}

// Validate write paths: must be inside product dir.
// Safe mode (or unrestricted with the secondary toggle off) always enforces
// this; unrestricted + explicit user opt-out short-circuits to ok.
function validateWritePaths(writePaths: string[], productOutputDir: string): PathResult {
  if (!isWorkspaceGuardEnabled()) return { ok: true }
  for (const rawPath of writePaths) {
    const expanded = expandPath(rawPath)
    const fullPath = resolve(expanded)
    const rel = relative(productOutputDir, fullPath)
    if (rel.startsWith('..')) {
      const suggestion = `请改用 ${productOutputDir}/ 目录`
      return {
        ok: false,
        error: `写入路径 ${rawPath} 不在产物输出目录内`,
        path: rawPath,
        suggestion
      }
    }
  }
  return { ok: true }
}

// Pre-scan command for redirects (> >>) to non-workspace absolute paths.
// If detected, the command should get user confirmation even if read_paths/write_paths are empty.
// Safe mode (or unrestricted with the secondary toggle off) always enforces
// this; unrestricted + explicit user opt-out short-circuits to null (no redirect flag).
function checkRedirects(command: string): string | null {
  if (!isWorkspaceGuardEnabled()) return null
  const pattern = /(^|[\s;&|])>>?\s*((?:\/[^\s|&;)]+)|(?:~\/[^\s|&;)]+)|(?:[A-Za-z]:\\[^\s|&;)]+))/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(command)) !== null) {
    const rawPath = match[2]
    const expanded =
      rawPath.startsWith('~/') || rawPath.startsWith('~\\')
        ? join(homedir(), rawPath.slice(2))
        : rawPath
    const resolved = resolve(expanded)
    const rel = relative(WORKSPACE_DIR, resolved)
    if (rel.startsWith('..')) {
      return rawPath
    }
  }
  return null
}

// Interpreter commands that always require user confirmation regardless of
// whether read_paths/write_paths are provided, because they can execute
// arbitrary code, not just file operations.
const INTERPRETERS = new Set([
  'python',
  'python3',
  'python2',
  'node',
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'ruby',
  'perl',
  'php',
  'bash',
  'sh',
  'zsh',
  'exec',
  'source',
  '.'
])

function isInterpreterCommand(command: string): boolean {
  const firstToken = command.trim().split(/\s+/)[0]
  if (!firstToken) return false
  const baseName = firstToken.split(/[\\/]/).pop() ?? ''
  return INTERPRETERS.has(firstToken) || INTERPRETERS.has(baseName)
}

interface SubCommand {
  command: string
  read_paths?: string[]
  write_paths?: string[]
}

async function execute(argsStr: string, ctx: ToolExecContext): Promise<string> {
  let args: {
    purpose?: unknown
    command?: unknown
    commands?: unknown
    session_id?: unknown
    timeout?: unknown
  }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : ''
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  const sessionId =
    typeof args.session_id === 'string' ? args.session_id : (ctx.parentSessionId ?? ctx.sessionId)
  const timeout =
    typeof args.timeout === 'number' && args.timeout > 0
      ? Math.min(args.timeout, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS

  if (!purpose) {
    return JSON.stringify({ error: 'purpose is required' })
  }
  if (!command) {
    return JSON.stringify({ error: 'command is required' })
  }

  // Parse commands array — if not provided, fall back to single command
  const subCommands: SubCommand[] = Array.isArray(args.commands)
    ? args.commands
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .map((c) => ({
          command: typeof c.command === 'string' ? c.command : '',
          read_paths: Array.isArray(c.read_paths)
            ? c.read_paths.filter((p): p is string => typeof p === 'string')
            : [],
          write_paths: Array.isArray(c.write_paths)
            ? c.write_paths.filter((p): p is string => typeof p === 'string')
            : []
        }))
        .filter((c) => c.command)
    : [{ command, read_paths: [], write_paths: [] }]

  if (subCommands.length === 0) {
    return JSON.stringify({ error: 'commands is empty' })
  }

  const productOutputDir = join(WORKSPACE_DIR, 'artifact', sessionId, 'product')

  // ══════════════════════════════════════════════════════════════
  // Phase 1: Path validation (automatic, no user interaction)
  // Validate ALL sub-commands' read_paths (workspace) and write_paths
  // (product). Any failure → return error immediately, no dialog.
  // Only proceed to Phase 2 if ALL pass.
  // ══════════════════════════════════════════════════════════════
  for (const sub of subCommands) {
    const readResult = validateReadPaths(sub.read_paths ?? [])
    if (!readResult.ok) {
      return JSON.stringify({
        error: readResult.error,
        path: readResult.path,
        suggestion: readResult.suggestion
      })
    }
    const writeResult = validateWritePaths(sub.write_paths ?? [], productOutputDir)
    if (!writeResult.ok) {
      return JSON.stringify({
        error: writeResult.error,
        path: writeResult.path,
        suggestion: writeResult.suggestion
      })
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Phase 2: Command confirmation (user interaction)
  // All path validations passed. Collect sub-commands that need
  // confirmation (interpreter calls, non-file operations, redirects
  // outside workspace). Show ONE dialog with ALL sub-commands.
  // ══════════════════════════════════════════════════════════════
  const commandBlocks: ToolConfirmCommandBlock[] = subCommands.map((sub) => {
    const redirectTarget = checkRedirects(sub.command)
    const isInterpreter = isInterpreterCommand(sub.command)
    const isFileOperation = (sub.read_paths?.length ?? 0) > 0 || (sub.write_paths?.length ?? 0) > 0
    const needsConfirm = !isFileOperation || redirectTarget !== null || isInterpreter

    if (needsConfirm) {
      const reasons: string[] = []
      if (isInterpreter) reasons.push('解释器调用')
      if (!isFileOperation) reasons.push('非文件操作')
      if (redirectTarget) reasons.push('workspace 外重定向')
      return { command: sub.command, reason: reasons.join(' / ') || undefined }
    }
    return { command: sub.command }
  })

  const needsAnyConfirmation = commandBlocks.some((b) => b.reason)

  if (needsAnyConfirmation) {
    const confirm = await requestConfirmation(
      ctx.sessionId,
      'terminal',
      command,
      ctx.toolCallId,
      ctx.emit,
      ctx.abortSignal,
      undefined,
      commandBlocks,
      !!ctx.parentSessionId,
      purpose
    )
    if (confirm.action === 'reject') {
      return JSON.stringify({
        error: '用户拒绝了执行请求',
        user_message: confirm.text ?? '用户拒绝'
      })
    }
  }

  // ── Execute original command ──
  try {
    const result = await runShell(command, timeout)
    return JSON.stringify({
      purpose,
      exit_code: result.exitCode,
      output: result.output,
      command
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `Failed to execute command: ${msg}` })
  }
}

// Spawn a shell process. Platform-dependent:
//   macOS/Linux: bash + shell-guard.sh
//   Windows: PowerShell (guard TODO)
function runShell(
  command: string,
  timeoutMs: number
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolvePromise) => {
    const isWin = process.platform === 'win32'
    const env = { ...process.env, LUCID_WORKSPACE_DIR: WORKSPACE_DIR }

    let proc: ReturnType<typeof spawn>
    if (isWin) {
      // PowerShell — no shell guard yet, relies on path validation + user confirmation
      proc = spawn('powershell.exe', ['-NoProfile', '-Command', command], {
        cwd: WORKSPACE_DIR,
        env,
        timeout: timeoutMs
      })
    } else if (isWorkspaceGuardEnabled()) {
      // bash + shell guard
      const wrappedCommand = `source '${SHELL_GUARD_PATH}' && ${command}`
      proc = spawn('bash', ['-c', wrappedCommand], {
        cwd: WORKSPACE_DIR,
        env,
        timeout: timeoutMs
      })
    } else {
      // Unrestricted mode + workspace guard explicitly disabled — run plain bash
      // without sourcing shell-guard.sh so redirects and file ops can target any path.
      proc = spawn('bash', ['-c', command], {
        cwd: WORKSPACE_DIR,
        env,
        timeout: timeoutMs
      })
    }

    let output = ''
    if (proc.stdout) {
      proc.stdout.on('data', (data: Buffer) => {
        output += data.toString()
      })
    }
    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        output += data.toString()
      })
    }

    proc.on('error', (err) => {
      resolvePromise({
        exitCode: -1,
        output: output + `\n[进程错误] ${err.message}`
      })
    })

    proc.on('close', (code) => {
      resolvePromise({ exitCode: code ?? -1, output })
    })
  })
}

export const terminalTool: ToolDef = {
  name: 'terminal',
  openai: TOOL_DEF,
  execute
}
