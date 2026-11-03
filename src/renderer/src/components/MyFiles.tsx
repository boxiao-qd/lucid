// MyFiles — lists all workspace files grouped by session.
// Left panel: session accordion with 素材 (uploads) and 产物 (products).
// Right panel: folder browser for navigating product subdirectories.
// Products can contain subdirectories; clicking a folder opens the right panel.

import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import type { SessionFiles, WorkspaceFile } from '@shared/types'
import MarkdownRenderer from './MarkdownRenderer'
import { useUIStore } from '../store/uiStore'
import pdfIcon from '../assets/file-icons/pdf.svg'
import mdIcon from '../assets/file-icons/MD.svg'
import txtIcon from '../assets/file-icons/txt.svg'
import excelIcon from '../assets/file-icons/excel.svg'
import wordIcon from '../assets/file-icons/word.svg'
import htmlIcon from '../assets/file-icons/html.svg'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

// Extension → SVG icon. Must stay in sync with MessageBlock's ICON_EXTS.
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

function getFileBadge(ext: string): { label: string; color: string } {
  if (ext === 'docx' || ext === 'doc') return { label: 'DOC', color: 'bg-blue-500' }
  return { label: 'FILE', color: 'bg-stone-400' }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function isMarkdown(file: WorkspaceFile): boolean {
  return file.name.toLowerCase().endsWith('.md')
}

function isPdf(file: WorkspaceFile): boolean {
  return file.name.toLowerCase().endsWith('.pdf')
}

function isHtml(file: WorkspaceFile): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return ext === 'html' || ext === 'htm'
}

function isOfficeFile(file: WorkspaceFile): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return ['ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx'].includes(ext)
}

// --- File icon ---

function ImageThumb({ path }: { path: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
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

  if (!src) {
    return <div className="h-16 w-16 animate-pulse rounded-lg bg-stone-200" />
  }
  return (
    <img src={src} alt="" className="h-16 w-16 rounded-lg border border-stone-200 object-cover" />
  )
}

function FileIcon({ file }: { file: WorkspaceFile }): React.JSX.Element {
  if (IMAGE_EXTS.has(file.name.split('.').pop()?.toLowerCase() ?? '')) {
    return <ImageThumb path={file.path} />
  }

  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const iconUrl = ICON_EXTS[ext] ?? null

  if (iconUrl) {
    return (
      <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-stone-200 bg-stone-50">
        <img src={iconUrl} alt={ext} className="h-10 w-10" />
      </div>
    )
  }

  const badge = getFileBadge(ext)
  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-stone-200 bg-stone-50">
      <span
        className={`flex h-10 w-10 items-center justify-center rounded text-[10px] font-bold text-white ${badge.color}`}
      >
        {badge.label}
      </span>
    </div>
  )
}

function FolderIcon(): React.JSX.Element {
  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-amber-200 bg-amber-50">
      <svg className="h-8 w-8 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
        />
      </svg>
    </div>
  )
}

// --- Image lightbox ---

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

// --- Markdown preview modal ---

function MarkdownPreview({
  title,
  content,
  loading,
  renderAsMarkdown,
  onClose
}: {
  title: string
  content: string
  loading: boolean
  renderAsMarkdown: boolean
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
        className="flex max-h-[85vh] w-[min(960px,92vw)] flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
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
          ) : renderAsMarkdown ? (
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

function PdfPreview({
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
        {loading || !src ? (
          <div className="flex h-[60vh] w-[min(800px,80vw)] items-center justify-center">
            <div className="text-sm text-stone-400">加载中…</div>
          </div>
        ) : (
          <iframe src={src} title={title} className="h-[80vh] w-[min(800px,80vw)]" />
        )}
      </div>
    </div>
  )
}

// --- HTML preview modal ---
// Blob URL → iframe is its own origin (does not inherit parent CSP), which lets
// sandboxed content load external https resources. sandbox="allow-scripts" without
// allow-same-origin keeps the iframe from touching parent-window state.

function HtmlPreview({
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
        {loading || !blobUrl ? (
          <div className="flex h-[60vh] w-[min(900px,85vw)] items-center justify-center">
            <div className="text-sm text-stone-400">{loading ? '加载中…' : '读取失败'}</div>
          </div>
        ) : (
          <iframe
            src={blobUrl}
            title={title}
            sandbox="allow-scripts"
            className="h-[80vh] w-[min(900px,85vw)] rounded-b-lg bg-white"
          />
        )}
      </div>
    </div>
  )
}

// --- Eye icon button (for preview) ---

function PreviewButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
      title="预览"
      aria-label="预览"
    >
      <svg
        width="18"
        height="18"
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

// --- Open-in-folder button ---

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
        width="18"
        height="18"
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

// --- Delete button ---

function DeleteButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-red-50 hover:text-red-600"
      title="删除"
      aria-label="删除"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
    </button>
  )
}

// --- File list section ---

function FileSection({
  title,
  files,
  onImagePreview,
  onMdOpen,
  onPdfOpen,
  onHtmlOpen,
  onOpenFolder,
  onDelete,
  onFolderClick,
  highlightPath
}: {
  title: string
  files: WorkspaceFile[]
  onImagePreview: (src: string) => void
  onMdOpen: (file: WorkspaceFile) => void
  onPdfOpen: (file: WorkspaceFile) => void
  onHtmlOpen: (file: WorkspaceFile) => void
  onOpenFolder: (file: WorkspaceFile) => void
  onDelete: (file: WorkspaceFile) => void
  onFolderClick?: (folder: WorkspaceFile) => void
  highlightPath?: string | null
}): React.JSX.Element | null {
  if (files.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-stone-500">
        <span>{title}</span>
        <span className="text-stone-400">({files.length})</span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {files.map((f) => {
          if (f.isDirectory) {
            return (
              <div
                key={f.path}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2 transition-all hover:border-amber-300 hover:bg-amber-50"
                onClick={() => onFolderClick?.(f)}
              >
                <FolderIcon />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-stone-700">
                    {f.displayName ?? f.name}
                  </div>
                  <div className="text-[10px] text-stone-400">{formatTime(f.mtime)}</div>
                </div>
              </div>
            )
          }

          const html = isHtml(f)
          const pdf = isPdf(f)
          const office = isOfficeFile(f)
          const isText = f.kind === 'text'
          const highlighted = !!highlightPath && f.path === highlightPath
          const handleClick =
            f.kind === 'image'
              ? () => onImagePreview(f.path)
              : html
                ? () => onHtmlOpen(f)
                : isText
                  ? () => onMdOpen(f)
                  : pdf
                    ? () => onPdfOpen(f)
                    : office
                      ? () => onOpenFolder(f)
                      : undefined
          return (
            <div
              key={f.path}
              className={`flex items-center gap-3 rounded-lg border bg-white px-3 py-2 transition-all ${
                highlighted ? 'border-blue-400 ring-2 ring-blue-300' : 'border-stone-200'
              } ${handleClick ? 'cursor-pointer' : ''}`}
              onClick={handleClick}
            >
              <FileIcon file={f} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-stone-700">{f.name}</div>
                <div className="text-[10px] text-stone-400">
                  {formatSize(f.size)} · {formatTime(f.mtime)}
                </div>
              </div>
              {handleClick && (isText || pdf || html || office || f.kind === 'image') && (
                <PreviewButton onClick={handleClick} />
              )}
              <OpenFolderButton onClick={() => onOpenFolder(f)} />
              <DeleteButton onClick={() => onDelete(f)} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// --- Folder browser (right panel) ---

function FolderBrowser({
  files,
  loading,
  relativePath,
  pathLabels,
  onNavigate,
  onBack,
  onImagePreview,
  onMdOpen,
  onPdfOpen,
  onHtmlOpen,
  onOpenFolder,
  onDelete
}: {
  files: WorkspaceFile[]
  loading: boolean
  relativePath: string
  pathLabels: Record<string, string>
  onNavigate: (newRelativePath: string, displayLabel?: string) => void
  onBack: () => void
  onImagePreview: (src: string) => void
  onMdOpen: (file: WorkspaceFile) => void
  onPdfOpen: (file: WorkspaceFile) => void
  onHtmlOpen: (file: WorkspaceFile) => void
  onOpenFolder: (file: WorkspaceFile) => void
  onDelete: (file: WorkspaceFile) => void
}): React.JSX.Element {
  const pathSegments = relativePath ? relativePath.split('/') : []

  return (
    <div className="flex h-full flex-col">
      {/* Breadcrumb + back button */}
      <div className="flex items-center gap-2 border-b border-stone-200 px-4 py-2.5">
        {relativePath && (
          <button
            onClick={onBack}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
            title="返回上级"
            aria-label="返回上级"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-xs text-stone-500">
          <button
            onClick={() => onNavigate('')}
            className={`flex-shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-stone-100 ${
              pathSegments.length === 0 ? 'font-medium text-stone-700' : ''
            }`}
          >
            产物根目录
          </button>
          {pathSegments.map((seg, i) => {
            const subPath = pathSegments.slice(0, i + 1).join('/')
            const isLast = i === pathSegments.length - 1
            const label = pathLabels[subPath] ?? seg
            return (
              <Fragment key={subPath}>
                <span className="flex-shrink-0 text-stone-400">/</span>
                <button
                  onClick={() => onNavigate(subPath)}
                  className={`flex-shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-stone-100 ${
                    isLast ? 'font-medium text-stone-700' : ''
                  }`}
                >
                  {label}
                </button>
              </Fragment>
            )
          })}
        </div>
      </div>

      {/* File/folder grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="py-8 text-center text-sm text-stone-400">加载中…</div>
        ) : files.length === 0 ? (
          <div className="py-8 text-center text-sm text-stone-400">空文件夹</div>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {files.map((f) => {
              if (f.isDirectory) {
                return (
                  <div
                    key={f.path}
                    className="flex cursor-pointer items-center gap-3 rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2 transition-all hover:border-amber-300 hover:bg-amber-50"
                    onClick={() =>
                      onNavigate(relativePath ? `${relativePath}/${f.name}` : f.name, f.displayName)
                    }
                  >
                    <FolderIcon />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-stone-700">
                        {f.displayName ?? f.name}
                      </div>
                      <div className="text-[10px] text-stone-400">{formatTime(f.mtime)}</div>
                    </div>
                  </div>
                )
              }

              const html = isHtml(f)
              const pdf = isPdf(f)
              const office = isOfficeFile(f)
              const isText = f.kind === 'text'
              const handleClick =
                f.kind === 'image'
                  ? () => onImagePreview(f.path)
                  : html
                    ? () => onHtmlOpen(f)
                    : isText
                      ? () => onMdOpen(f)
                      : pdf
                        ? () => onPdfOpen(f)
                        : office
                          ? () => onOpenFolder(f)
                          : undefined
              return (
                <div
                  key={f.path}
                  className={`flex items-center gap-3 rounded-lg border bg-white px-3 py-2 transition-all ${
                    handleClick ? 'cursor-pointer' : ''
                  } border-stone-200`}
                  onClick={handleClick}
                >
                  <FileIcon file={f} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-stone-700">{f.name}</div>
                    <div className="text-[10px] text-stone-400">
                      {formatSize(f.size)} · {formatTime(f.mtime)}
                    </div>
                  </div>
                  {handleClick && (isText || pdf || html || office || f.kind === 'image') && (
                    <PreviewButton onClick={handleClick} />
                  )}
                  <OpenFolderButton onClick={() => onOpenFolder(f)} />
                  <DeleteButton onClick={() => onDelete(f)} />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// --- Main component ---

function MyFiles(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionFiles[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [imagePreviewSrc, setImagePreviewSrc] = useState<string | null>(null)
  const [mdPreview, setMdPreview] = useState<{
    file: WorkspaceFile
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
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set())

  // Right panel browser state
  const [browserSessionId, setBrowserSessionId] = useState<string | null>(null)
  const [browserPath, setBrowserPath] = useState<string>('')
  const [browserFiles, setBrowserFiles] = useState<WorkspaceFile[]>([])
  const [browserLoading, setBrowserLoading] = useState(false)
  // Maps cumulative path segments (e.g. runId) to display labels (e.g. task text)
  const [pathLabels, setPathLabels] = useState<Record<string, string>>({})

  const highlightPath = useUIStore((s) => s.fileHighlightPath)
  const setFileHighlight = useUIStore((s) => s.setFileHighlight)
  const highlightRef = useRef<HTMLDivElement>(null)

  const toggleSession = useCallback((id: string): void => {
    setExpandedSessions((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (!window.api?.files?.list) {
        throw new Error('files API not available — preload 未加载，请重启应用')
      }
      const data = await window.api.files.list()
      setSessions(data)
      if (data.length > 0) {
        setExpandedSessions(new Set([data[0].sessionId]))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[MyFiles] Failed to list files:', err)
      setError(msg)
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // When a highlight path is set, expand the containing session and
  // auto-clear the highlight after 5 seconds.
  useEffect(() => {
    if (!highlightPath) return
    const containingSession = sessions.find(
      (s) =>
        s.uploads.some((f) => f.path === highlightPath) ||
        s.products.some((f) => f.path === highlightPath)
    )
    if (containingSession) {
      setExpandedSessions((prev) => new Set([...prev, containingSession.sessionId]))
    }
    const scrollTimer = setTimeout(() => {
      highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 100)
    const clearTimer = setTimeout(() => setFileHighlight(null), 5000)
    return () => {
      clearTimeout(scrollTimer)
      clearTimeout(clearTimer)
    }
  }, [highlightPath, sessions, setFileHighlight])

  const handleMdOpen = useCallback(async (file: WorkspaceFile): Promise<void> => {
    const md = isMarkdown(file)
    setMdPreview({ file, content: '', loading: true, isMarkdown: md })
    try {
      const text = await window.api.files.readText(file.path)
      setMdPreview({ file, content: text, loading: false, isMarkdown: md })
    } catch (err) {
      console.error('[MyFiles] Failed to read file:', err)
      setMdPreview({ file, content: '读取文件失败', loading: false, isMarkdown: md })
    }
  }, [])

  const handleImagePreview = useCallback(async (filePath: string): Promise<void> => {
    try {
      const dataUrl = await window.api.uploads.readAsDataUrl(filePath)
      setImagePreviewSrc(dataUrl)
    } catch (err) {
      console.error('[MyFiles] Failed to read image:', err)
    }
  }, [])

  const handlePdfOpen = useCallback(async (file: WorkspaceFile): Promise<void> => {
    setPdfPreview({ src: null, title: file.name, loading: true })
    try {
      const dataUrl = await window.api.uploads.readAsDataUrl(file.path)
      setPdfPreview({ src: dataUrl, title: file.name, loading: false })
    } catch (err) {
      console.error('[MyFiles] Failed to read PDF:', err)
      setPdfPreview({ src: null, title: file.name, loading: false })
    }
  }, [])

  const handleHtmlOpen = useCallback(async (file: WorkspaceFile): Promise<void> => {
    setHtmlPreview({ title: file.name, content: '', loading: true })
    try {
      const text = await window.api.files.readText(file.path)
      setHtmlPreview({ title: file.name, content: text, loading: false })
    } catch (err) {
      console.error('[MyFiles] Failed to read HTML:', err)
      setHtmlPreview({ title: file.name, content: '', loading: false })
    }
  }, [])

  const handleOpenFolder = useCallback(async (file: WorkspaceFile): Promise<void> => {
    try {
      await window.api.shell.showItemInFolder(file.path)
    } catch (err) {
      console.error('[MyFiles] Failed to open folder:', err)
    }
  }, [])

  // --- Folder browser handlers ---

  const loadBrowserFiles = useCallback(async (sessionId: string, relPath: string) => {
    setBrowserLoading(true)
    try {
      const files = await window.api.files.listDir(sessionId, relPath)
      setBrowserFiles(files)
    } catch (err) {
      console.error('[MyFiles] Failed to list dir:', err)
      setBrowserFiles([])
    } finally {
      setBrowserLoading(false)
    }
  }, [])

  const handleFolderClick = useCallback(
    (sessionId: string, folder: WorkspaceFile): void => {
      const rel = folder.name
      if (folder.displayName) {
        setPathLabels((prev) => ({ ...prev, [rel]: folder.displayName! }))
      }
      setBrowserSessionId(sessionId)
      setBrowserPath(rel)
      void loadBrowserFiles(sessionId, rel)
    },
    [loadBrowserFiles]
  )

  const handleNavigate = useCallback(
    (newPath: string, displayLabel?: string): void => {
      if (!browserSessionId) return
      if (displayLabel) {
        setPathLabels((prev) => ({ ...prev, [newPath]: displayLabel }))
      }
      setBrowserPath(newPath)
      void loadBrowserFiles(browserSessionId, newPath)
    },
    [browserSessionId, loadBrowserFiles]
  )

  const handleBack = useCallback((): void => {
    if (!browserPath) return
    const segments = browserPath.split('/')
    segments.pop()
    const parentPath = segments.join('/')
    handleNavigate(parentPath)
  }, [browserPath, handleNavigate])

  const handleDelete = useCallback(
    async (file: WorkspaceFile): Promise<void> => {
      const label = file.displayName ?? file.name
      if (!window.confirm(`确定删除「${label}」？\n\n该操作不可撤销，文件将从磁盘移除。`)) return
      try {
        await window.api.files.delete(file.path)
        // Refresh both the session list and the browser (if currently viewing
        // the same area) so the UI drops the deleted entry immediately.
        await load()
        if (browserSessionId && browserPath) {
          await loadBrowserFiles(browserSessionId, browserPath)
        }
      } catch (err) {
        console.error('[MyFiles] Failed to delete file:', err)
        window.alert(`删除失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [browserSessionId, browserPath, load, loadBrowserFiles]
  )

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-stone-400">加载中…</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md text-center text-sm text-stone-500">
          <p className="mb-2 font-medium text-stone-700">加载失败</p>
          <p className="text-xs text-stone-400">{error}</p>
          <button
            onClick={() => void load()}
            className="mt-3 rounded-md border border-stone-300 px-3 py-1.5 text-xs text-stone-600 hover:bg-stone-100"
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-stone-400">暂无文件</div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-1 overflow-hidden">
      {/* Left: sessions accordion — 2/3 width */}
      <div
        className="h-full overflow-y-auto border-r border-stone-200"
        style={{ width: '66.66%', flexShrink: 0, minWidth: 0 }}
      >
        <div className="mx-auto max-w-4xl space-y-3 p-6">
          {sessions.map((s) => {
            const expanded = expandedSessions.has(s.sessionId)
            const fileCount = s.uploads.length + s.products.length
            return (
              <div key={s.sessionId} className="space-y-2">
                <button
                  onClick={() => toggleSession(s.sessionId)}
                  className="flex w-full items-center gap-2 rounded-lg bg-stone-100 px-3 py-2.5 text-sm font-medium text-stone-800 transition-colors hover:bg-stone-200"
                >
                  <svg
                    className="h-4 w-4 flex-shrink-0 text-stone-500"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                    />
                  </svg>
                  <span className="flex-1 truncate text-left">{s.sessionTitle}</span>
                  <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-medium text-stone-500">
                    {fileCount}
                  </span>
                  <svg
                    className={`h-4 w-4 flex-shrink-0 text-stone-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </button>
                {expanded && (
                  <>
                    <FileSection
                      title="素材"
                      files={s.uploads}
                      onImagePreview={handleImagePreview}
                      onMdOpen={handleMdOpen}
                      onPdfOpen={handlePdfOpen}
                      onHtmlOpen={handleHtmlOpen}
                      onOpenFolder={handleOpenFolder}
                      onDelete={handleDelete}
                      highlightPath={highlightPath}
                    />
                    <div
                      ref={
                        highlightPath && s.products.some((f) => f.path === highlightPath)
                          ? highlightRef
                          : undefined
                      }
                    >
                      <FileSection
                        title="产物"
                        files={s.products}
                        onImagePreview={handleImagePreview}
                        onMdOpen={handleMdOpen}
                        onPdfOpen={handlePdfOpen}
                        onHtmlOpen={handleHtmlOpen}
                        onOpenFolder={handleOpenFolder}
                        onDelete={handleDelete}
                        onFolderClick={(folder) => handleFolderClick(s.sessionId, folder)}
                        highlightPath={highlightPath}
                      />
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Right: folder browser */}
      <div
        className="h-full overflow-hidden"
        style={{ width: '33.33%', flexShrink: 0, minWidth: 0 }}
      >
        {browserSessionId ? (
          <FolderBrowser
            files={browserFiles}
            loading={browserLoading}
            relativePath={browserPath}
            pathLabels={pathLabels}
            onNavigate={handleNavigate}
            onBack={handleBack}
            onImagePreview={handleImagePreview}
            onMdOpen={handleMdOpen}
            onPdfOpen={handlePdfOpen}
            onHtmlOpen={handleHtmlOpen}
            onOpenFolder={handleOpenFolder}
            onDelete={handleDelete}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-stone-400">
            点击左侧产物中的文件夹以浏览内容
          </div>
        )}
      </div>

      {/* Modals */}
      {imagePreviewSrc && (
        <ImageLightbox src={imagePreviewSrc} onClose={() => setImagePreviewSrc(null)} />
      )}
      {mdPreview && (
        <MarkdownPreview
          title={mdPreview.file.name}
          content={mdPreview.content}
          loading={mdPreview.loading}
          renderAsMarkdown={mdPreview.isMarkdown}
          onClose={() => setMdPreview(null)}
        />
      )}
      {pdfPreview && (
        <PdfPreview
          src={pdfPreview.src}
          title={pdfPreview.title}
          loading={pdfPreview.loading}
          onClose={() => setPdfPreview(null)}
        />
      )}
      {htmlPreview && (
        <HtmlPreview
          title={htmlPreview.title}
          content={htmlPreview.content}
          loading={htmlPreview.loading}
          onClose={() => setHtmlPreview(null)}
        />
      )}
    </div>
  )
}

export default MyFiles
