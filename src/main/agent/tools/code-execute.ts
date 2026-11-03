// code_execute tool — executes code in a sandboxed temp file.
//
// Supports python, javascript. Writes code to a temp file under
// ~/.lucid/workspace/.code-exec/, executes with the appropriate interpreter,
// and returns stdout + stderr + exit_code.
//
// Security:
// - write_paths parameter validated against product dir (same as terminal)
// - subprocess/child_process calls in user code are transparently proxied
//   via IPC: guard intercepts them, writes a pending file, prints a marker to
//   stderr; this file detects the marker, shows a confirmation dialog, executes
//   the command via bash + shell-guard.sh, and writes the result back.
// - User confirmation always required before code execution.

import { join, resolve, relative } from 'node:path'
import { homedir } from 'node:os'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  existsSync
} from 'node:fs'
import { spawn } from 'node:child_process'
import { WORKSPACE_DIR } from '../../skills'
import { NODE_GUARD_PATH, GUARD_DIR, SHELL_GUARD_PATH } from '../guard/guard-scripts'
import { requestConfirmation } from '../tool-confirmation'
import { isWorkspaceGuardEnabled } from '../workspace-guard'
import type { ToolDef, ToolExecContext } from '../tool-def'

const CODE_EXEC_DIR = join(WORKSPACE_DIR, '.code-exec')
const IPC_DIR = join(CODE_EXEC_DIR, 'ipc')
const TIMEOUT_MS = 30_000

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'code_execute',
    description:
      '执行代码并返回输出。支持 python、javascript 两种语言。\n' +
      '代码会被写入临时文件并执行，工作目录为 ~/.lucid/workspace/。\n' +
      '写文件操作只能在 product 目录下，需通过 write_paths 声明。\n' +
      '代码中可直接使用 subprocess/child_process 执行 shell 命令，每条命令会弹窗让用户确认。\n' +
      '执行前需要用户确认。30 秒超时。',
    parameters: {
      type: 'object',
      properties: {
        purpose: {
          type: 'string',
          description: '执行此代码的目的（如「生成PPT封面图」「解析JSON数据」），必填'
        },
        language: {
          type: 'string',
          enum: ['python', 'javascript'],
          description: '代码语言：python → python3，javascript → node。'
        },
        code: {
          type: 'string',
          description: '要执行的完整代码'
        },
        write_paths: {
          type: 'array',
          items: { type: 'string' },
          description: '代码将写入的文件路径，必须在 product 目录内。不写文件则不传。'
        }
      },
      required: ['language', 'code', 'purpose']
    }
  }
}

function getInterpreter(language: string): string | null {
  switch (language) {
    case 'python':
      return 'python3'
    case 'javascript':
      return 'node'
    default:
      return null
  }
}

function getFileExtension(language: string): string {
  switch (language) {
    case 'python':
      return '.py'
    case 'javascript':
      return '.js'
    default:
      return '.txt'
  }
}

// Expand ~ prefix to home directory
function expandPath(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

type PathResult = { ok: true } | { ok: false; error: string; path: string; suggestion: string }

// Validate write paths: must be inside product dir (same logic as terminal.ts).
// Safe mode (or unrestricted with the secondary toggle off) always enforces
// this; unrestricted + explicit user opt-out short-circuits to ok.
function validateWritePaths(writePaths: string[], productDir: string): PathResult {
  if (!isWorkspaceGuardEnabled()) return { ok: true }
  for (const rawPath of writePaths) {
    const expanded = expandPath(rawPath)
    const fullPath = resolve(expanded)
    const rel = relative(productDir, fullPath)
    if (rel.startsWith('..')) {
      return {
        ok: false,
        error: `写入路径 ${rawPath} 不在产物输出目录内`,
        path: rawPath,
        suggestion: `请改用 ${productDir}/ 目录`
      }
    }
  }
  return { ok: true }
}

async function execute(argsStr: string, ctx: ToolExecContext): Promise<string> {
  let args: { purpose?: unknown; language?: unknown; code?: unknown; write_paths?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : ''
  const language = typeof args.language === 'string' ? args.language : ''
  const code = typeof args.code === 'string' ? args.code : ''

  if (!purpose) {
    return JSON.stringify({ error: 'purpose is required' })
  }
  if (!language) {
    return JSON.stringify({ error: 'language is required' })
  }
  if (!code) {
    return JSON.stringify({ error: 'code is required' })
  }

  const interpreter = getInterpreter(language)
  if (!interpreter) {
    return JSON.stringify({ error: `Unsupported language: ${language}` })
  }

  // ── Validate write_paths (must be in product dir) ──
  const writePaths = Array.isArray(args.write_paths)
    ? args.write_paths.filter((p): p is string => typeof p === 'string')
    : []
  const productDir = join(
    WORKSPACE_DIR,
    'artifact',
    ctx.parentSessionId ?? ctx.sessionId,
    'product'
  )
  mkdirSync(productDir, { recursive: true })
  const writeResult = validateWritePaths(writePaths, productDir)
  if (!writeResult.ok) {
    return JSON.stringify({
      error: writeResult.error,
      path: writeResult.path,
      suggestion: writeResult.suggestion
    })
  }

  // ── User confirmation — always required, no session-level bypass ──
  const confirm = await requestConfirmation(
    ctx.sessionId,
    'code_execute',
    `语言: ${language}\n\n\`\`\`${language}\n${code}\n\`\`\``,
    ctx.toolCallId,
    ctx.emit,
    ctx.abortSignal,
    undefined,
    undefined,
    !!ctx.parentSessionId,
    purpose
  )
  if (confirm.action === 'reject') {
    return JSON.stringify({
      error: '用户拒绝了执行请求',
      user_message: confirm.text ?? '用户拒绝'
    })
  }

  // ── Execute ──
  try {
    // Ensure .code-exec directory exists
    mkdirSync(CODE_EXEC_DIR, { recursive: true })

    // Write temp file — inject guard per language
    const tempFile = resolve(
      CODE_EXEC_DIR,
      `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${getFileExtension(language)}`
    )

    // Build code content: prepend guard for Python.
    // Node.js guard is loaded via --require flag (no code modification).
    // When the workspace guard is OFF (unrestricted + explicit user opt-out),
    // skip guard injection so the user code can fs.* any path.
    const guardEnabled = isWorkspaceGuardEnabled()
    let fullCode = code
    if (language === 'python' && guardEnabled) {
      fullCode =
        `import sys; sys.path.insert(0, ${JSON.stringify(GUARD_DIR)}); import python_fs_guard\n` +
        code
    }
    writeFileSync(tempFile, fullCode, 'utf-8')

    // Build command + args per language
    let command = interpreter
    let args: string[]
    if (language === 'javascript') {
      command = 'node'
      args = guardEnabled ? ['--require', NODE_GUARD_PATH, tempFile] : [tempFile]
    } else {
      args = [tempFile]
    }

    const env = { ...process.env, LUCID_WORKSPACE_DIR: WORKSPACE_DIR }

    try {
      const result = await runProcess(command, args, TIMEOUT_MS, env, ctx)
      // Detect missing dependencies and add actionable hints
      const depHint = detectMissingDependency(result.output, language)
      return JSON.stringify({
        exit_code: result.exitCode,
        output: result.output,
        language,
        ...depHint
      })
    } finally {
      // Clean up temp file
      if (existsSync(tempFile)) {
        try {
          unlinkSync(tempFile)
        } catch {
          // ignore cleanup errors
        }
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `Failed to execute code: ${msg}` })
  }
}

// Detect missing dependency errors in execution output and return a hint
// that guides the LLM to install the missing package via the terminal tool.
function detectMissingDependency(
  output: string,
  language: string
): { missing_dependency?: string; hint?: string } {
  // Python: ModuleNotFoundError / ImportError
  const pyMatch = output.match(
    /(?:ModuleNotFoundError|ImportError): No module named ['"]([^'"]+)['"]/
  )
  if (pyMatch) {
    const mod = pyMatch[1]
    // pip package name: usually matches module name, but common exceptions
    const pkg = PYTHON_PKG_MAP[mod] ?? mod
    return {
      missing_dependency: mod,
      hint:
        `检测到缺少 Python 库 '${mod}'。` +
        `请使用 terminal 工具执行 \`pip3 install ${pkg}\` 安装（会弹窗让用户确认），然后重试。`
    }
  }

  // JavaScript: Cannot find module
  const jsMatch = output.match(/Cannot find module ['"]([^'"]+)['"]/)
  if (jsMatch && language === 'javascript') {
    const mod = jsMatch[1]
    return {
      missing_dependency: mod,
      hint:
        `检测到缺少 Node.js 模块 '${mod}'。` +
        `请使用 terminal 工具执行 \`npm install ${mod}\` 安装（会弹窗让用户确认），然后重试。`
    }
  }

  return {}
}

// Map Python module names to pip package names (common mismatches)
const PYTHON_PKG_MAP: Record<string, string> = {
  pptx: 'python-pptx',
  PIL: 'Pillow',
  cv2: 'opencv-python',
  yaml: 'pyyaml',
  bs4: 'beautifulsoup4',
  dateutil: 'python-dateutil',
  magic: 'python-magic',
  dotenv: 'python-dotenv',
  jwt: 'PyJWT',
  crypto: 'pycryptodome',
  serial: 'pyserial',
  hid: 'hidapi'
}

// Spawn a process and collect stdout+stderr. Returns combined output.
// Detects __LUCID_CMD__:{id} markers in stderr from the guard's subprocess
// proxy and handles them via IPC (confirmation → execution → result file).
function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  ctx: ToolExecContext
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolvePromise) => {
    // Clean up IPC directory before starting
    mkdirSync(IPC_DIR, { recursive: true })
    try {
      for (const f of readdirSync(IPC_DIR)) {
        unlinkSync(join(IPC_DIR, f))
      }
    } catch {
      // ignore cleanup errors
    }

    const proc = spawn(command, args, {
      cwd: WORKSPACE_DIR,
      timeout: timeoutMs,
      env
    })

    let output = ''
    let stderrBuf = ''

    proc.stdout.on('data', (data: Buffer) => {
      output += data.toString()
    })
    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString()
      output += text
      stderrBuf += text

      // Process complete lines for IPC markers
      const lines = stderrBuf.split('\n')
      stderrBuf = lines.pop() ?? ''
      for (const line of lines) {
        const match = line.match(/^__LUCID_CMD__:(.+)$/)
        if (match) {
          void handleShellIpc(match[1], ctx)
        }
      }
    })

    proc.on('error', (err) => {
      resolvePromise({
        exitCode: -1,
        output: output + `\n[进程错误] ${err.message}`
      })
    })

    proc.on('close', (code) => {
      // Process any remaining stderr buffer for IPC markers
      if (stderrBuf) {
        const match = stderrBuf.match(/^__LUCID_CMD__:(.+)$/)
        if (match) {
          void handleShellIpc(match[1], ctx)
        }
      }
      resolvePromise({ exitCode: code ?? -1, output })
    })
  })
}

// Handle a subprocess IPC request from the guard proxy.
// Reads the pending file → shows confirmation → executes → writes result file.
async function handleShellIpc(cmdId: string, ctx: ToolExecContext): Promise<void> {
  const pendingPath = join(IPC_DIR, `pending-${cmdId}.json`)
  const resultPath = join(IPC_DIR, `result-${cmdId}.json`)

  try {
    const data = JSON.parse(readFileSync(pendingPath, 'utf-8')) as { cmd: string }
    const cmd = data.cmd

    // Request user confirmation
    const confirm = await requestConfirmation(
      ctx.sessionId,
      'shell_execute',
      `\`\`\`bash\n${cmd}\n\`\`\``,
      ctx.toolCallId,
      ctx.emit,
      ctx.abortSignal
    )

    if (confirm.action === 'reject') {
      writeFileSync(resultPath, JSON.stringify({ exit_code: -1, output: '用户拒绝执行' }))
      return
    }

    // Execute via bash + shell-guard.sh
    const result = await runShellWithGuard(cmd, 30_000)
    writeFileSync(resultPath, JSON.stringify(result))
  } catch (err) {
    writeFileSync(
      resultPath,
      JSON.stringify({
        exit_code: -1,
        output: `执行失败: ${err instanceof Error ? err.message : String(err)}`
      })
    )
  }
}

// Execute a shell command with shell-guard.sh sourced (workspace boundary enforced).
function runShellWithGuard(
  command: string,
  timeoutMs: number
): Promise<{ exit_code: number; output: string }> {
  return new Promise((resolve) => {
    const wrapped = `source '${SHELL_GUARD_PATH}' && ${command}`
    const proc = spawn('bash', ['-c', wrapped], {
      cwd: WORKSPACE_DIR,
      env: { ...process.env, LUCID_WORKSPACE_DIR: WORKSPACE_DIR },
      timeout: timeoutMs
    })
    let output = ''
    proc.stdout.on('data', (data: Buffer) => {
      output += data.toString()
    })
    proc.stderr.on('data', (data: Buffer) => {
      output += data.toString()
    })
    proc.on('error', (err) => {
      resolve({
        exit_code: -1,
        output: output + `\n[进程错误] ${err.message}`
      })
    })
    proc.on('close', (code) => {
      resolve({ exit_code: code ?? -1, output })
    })
  })
}

export const codeExecuteTool: ToolDef = {
  name: 'code_execute',
  openai: TOOL_DEF,
  execute
}
