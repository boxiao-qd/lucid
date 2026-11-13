// MessageBlock — renders a persisted Message by type.
// text: user/assistant bubbles; thinking/plan/tool_call/tool_result: static cards.
// Unlike the real-time agent cards (PlanCard/ThinkingCard/ToolCallCard), these
// are self-contained — no agentStore dependency, purely driven by the Message prop.

import { useState, useEffect, useRef, useCallback } from 'react'
import type { Message } from '../../../shared/types'
import type { PlanStep } from '../../../shared/agent-events'
import { useUIStore } from '../store/uiStore'
import MarkdownRenderer from './MarkdownRenderer'
import pdfIcon from '../assets/file-icons/pdf.svg'
import mdIcon from '../assets/file-icons/MD.svg'
import txtIcon from '../assets/file-icons/txt.svg'
import excelIcon from '../assets/file-icons/excel.svg'
import wordIcon from '../assets/file-icons/word.svg'
import htmlIcon from '../assets/file-icons/html.svg'

// --- Helpers ---

function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2)
  } catch {
    return str
  }
}

const STATUS_ICON: Record<string, string> = {
  pending: '○',
  in_progress: '◉',
  completed: '●'
}

const STATUS_LABEL: Record<string, string> = {
  pending: '待执行',
  in_progress: '执行中',
  completed: '已完成'
}

const TOOL_DISPLAY_NAME: Record<string, string> = {
  web_search: '网络搜索',
  web_fetch: '网页抓取',
  vision: '图片识别',
  save_product: '产物保存',
  save_skill: '保存技能',
  read: '读取文件',
  write: '写入文件',
  delete: '删除文件',
  ls: '查看目录',
  skill_hub_search: '搜索技能',
  skill_hub_install: '安装技能',
  code_execute: '代码执行',
  terminal: '命令执行',
  memory_search: '记忆搜索',
  save_memory: '记忆沉淀',
  schedule_task: '定时任务',
  ask_user: '用户提问',
  get_current_time: '当前时间',
  generate_image: '生成图片',
  edit_image: '图片编辑',
  file_read: '文件读取',
  browser_use: '浏览器操作'
}

const TOOL_ICON: Record<string, string> = {
  web_search: '🔍',
  web_fetch: '🌐',
  vision: '🖼️',
  save_product: '📦',
  save_skill: '⭐',
  read: '📄',
  write: '✏️',
  delete: '🗑️',
  ls: '📁',
  skill_hub_search: '🔎',
  skill_hub_install: '📥',
  code_execute: '⚡',
  terminal: '⌨️',
  memory_search: '🧠',
  save_memory: '💾',
  schedule_task: '⏰',
  ask_user: '❓',
  session_spawn: '🤝',
  get_current_time: '🕐',
  generate_image: '🎨',
  edit_image: '🖌️',
  file_read: '📑',
  browser_use: '🖥️'
}

function getToolIcon(toolName: string): string {
  return TOOL_ICON[toolName] ?? '🔧'
}

/** Render a tool icon in grayscale so it blends with the stone palette. */
function ToolIcon({ name }: { name: string }): React.JSX.Element {
  return (
    <span className="text-sm" style={{ filter: 'grayscale(1)', opacity: 0.5 }}>
      {getToolIcon(name)}
    </span>
  )
}

/** Extract a short subtitle from tool call arguments to show in the card
 * header next to the tool name (e.g. the search query for web_search). */
function getToolCallSubtitle(toolName: string, argsJson: string): string | null {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>
    if (toolName === 'web_search' && typeof args.query === 'string') {
      return args.query
    }
    if (toolName === 'web_fetch' && typeof args.purpose === 'string') {
      return args.purpose
    }
    if (toolName === 'vision') {
      if (typeof args.question === 'string' && args.question) return args.question
      if (typeof args.file_path === 'string') {
        return args.file_path.split(/[\\/]/).pop() || args.file_path
      }
    }
    if (toolName === 'terminal' && typeof args.purpose === 'string') {
      return args.purpose
    }
    if (toolName === 'code_execute' && typeof args.purpose === 'string') {
      return args.purpose
    }
    if (toolName === 'file_read' && typeof args.purpose === 'string' && args.purpose) {
      return args.purpose
    }
    if (toolName === 'browser_use') {
      // purpose first; otherwise summarize the command (navigate → URL,
      // otherwise the method name).
      if (typeof args.purpose === 'string' && args.purpose) {
        const p = args.purpose as string
        return p.length > 40 ? p.slice(0, 40) + '…' : p
      }
      const cmd = args.command as { method?: unknown; url?: unknown } | undefined
      if (cmd && typeof cmd === 'object' && typeof cmd.method === 'string') {
        if (cmd.method === 'navigate' && typeof cmd.url === 'string') return cmd.url
        return cmd.method
      }
    }
    if (toolName === 'read' && typeof args.path === 'string') {
      return args.path.split(/[\\/]/).pop() || args.path
    }
    if (toolName === 'write' && typeof args.path === 'string') {
      return args.path.split(/[\\/]/).pop() || args.path
    }
    if (toolName === 'delete' && typeof args.path === 'string') {
      return args.path.split(/[\\/]/).pop() || args.path
    }
    if (toolName === 'save_product' && typeof args.filename === 'string') {
      return args.filename
    }
    if (toolName === 'generate_image' && typeof args.prompt === 'string' && args.prompt) {
      const p = args.prompt as string
      return p.length > 40 ? p.slice(0, 40) + '…' : p
    }
    if (toolName === 'edit_image' && typeof args.purpose === 'string' && args.purpose) {
      const p = args.purpose as string
      return p.length > 40 ? p.slice(0, 40) + '…' : p
    }
    if (toolName === 'memory_search') {
      if (typeof args.query === 'string' && args.query) {
        const q = args.query as string
        return q.length > 40 ? q.slice(0, 40) + '…' : q
      }
      return '自动重写查询'
    }
    if (toolName === 'save_memory') {
      return '自动抽取'
    }
  } catch {
    /* not valid JSON */
  }
  return null
}

// Resolve tool display name — MCP tools use server__tool naming convention.
function getToolDisplayName(toolName: string): string {
  if (TOOL_DISPLAY_NAME[toolName]) return TOOL_DISPLAY_NAME[toolName]
  if (toolName.includes('__')) {
    const [server, tool] = toolName.split('__')
    return `${server} / ${tool}`
  }
  return toolName
}

// --- Image lightbox (full-screen preview) ---

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <img
        src={src}
        alt="预览"
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        onClick={onClose}
        className="absolute right-6 top-6 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white transition-colors hover:bg-white/30"
        aria-label="关闭预览"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  )
}

// --- Text/Markdown preview modal ---

function TextPreviewModal({
  title,
  content,
  loading,
  isMarkdown,
  onClose
}: {
  title: string
  content: string
  loading: boolean
  isMarkdown: boolean
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-[min(800px,90vw)] flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="truncate text-sm font-medium text-stone-700">{title}</span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
            aria-label="关闭"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="py-8 text-center text-sm text-stone-400">加载中…</div>
          ) : isMarkdown ? (
            <MarkdownRenderer content={content} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-stone-700">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}

// --- PDF preview modal ---

function PdfPreviewModal({
  src,
  title,
  loading,
  onClose
}: {
  src: string | null
  title: string
  loading: boolean
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] max-w-[90vw] flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="truncate text-sm font-medium text-stone-700">{title}</span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
            aria-label="关闭"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="flex items-center justify-center">
          {loading ? (
            <div className="py-8 text-center text-sm text-stone-400">加载中…</div>
          ) : src ? (
            <iframe src={src} title={title} className="h-[80vh] w-[min(800px,80vw)]" />
          ) : (
            <div className="py-8 text-center text-sm text-stone-400">读取失败</div>
          )}
        </div>
      </div>
    </div>
  )
}

// --- HTML preview modal ---
// Uses a blob URL so the iframe is its own origin (does not inherit parent CSP),
// which lets sandboxed content load external https resources. sandbox="allow-scripts"
// (without allow-same-origin) keeps the iframe from touching parent-window state.

function HtmlPreviewModal({
  title,
  content,
  loading,
  onClose
}: {
  title: string
  content: string
  loading: boolean
  onClose: () => void
}): React.JSX.Element {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  useEffect(() => {
    if (loading || !content) {
      setBlobUrl(null)
      return
    }
    const blob = new Blob([content], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    setBlobUrl(url)
    return (): void => {
      URL.revokeObjectURL(url)
      setBlobUrl(null)
    }
  }, [content, loading])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] max-w-[90vw] flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <span className="truncate text-sm font-medium text-stone-700">{title}</span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
            aria-label="关闭"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="flex items-center justify-center">
          {loading ? (
            <div className="py-8 text-center text-sm text-stone-400">加载中…</div>
          ) : blobUrl ? (
            <iframe
              src={blobUrl}
              title={title}
              sandbox="allow-scripts"
              className="h-[80vh] w-[min(900px,85vw)] rounded-b-lg bg-white"
            />
          ) : (
            <div className="py-8 text-center text-sm text-stone-400">读取失败</div>
          )}
        </div>
      </div>
    </div>
  )
}

// --- Attachment rendering ---
// All attachments (images included) render as a "type badge + filename" card.
// Images remain click-to-preview; other types are static.

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

function getFileBadge(filePath: string): { label: string; color: string } {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext))
    return { label: 'IMG', color: 'bg-cyan-500' }
  if (ext === 'pdf') return { label: 'PDF', color: 'bg-red-500' }
  if (ext === 'docx' || ext === 'doc') return { label: 'DOC', color: 'bg-blue-500' }
  if (ext === 'xlsx' || ext === 'xls') return { label: 'XLS', color: 'bg-green-600' }
  if (
    [
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
    ].includes(ext)
  )
    return { label: 'TXT', color: 'bg-stone-500' }
  return { label: 'FILE', color: 'bg-stone-400' }
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

// Text-based extensions that can be previewed inline.
const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'json',
  'log',
  'ts',
  'js',
  'tsx',
  'jsx',
  'py',
  'go',
  'rs',
  'java',
  'css',
  'xml',
  'yml',
  'yaml',
  'sh',
  'sql'
])
const HTML_EXTS = new Set(['html', 'htm'])
const MD_EXTS = new Set(['md', 'markdown'])

// Extension → SVG icon mapping. Types without an entry fall back to color badges.
const ICON_EXTS: Record<string, string> = {
  pdf: pdfIcon,
  md: mdIcon,
  xlsx: excelIcon,
  xls: excelIcon,
  docx: wordIcon,
  doc: wordIcon,
  txt: txtIcon,
  csv: txtIcon,
  json: txtIcon,
  log: txtIcon,
  ts: txtIcon,
  js: txtIcon,
  tsx: txtIcon,
  jsx: txtIcon,
  py: txtIcon,
  go: txtIcon,
  rs: txtIcon,
  java: txtIcon,
  html: htmlIcon,
  htm: htmlIcon,
  css: txtIcon,
  xml: txtIcon,
  yml: txtIcon,
  yaml: txtIcon,
  sh: txtIcon,
  sql: txtIcon
}

function MessageAttachment({
  filePath,
  onPreview
}: {
  filePath: string
  onPreview: (src: string) => void
}): React.JSX.Element {
  const badge = getFileBadge(filePath)
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const isImage = IMAGE_EXTS.has(ext)
  const iconUrl = ICON_EXTS[ext] ?? null
  const [thumbSrc, setThumbSrc] = useState<string | null>(null)

  useEffect(() => {
    if (!isImage) return
    let cancelled = false
    window.api.uploads
      .readAsDataUrl(filePath)
      .then((url) => {
        if (!cancelled) setThumbSrc(url)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [filePath, isImage])

  return (
    <div
      onClick={isImage && thumbSrc ? () => onPreview(thumbSrc) : undefined}
      className={`flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-2 py-1.5 ${
        isImage && thumbSrc ? 'cursor-pointer transition-colors hover:bg-stone-100' : ''
      }`}
    >
      {isImage ? (
        thumbSrc ? (
          <img
            src={thumbSrc}
            alt={fileNameFromPath(filePath)}
            className="h-12 w-12 shrink-0 rounded object-cover"
          />
        ) : (
          <div className="h-12 w-12 shrink-0 animate-pulse rounded bg-stone-200" />
        )
      ) : iconUrl ? (
        <img src={iconUrl} className="h-8 w-8 shrink-0" alt={badge.label} />
      ) : (
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white ${badge.color}`}
        >
          {badge.label}
        </span>
      )}
      <span className="max-w-[200px] truncate text-sm text-stone-700">
        {fileNameFromPath(filePath)}
      </span>
    </div>
  )
}

// --- Action buttons (for product file blocks) ---

function PreviewButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
      title="预览"
      aria-label="预览"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
  )
}

function OpenFolderButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
      title="打开所在目录"
      aria-label="打开所在目录"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    </button>
  )
}

// --- Product file block (for assistant messages) ---

function isPreviewable(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTS.has(ext) || TEXT_EXTS.has(ext) || HTML_EXTS.has(ext) || ext === 'pdf'
}

function ProductFileBlock({
  filePath,
  onPreview,
  onOpenFolder
}: {
  filePath: string
  onPreview: (filePath: string) => void
  onOpenFolder: (filePath: string) => void
}): React.JSX.Element {
  const badge = getFileBadge(filePath)
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const iconUrl = ICON_EXTS[ext] ?? null

  return (
    <div className="flex w-72 items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2">
      {iconUrl ? (
        <img src={iconUrl} className="h-8 w-8 shrink-0" alt={badge.label} />
      ) : (
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white ${badge.color}`}
        >
          {badge.label}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-stone-700">
        {fileNameFromPath(filePath)}
      </span>
      {isPreviewable(filePath) && <PreviewButton onClick={() => onPreview(filePath)} />}
      <OpenFolderButton onClick={() => onOpenFolder(filePath)} />
    </div>
  )
}

function UserMessage({ message }: { message: Message }): React.JSX.Element {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const handleCopy = async (): Promise<void> => {
    if (!message.content) return
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {message.attachments?.length ? (
        <div className="flex flex-wrap justify-end gap-2">
          {message.attachments.map((fp, i) => (
            <MessageAttachment key={i} filePath={fp} onPreview={setPreviewSrc} />
          ))}
        </div>
      ) : null}
      {message.content && (
        <div className="group max-w-[70%]">
          <div className="whitespace-pre-wrap rounded-2xl bg-stone-700 px-4 py-2 text-sm text-white">
            {message.content}
          </div>
          <button
            onClick={handleCopy}
            className="mt-0.5 flex items-center gap-1 self-end rounded px-1.5 py-0.5 text-[10px] text-stone-400 opacity-0 transition-opacity hover:text-stone-600 group-hover:opacity-100"
            title="复制消息"
          >
            {copied ? (
              <>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>已复制</span>
              </>
            ) : (
              <>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>复制</span>
              </>
            )}
          </button>
        </div>
      )}
      {previewSrc && <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />}
    </div>
  )
}

// --- Plan rendering (static, not dependent on agentStore) ---

function StepRow({ step }: { step: PlanStep }): React.JSX.Element {
  const indent = '  '.repeat(Math.max(0, step.level - 1))
  const isCompleted = step.status === 'completed'
  const isInProgress = step.status === 'in_progress'

  const textClass = isCompleted
    ? 'text-stone-400'
    : isInProgress
      ? 'text-stone-900 font-medium'
      : 'text-stone-500'

  const activeForm = isInProgress && step.activeForm ? ` — ${step.activeForm}` : ''

  return (
    <div className={`flex items-start gap-2 py-0.5 text-sm ${textClass}`}>
      <span className="select-none whitespace-pre">{indent}</span>
      {isCompleted ? (
        <span className="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-stone-800 text-[10px] leading-none text-white">
          ✓
        </span>
      ) : (
        <span className="select-none">{STATUS_ICON[step.status]}</span>
      )}
      <span className="flex-1">
        {step.content}
        {!isCompleted && (
          <span className="ml-2 text-xs text-stone-400">{STATUS_LABEL[step.status]}</span>
        )}
        {activeForm && <span className="text-stone-500">{activeForm}</span>}
      </span>
    </div>
  )
}

function ProgressBar({ steps }: { steps: PlanStep[] }): React.JSX.Element {
  const topLevel = steps.filter((s) => s.level === 1)
  if (topLevel.length === 0) return <></>
  const completed = topLevel.filter((s) => s.status === 'completed').length
  const pct = Math.round((completed / topLevel.length) * 100)

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between text-xs text-stone-500">
        <span>进度</span>
        <span>
          {completed}/{topLevel.length} ({pct}%)
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-stone-200">
        <div
          className="h-1.5 rounded-full bg-stone-700 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// --- Collapsible card wrapper ---

function CollapsibleCard({
  header,
  children,
  defaultExpanded = false
}: {
  header: React.ReactNode
  children: React.ReactNode
  defaultExpanded?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)

  // Sync expanded state when defaultExpanded changes — e.g., when a
  // sub-agent finishes running, thinking cards should auto-collapse.
  // User manual toggles between defaultExpanded changes are preserved.
  useEffect(() => {
    setExpanded(defaultExpanded)
  }, [defaultExpanded])

  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-stone-500 hover:bg-stone-100"
      >
        <span className="select-none">{expanded ? '▾' : '▸'}</span>
        {header}
      </button>
      {expanded && <div className="border-t border-stone-200 px-4 py-3">{children}</div>}
    </div>
  )
}

// --- Tool call + result combined card ---

// Generated image display — loads a generated image from disk and renders it
// inline below the tool call header. Used by generate_image tool results.
function GeneratedImage({ resultJson }: { resultJson: string }): React.JSX.Element | null {
  const [src, setSrc] = useState<string | null>(null)

  // Parse file_path + prompt from the tool result JSON
  let filePath: string | null = null
  let altText = '生成的图片'
  try {
    const result = JSON.parse(resultJson) as {
      success?: boolean
      file_path?: string
      prompt?: string
    }
    if (result.success && typeof result.file_path === 'string') {
      filePath = result.file_path
      if (typeof result.prompt === 'string' && result.prompt) altText = result.prompt
    }
  } catch {
    /* not valid JSON */
  }

  const path = filePath
  useEffect(() => {
    if (!path) {
      setSrc(null)
      return
    }
    let cancelled = false
    window.api.uploads
      .readAsDataUrl(path)
      .then((dataUrl) => {
        if (!cancelled) setSrc(dataUrl)
      })
      .catch(() => {
        if (!cancelled) setSrc(null)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  if (!path) return null
  if (!src) {
    return <div className="ml-7 mt-1 h-48 w-48 animate-pulse rounded-lg bg-stone-200" />
  }
  return (
    <div className="ml-7 mt-1">
      <img
        src={src}
        alt={altText}
        className="max-h-[28rem] max-w-sm rounded-lg border border-stone-200 object-contain"
      />
    </div>
  )
}

function ToolCallGroup({
  callMsg,
  resultMsg
}: {
  callMsg: Message
  resultMsg?: Message
}): React.JSX.Element {
  if (callMsg.toolName === 'TodoWrite') return <></>

  const toolName = callMsg.toolName ?? ''
  const isError = resultMsg?.isError ?? false
  const isSessionSpawn = toolName === 'session_spawn'
  const openExecution = useUIStore((s) => s.openExecution)
  const subtitle = getToolCallSubtitle(toolName, callMsg.content)
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="w-full">
      <div
        onClick={() => setExpanded((v) => !v)}
        className="flex cursor-pointer items-center gap-2 rounded py-1 hover:bg-stone-50"
      >
        <ToolIcon name={toolName} />
        <span className="font-mono text-xs font-medium text-stone-700">
          {isSessionSpawn ? '专家委派' : getToolDisplayName(toolName)}
        </span>
        {subtitle && <span className="truncate text-xs text-stone-400">{subtitle}</span>}
        {resultMsg ? (
          isError ? (
            <span className="text-[10px] text-red-500">ERROR</span>
          ) : (
            <span className="text-[10px] text-stone-400">✓</span>
          )
        ) : (
          <span className="text-[10px] text-stone-400">执行中</span>
        )}
        {isSessionSpawn && callMsg.expert && (
          <span
            onClick={(e) => {
              e.stopPropagation()
              openExecution(callMsg.expert!.runId)
            }}
            className="cursor-pointer rounded border border-stone-300 px-1.5 py-0.5 text-[10px] text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
          >
            查看执行详情 →
          </span>
        )}
        <span className="select-none text-xs text-stone-400">{expanded ? '▾' : '▸'}</span>
      </div>
      {(toolName === 'generate_image' || toolName === 'edit_image') && resultMsg && !isError && (
        <GeneratedImage resultJson={resultMsg.content} />
      )}
      {expanded && (
        <div className="space-y-2 py-1 pl-7">
          <div>
            <div className="mb-1 text-[10px] text-stone-400">入参</div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-stone-50 px-3 py-2 font-mono text-xs text-stone-600">
              {formatJson(callMsg.content)}
            </pre>
          </div>
          {resultMsg && (
            <div>
              <div className="mb-1 text-[10px] text-stone-400">出参</div>
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-stone-50 px-3 py-2 font-mono text-xs text-stone-600">
                {formatJson(resultMsg.content)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Group tool_call + tool_result pairs by toolCallId, regardless of position.
// This handles parallel tool calls (call1, call2, result1, result2) and
// interspersed messages (call, thinking, result) that the old
// consecutive-only matching would leave unpaired.
// Within each turn (user message → agent response), plan entries are
// deduplicated (only the last is kept) and thinking messages are merged
// into a single group. Plan is placed at the top of the turn's agent
// response, thinking second, rest in chronological order.
export function groupMessages(messages: Message[]): Message[][] {
  // Index all tool_results by toolCallId for O(1) lookup
  const resultsByCallId = new Map<string, Message>()
  for (const msg of messages) {
    if (msg.type === 'tool_result' && msg.toolCallId) {
      resultsByCallId.set(msg.toolCallId, msg)
    }
  }

  // First pass: group tool_call + tool_result pairs, keep everything else
  const groups: Message[][] = []
  const consumedResultIds = new Set<string>()

  for (const msg of messages) {
    // Skip tool_result messages already paired with their tool_call
    if (msg.type === 'tool_result' && msg.toolCallId && consumedResultIds.has(msg.toolCallId)) {
      continue
    }
    // For tool_call, find its matching result by toolCallId (not position)
    if (msg.type === 'tool_call' && msg.toolCallId) {
      const result = resultsByCallId.get(msg.toolCallId)
      if (result) {
        groups.push([msg, result])
        consumedResultIds.add(msg.toolCallId)
      } else {
        groups.push([msg])
      }
      continue
    }
    groups.push([msg])
  }

  // Split groups into turns. A turn starts at a user text message and
  // includes all following groups until the next user text message.
  const turns: Message[][][] = []
  let currentTurn: Message[][] = []

  for (const g of groups) {
    const msg = g[0]
    if (msg.type === 'text' && msg.role === 'user') {
      if (currentTurn.length > 0) turns.push(currentTurn)
      currentTurn = [g]
    } else {
      currentTurn.push(g)
    }
  }
  if (currentTurn.length > 0) turns.push(currentTurn)

  // Process each turn: deduplicate plan (keep last in this turn), merge
  // thinking within this turn, reorder plan → thinking → rest.
  const result: Message[][] = []
  for (const turn of turns) {
    const isUserTurn = turn[0] && turn[0][0].type === 'text' && turn[0][0].role === 'user'
    const userGroup = isUserTurn ? turn[0] : null
    const agentGroups = isUserTurn ? turn.slice(1) : turn

    // Find last plan within this turn
    let lastPlanIdx = -1
    for (let i = 0; i < agentGroups.length; i++) {
      if (agentGroups[i][0].type === 'plan') lastPlanIdx = i
    }

    // Separate plan, thinking, and rest within this turn
    let planGroup: Message[] | null = null
    const thinkingMessages: Message[] = []
    const restGroups: Message[][] = []

    for (let i = 0; i < agentGroups.length; i++) {
      const g = agentGroups[i]
      if (g[0].type === 'plan') {
        if (i === lastPlanIdx) planGroup = g
        continue // skip non-last plan entries
      }
      if (g[0].type === 'thinking') {
        thinkingMessages.push(...g)
        continue
      }
      restGroups.push(g)
    }

    // Reconstruct: user message, then plan, then thinking, then rest
    if (userGroup) result.push(userGroup)
    if (planGroup) result.push(planGroup)
    if (thinkingMessages.length > 0) result.push(thinkingMessages)
    result.push(...restGroups)
  }

  return result
}

// Render a group of 1+ messages as a single block.
export function MessageGroup({
  messages: group,
  isRunning = false
}: {
  messages: Message[]
  isRunning?: boolean
}): React.JSX.Element {
  if (group.length === 2 && group[0].type === 'tool_call' && group[1].type === 'tool_result') {
    return <ToolCallGroup callMsg={group[0]} resultMsg={group[1]} />
  }
  if (group.length === 1 && group[0].type === 'tool_call') {
    return <ToolCallGroup callMsg={group[0]} />
  }
  // Merged thinking group — expanded during running, collapsed otherwise.
  if (group.length >= 1 && group.every((m) => m.type === 'thinking')) {
    return <ThinkingGroup messages={group} isRunning={isRunning} />
  }
  return <MessageBlock message={group[0]} isRunning={isRunning} />
}

// ThinkingGroup — renders all thinking messages from a session in a single
// card. Expanded by default during running, collapsed otherwise.
// Auto-scrolls to bottom during streaming so the latest content is visible.
function ThinkingGroup({
  messages,
  isRunning = false
}: {
  messages: Message[]
  isRunning?: boolean
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0)
  const combinedContent = messages.map((m) => m.content).join('\n\n---\n\n')

  // Auto-scroll to bottom during streaming so the latest content
  // is always visible within the max-height scroll area.
  useEffect(() => {
    if (isRunning && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [combinedContent, isRunning])

  return (
    <div className="w-full">
      <CollapsibleCard
        defaultExpanded={isRunning}
        header={
          <>
            <span className="text-stone-600">💭 执行思考</span>
            <span className="text-stone-400">
              · {messages.length}次 · {totalChars}字
            </span>
          </>
        }
      >
        <div ref={scrollRef} className="max-h-[4.5rem] overflow-y-auto">
          <MarkdownRenderer
            content={combinedContent}
            className="text-sm leading-relaxed text-stone-500 italic"
          />
        </div>
      </CollapsibleCard>
    </div>
  )
}

function AssistantMessage({ message }: { message: Message }): React.JSX.Element {
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [textPreview, setTextPreview] = useState<{
    title: string
    content: string
    loading: boolean
    isMarkdown: boolean
  } | null>(null)
  const [pdfPreview, setPdfPreview] = useState<{
    src: string | null
    title: string
    loading: boolean
  } | null>(null)
  const [htmlPreview, setHtmlPreview] = useState<{
    title: string
    content: string
    loading: boolean
  } | null>(null)

  const handlePreview = useCallback(async (filePath: string): Promise<void> => {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    const title = fileNameFromPath(filePath)
    if (IMAGE_EXTS.has(ext)) {
      try {
        const dataUrl = await window.api.uploads.readAsDataUrl(filePath)
        setImagePreview(dataUrl)
      } catch {
        /* ignore */
      }
    } else if (ext === 'pdf') {
      setPdfPreview({ src: null, title, loading: true })
      try {
        const dataUrl = await window.api.uploads.readAsDataUrl(filePath)
        setPdfPreview({ src: dataUrl, title, loading: false })
      } catch {
        setPdfPreview({ src: null, title, loading: false })
      }
    } else if (HTML_EXTS.has(ext)) {
      setHtmlPreview({ title, content: '', loading: true })
      try {
        const text = await window.api.files.readText(filePath)
        setHtmlPreview({ title, content: text, loading: false })
      } catch {
        setHtmlPreview({ title, content: '', loading: false })
      }
    } else if (TEXT_EXTS.has(ext)) {
      setTextPreview({ title, content: '', loading: true, isMarkdown: MD_EXTS.has(ext) })
      try {
        const text = await window.api.files.readText(filePath)
        setTextPreview({ title, content: text, loading: false, isMarkdown: MD_EXTS.has(ext) })
      } catch {
        setTextPreview({
          title,
          content: '读取文件失败',
          loading: false,
          isMarkdown: MD_EXTS.has(ext)
        })
      }
    }
  }, [])

  const handleOpenFolder = useCallback(async (filePath: string): Promise<void> => {
    try {
      await window.api.shell.showItemInFolder(filePath)
    } catch {
      /* ignore */
    }
  }, [])

  return (
    <div className="w-full">
      <MarkdownRenderer content={message.content} />
      {message.attachments?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {message.attachments.map((fp, i) => (
            <ProductFileBlock
              key={i}
              filePath={fp}
              onPreview={handlePreview}
              onOpenFolder={handleOpenFolder}
            />
          ))}
        </div>
      ) : null}
      {imagePreview && <ImageLightbox src={imagePreview} onClose={() => setImagePreview(null)} />}
      {textPreview && (
        <TextPreviewModal
          title={textPreview.title}
          content={textPreview.content}
          loading={textPreview.loading}
          isMarkdown={textPreview.isMarkdown}
          onClose={() => setTextPreview(null)}
        />
      )}
      {pdfPreview && (
        <PdfPreviewModal
          src={pdfPreview.src}
          title={pdfPreview.title}
          loading={pdfPreview.loading}
          onClose={() => setPdfPreview(null)}
        />
      )}
      {htmlPreview && (
        <HtmlPreviewModal
          title={htmlPreview.title}
          content={htmlPreview.content}
          loading={htmlPreview.loading}
          onClose={() => setHtmlPreview(null)}
        />
      )}
    </div>
  )
}

// --- Main component ---

function MessageBlock({
  message,
  isRunning = false
}: {
  message: Message
  isRunning?: boolean
}): React.JSX.Element {
  switch (message.type) {
    case 'text':
      if (message.role === 'user') {
        return <UserMessage message={message} />
      }
      return <AssistantMessage message={message} />

    case 'thinking':
      return (
        <div className="w-full">
          <CollapsibleCard
            defaultExpanded={isRunning}
            header={
              <>
                <span className="text-stone-600">💭 执行思考</span>
                <span className="text-stone-400">· {message.content.length}字</span>
              </>
            }
          >
            <div className="max-h-[4.5rem] overflow-y-auto">
              <MarkdownRenderer
                content={message.content}
                className="text-sm leading-relaxed text-stone-500 italic"
              />
            </div>
          </CollapsibleCard>
        </div>
      )

    case 'plan': {
      let steps: PlanStep[] = []
      try {
        steps = JSON.parse(message.content)
      } catch {
        return <></>
      }
      const isDone = steps.filter((s) => s.level === 1).every((s) => s.status === 'completed')

      return (
        <div className="w-full">
          <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-stone-500">
                执行计划
              </span>
              {isDone && (
                <span className="rounded bg-stone-700 px-2 py-0.5 text-xs text-white">DONE</span>
              )}
            </div>
            <ProgressBar steps={steps} />
            <div className="space-y-0.5">
              {steps.map((step, i) => (
                <StepRow key={`${step.id}-${i}`} step={step} />
              ))}
            </div>
          </div>
        </div>
      )
    }

    case 'tool_call': {
      if (message.toolName === 'TodoWrite') return <></>
      const subtitle = getToolCallSubtitle(message.toolName ?? '', message.content)
      const [expanded, setExpanded] = useState(false)
      const toolName = message.toolName ?? ''
      return (
        <div className="w-full">
          <div
            onClick={() => setExpanded((v) => !v)}
            className="flex cursor-pointer items-center gap-2 rounded py-1 hover:bg-stone-50"
          >
            <ToolIcon name={toolName} />
            <span className="font-mono text-xs font-medium text-stone-700">
              {getToolDisplayName(toolName)}
            </span>
            {subtitle && <span className="truncate text-xs text-stone-400">{subtitle}</span>}
            <span className="text-[10px] text-stone-400">执行中</span>
            <span className="select-none text-xs text-stone-400">{expanded ? '▾' : '▸'}</span>
          </div>
          {expanded && (
            <div className="py-1 pl-7">
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-stone-50 px-3 py-2 font-mono text-xs text-stone-600">
                {formatJson(message.content)}
              </pre>
            </div>
          )}
        </div>
      )
    }

    case 'tool_result': {
      if (message.toolName === 'TodoWrite') return <></>
      const [expanded, setExpanded] = useState(false)
      const toolName = message.toolName ?? ''
      return (
        <div className="w-full">
          <div
            onClick={() => setExpanded((v) => !v)}
            className="flex cursor-pointer items-center gap-2 rounded py-1 hover:bg-stone-50"
          >
            <ToolIcon name={toolName} />
            <span className="font-mono text-xs font-medium text-stone-700">
              {getToolDisplayName(toolName)}
            </span>
            {message.isError ? (
              <span className="text-[10px] text-red-500">ERROR</span>
            ) : (
              <span className="text-[10px] text-stone-400">✓</span>
            )}
            <span className="select-none text-xs text-stone-400">{expanded ? '▾' : '▸'}</span>
          </div>
          {expanded && (
            <div className="py-1 pl-7">
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-stone-50 px-3 py-2 font-mono text-xs text-stone-600">
                {formatJson(message.content)}
              </pre>
            </div>
          )}
        </div>
      )
    }

    default:
      return <></>
  }
}

export default MessageBlock
