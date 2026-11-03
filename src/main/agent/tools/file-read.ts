// file_read tool — reads user-uploaded files and extracts text content.
// Supports PDF (pdfjs-dist), DOCX (mammoth), XLSX (exceljs), and plain-text/code files.
// Images are handled by the vision tool — file_read returns a redirect hint.
//
// Security: all reads are scoped to ~/.lucid/workspace/ (same as the read tool).

import { resolve, relative, join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { WORKSPACE_DIR } from '../../skills'
import { isWorkspaceGuardEnabled } from '../workspace-guard'
import type { ToolDef, ToolExecContext } from '../tool-def'

const MAX_READ_CHARS = 50_000

// Extensions readable directly as UTF-8 text
const TEXT_EXTS = new Set([
  'txt',
  'md',
  'json',
  'csv',
  'log',
  'ts',
  'js',
  'tsx',
  'jsx',
  'py',
  'go',
  'rs',
  'java',
  'html',
  'css',
  'xml',
  'yml',
  'yaml',
  'sh',
  'sql'
])

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

// Unsupported in this phase — return a clear actionable error
const UNSUPPORTED_EXTS = new Set([
  'ppt',
  'pptx', // PPT parsing deferred — not supported yet
  'doc',
  'xls', // Legacy Office binary formats — user should re-save as docx/xlsx
  'mp3',
  'mp4',
  'wav',
  'avi',
  'mov',
  'mkv',
  'flv',
  'zip',
  'rar',
  '7z',
  'tar',
  'gz'
])

const TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'file_read',
    description:
      '读取用户上传的文件内容并提取文本。支持 PDF、DOCX、XLSX 和纯文本/代码文件。\n' +
      '当用户消息提到"已附带文件"时，调用此工具获取文件内容，再结合用户任务进行综合分析和决策。\n' +
      '图片请用 vision 工具，不要用此工具读取图片。',
    parameters: {
      type: 'object',
      properties: {
        purpose: {
          type: 'string',
          description: '读取此文件的目的（如「提取合同条款」「分析数据趋势」「查看配置」），必填'
        },
        file_path: {
          type: 'string',
          description: '文件的完整路径（用户消息中列出的路径）'
        },
        max_chars: {
          type: 'number',
          description: '可选，限制返回的最大字符数，默认 50000。大文件超出部分会被截断。'
        }
      },
      required: ['purpose', 'file_path']
    }
  }
}

function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

// Extract text from a PDF using pdfjs-dist (legacy build, no worker in Node).
async function extractPdf(
  filePath: string,
  maxChars: number
): Promise<{ content: string; pages: number; truncated: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(readFileSync(filePath))
  // Node environment — no worker needed; pdfjs falls back to fake worker.
  const loadingTask = pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false })
  const doc = await loadingTask.promise
  let content = ''
  let truncated = false
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const textContent = await page.getTextContent()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = textContent.items.map((it: any) => it.str).join(' ')
    content += `--- 第 ${i} 页 ---\n${text}\n\n`
    if (content.length >= maxChars) {
      content = content.slice(0, maxChars)
      truncated = true
      break
    }
  }
  return { content, pages: doc.numPages, truncated }
}

// Extract text from a DOCX using mammoth.
async function extractDocx(
  filePath: string,
  maxChars: number
): Promise<{ content: string; truncated: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mammoth: any = await import('mammoth')
  const result = await mammoth.extractRawText({ path: filePath })
  return {
    content: result.value.slice(0, maxChars),
    truncated: result.value.length > maxChars
  }
}

// Extract text from an XLSX using exceljs — each sheet becomes a Markdown-ish table.
async function extractXlsx(
  filePath: string,
  maxChars: number
): Promise<{ content: string; sheets: number; truncated: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExcelJS: any = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  let content = ''
  let truncated = false
  for (const ws of wb.worksheets) {
    content += `--- Sheet: ${ws.name} ---\n`
    ws.eachRow({ includeEmpty: false }, (row: { values: (string | number | null)[] }) => {
      const vals = (row.values as (string | number | null)[])
        .slice(1) // values[0] is always null in exceljs
        .map((v) => (v === null || v === undefined ? '' : String(v)))
        .join(' | ')
      content += vals + '\n'
      if (content.length >= maxChars) {
        content = content.slice(0, maxChars)
        truncated = true
      }
    })
    content += '\n'
    if (truncated) break
  }
  return { content, sheets: wb.worksheetCount, truncated }
}

function extractText(filePath: string, maxChars: number): { content: string; truncated: boolean } {
  const buf = readFileSync(filePath, 'utf-8')
  return {
    content: buf.slice(0, maxChars),
    truncated: buf.length > maxChars
  }
}

async function execute(argsStr: string, _ctx: ToolExecContext): Promise<string> {
  let args: { purpose?: unknown; file_path?: unknown; max_chars?: unknown }
  try {
    args = JSON.parse(argsStr)
  } catch {
    return JSON.stringify({ error: 'Invalid JSON arguments' })
  }

  const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : ''
  if (!purpose) {
    return JSON.stringify({ error: 'purpose is required' })
  }

  const rawPath = typeof args.file_path === 'string' ? args.file_path.trim() : ''
  if (!rawPath) {
    return JSON.stringify({ error: 'file_path is required' })
  }

  const maxChars =
    typeof args.max_chars === 'number' && args.max_chars > 0
      ? Math.floor(args.max_chars)
      : MAX_READ_CHARS

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

  let st: ReturnType<typeof statSync>
  try {
    st = statSync(fullPath)
    if (!st.isFile()) {
      return JSON.stringify({ error: `Not a file: ${rawPath}` })
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `Failed to stat file: ${msg}` })
  }

  const ext = fullPath.split('.').pop()?.toLowerCase() ?? ''

  try {
    // Image → redirect to vision tool
    if (IMAGE_EXTS.has(ext)) {
      return JSON.stringify({
        error: '图片文件请使用 vision 工具分析，file_read 仅处理文档和文本文件。',
        hint: '调用 vision 工具，参数 file_path 指向同一文件路径。'
      })
    }

    // Unsupported formats
    if (UNSUPPORTED_EXTS.has(ext)) {
      const reason =
        ext === 'ppt' || ext === 'pptx'
          ? 'PPT 格式暂不支持文本提取，请让用户转为 PDF 后重新上传'
          : ext === 'doc' || ext === 'xls'
            ? '老版 Office 二进制格式不支持，请让用户另存为 .docx/.xlsx 后重新上传'
            : '音视频或压缩包格式不支持文本提取'
      return JSON.stringify({ error: `不支持的文件格式: .${ext}`, reason })
    }

    // Text/code files — direct UTF-8 read
    if (TEXT_EXTS.has(ext)) {
      const { content, truncated } = extractText(fullPath, maxChars)
      return JSON.stringify({ purpose, path: rawPath, format: ext, content, truncated })
    }

    // PDF
    if (ext === 'pdf') {
      const { content, pages, truncated } = await extractPdf(fullPath, maxChars)
      return JSON.stringify({ purpose, path: rawPath, format: 'pdf', pages, content, truncated })
    }

    // DOCX
    if (ext === 'docx') {
      const { content, truncated } = await extractDocx(fullPath, maxChars)
      return JSON.stringify({ purpose, path: rawPath, format: 'docx', content, truncated })
    }

    // XLSX
    if (ext === 'xlsx') {
      const { content, sheets, truncated } = await extractXlsx(fullPath, maxChars)
      return JSON.stringify({ purpose, path: rawPath, format: 'xlsx', sheets, content, truncated })
    }

    // Unknown extension — try UTF-8 read as fallback
    const { content, truncated } = extractText(fullPath, maxChars)
    return JSON.stringify({
      purpose,
      path: rawPath,
      format: ext || 'unknown',
      content,
      truncated,
      note: '未知格式，按 UTF-8 文本读取'
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return JSON.stringify({ error: `Failed to read file: ${msg}` })
  }
}

export const fileReadTool: ToolDef = {
  name: 'file_read',
  openai: TOOL_DEF,
  execute
}
