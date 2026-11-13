// ToolCallItem — displays a single tool call with name, args, and result.
// Result is collapsible. Error results get a red-ish accent (kept subtle
// to stay within stone palette; uses border + label rather than red fill).
//
// ToolCallCard wraps ToolCallItem for backward compatibility (renders all
// tool calls from toolCallOrder). ChatView can also render ToolCallItem
// directly for interleaved text/tool-call display via streamItems.

import { useState, useEffect } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { useUIStore } from '../../store/uiStore'

function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2)
  } catch {
    return str
  }
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
  session_spawn: '专家委派',
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

// Generated image display — loads a generated image from the tool result JSON
// and renders it inline below the tool call header. Used by generate_image.
function GeneratedImage({ resultJson }: { resultJson: string }): React.JSX.Element | null {
  const [src, setSrc] = useState<string | null>(null)

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

export function ToolCallItem({ id }: { id: string }): React.JSX.Element | null {
  const tc = useAgentStore((s) => s.toolCalls[id])
  const expertRunIds = useAgentStore((s) => s.expertRunIds)
  const openExecution = useUIStore((s) => s.openExecution)
  const [expanded, setExpanded] = useState(false)

  if (!tc) return null
  if (tc.name === 'TodoWrite') return null

  const hasResult = tc.result !== undefined
  const isRunning = !hasResult
  const isSessionSpawn = tc.name === 'session_spawn'
  const expertRunId = expertRunIds[id]
  const subtitle = getToolCallSubtitle(tc.name, tc.args)

  return (
    <div>
      <div
        onClick={() => setExpanded((e) => !e)}
        className="flex cursor-pointer items-center gap-2 rounded py-1 hover:bg-stone-50"
      >
        <ToolIcon name={tc.name} />
        <span className="font-mono text-xs font-medium text-stone-700">
          {TOOL_DISPLAY_NAME[tc.name] ?? tc.name}
        </span>
        {subtitle && <span className="truncate text-xs text-stone-400">{subtitle}</span>}
        {isRunning && (
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-stone-500" />
        )}
        {tc.isError && <span className="text-[10px] text-stone-500">ERROR</span>}
        {hasResult && !tc.isError && <span className="text-[10px] text-stone-400">✓</span>}
        {isSessionSpawn && expertRunId && (
          <span
            onClick={(e) => {
              e.stopPropagation()
              openExecution(expertRunId)
            }}
            className="cursor-pointer rounded border border-stone-300 px-1.5 py-0.5 text-[10px] text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
          >
            查看执行详情 →
          </span>
        )}
        <span className="select-none text-xs text-stone-400">{expanded ? '▾' : '▸'}</span>
      </div>

      {(tc.name === 'generate_image' || tc.name === 'edit_image') && hasResult && !tc.isError && (
        <GeneratedImage resultJson={tc.result ?? ''} />
      )}

      {expanded && (
        <div className="space-y-2 py-1 pl-7">
          <div>
            <div className="mb-1 text-[10px] text-stone-400">参数</div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-stone-50 px-3 py-2 font-mono text-xs text-stone-600">
              {formatJson(tc.args)}
            </pre>
          </div>
          {hasResult && (
            <div>
              <div className="mb-1 text-[10px] text-stone-400">结果</div>
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-stone-50 px-3 py-2 font-mono text-xs text-stone-600">
                {formatJson(tc.result ?? '')}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Backward-compatible wrapper — renders all tool calls from toolCallOrder. */
function ToolCallCard(): React.JSX.Element {
  const toolCallOrder = useAgentStore((s) => s.toolCallOrder)

  if (toolCallOrder.length === 0) return <></>

  return (
    <div className="w-full space-y-2">
      {toolCallOrder.map((id) => (
        <ToolCallItem key={id} id={id} />
      ))}
    </div>
  )
}

export default ToolCallCard
