// AgentTrace — behavior analysis view.
// Shows per-session, per-turn structured event timelines for ALL sessions.
// Each session is a collapsible section containing collapsible turn cards.
// Polls every 1s while the view is active to show live progress during runs.

import { useState, useEffect, useCallback } from 'react'
import { useAgentStore } from '../store/agentStore'
import type { TurnTrace, TraceEvent } from '../../../shared/trace'
import type { SessionMeta } from '../../../shared/types'

// Tool name → human-readable display name (mirrors ToolCallCard mapping)
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
  TodoWrite: '任务计划'
}

// Fields to hide from the data summary (already shown in the event label)
const HIDDEN_FIELDS = new Set(['tool_name'])

// Data field → Chinese label mapping
const FIELD_LABELS: Record<string, string> = {
  durationMs: '耗时',
  first_token_ms: '首token',
  产出: '产出',
  input_preview: '输入',
  output_preview: '输出',
  query_preview: '查询',
  result_count: '结果数',
  args_preview: '参数',
  is_error: '错误',
  model: '模型',
  iteration: '迭代',
  tokens: 'tokens',
  tool_call_count: '工具调用数',
  stop_reason: '结束原因',
  token_count: 'token数',
  message_preview: '消息预览',
  slug: '技能',
  path: '路径',
  length: '长度',
  injected: '已注入',
  skipped: '已跳过',
  reason: '原因'
}

// Format duration value nicely (ms → human-readable)
function formatDurationValue(ms: unknown): string {
  if (typeof ms !== 'number') return String(ms)
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`
}

// Convert a raw event type + data into a human-readable label
function eventDisplayLabel(type: string, data?: Record<string, unknown>): string {
  const toolName = typeof data?.tool_name === 'string' ? data.tool_name : ''
  const toolDisplay = TOOL_DISPLAY_NAME[toolName] ?? toolName
  const iter = data?.iteration

  switch (type) {
    case '工具执行开始':
      return `进行${toolDisplay}`
    case '工具执行完成':
      return `${toolDisplay}完成`
    case '工具执行跳过':
      return `跳过${toolDisplay}`
    case 'LLM调用开始':
      return '大模型推理'
    case 'LLM调用完成':
      return '推理完成'
    case '首token到达':
      return '首 token 到达'
    case '迭代开始':
      return iter !== undefined ? `开始第 ${iter} 轮迭代` : '开始迭代'
    case '收到请求':
      return '收到用户请求'
    case '技能已加载':
      return '加载技能'
    case '最终回答':
      return '生成最终回答'
    case '任务异常':
      return '任务异常'
    default:
      return type
  }
}

// Event type → color class mapping
function eventColorClass(label: string): string {
  if (label.includes('记忆') || label.includes('查询')) return 'text-emerald-600'
  if (label.includes('推理') || label.includes('token')) return 'text-blue-600'
  if (label.startsWith('进行') || label.startsWith('跳过') || label.endsWith('完成'))
    return 'text-purple-600'
  if (label.includes('迭代')) return 'text-stone-500'
  if (label === '任务异常') return 'text-red-600'
  if (label === '生成最终回答') return 'text-stone-800'
  if (label === '收到用户请求' || label === '加载技能') return 'text-stone-600'
  return 'text-stone-500'
}

// Fields whose values are durations (ms) — formatted nicely
const DURATION_FIELDS = new Set(['durationMs', 'first_token_ms'])

// Format data object as a short summary string (hides tool_name, keeps metrics)
function formatDataSummary(data?: Record<string, unknown>): string {
  if (!data || Object.keys(data).length === 0) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (HIDDEN_FIELDS.has(key)) continue
    if (value === undefined || value === null) continue
    const label = FIELD_LABELS[key] ?? key
    // Format duration fields nicely
    const str = DURATION_FIELDS.has(key) ? formatDurationValue(value) : String(value)
    parts.push(`${label}=${str.length > 60 ? str.slice(0, 57) + '...' : str}`)
  }
  return parts.join('  ')
}

// Stop reason → badge color
function stopReasonBadge(reason: string | null): { label: string; cls: string } {
  if (!reason) return { label: '进行中', cls: 'bg-amber-100 text-amber-700' }
  if (reason === 'stop') return { label: '完成', cls: 'bg-emerald-100 text-emerald-700' }
  if (reason === 'cancelled') return { label: '已取消', cls: 'bg-stone-200 text-stone-600' }
  if (
    reason === 'error' ||
    reason === 'force_break' ||
    reason === 'max_iterations' ||
    reason === 'context_limit'
  )
    return { label: reason, cls: 'bg-red-100 text-red-700' }
  return { label: reason, cls: 'bg-stone-200 text-stone-600' }
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`
}

// Single event row in the timeline
function EventRow({
  event,
  turnStart
}: {
  event: TraceEvent
  turnStart: number
}): React.JSX.Element {
  const offset = event.timestamp - turnStart
  const label = eventDisplayLabel(event.type, event.data)
  const dataStr = formatDataSummary(event.data)
  return (
    <div className="flex items-start gap-2 py-0.5 text-xs font-mono">
      <span className="w-16 flex-shrink-0 text-stone-400">+{(offset / 1000).toFixed(1)}s</span>
      <span className={`w-56 flex-shrink-0 truncate font-medium ${eventColorClass(label)}`}>
        {label}
      </span>
      <span className="flex-1 text-stone-600">{dataStr}</span>
    </div>
  )
}

// Collapsible turn card
function TurnCard({ turn }: { turn: TurnTrace }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const badge = stopReasonBadge(turn.stopReason)
  const durationStr = turn.durationMs ? formatDuration(turn.durationMs) : '...'

  return (
    <div className="rounded-lg border border-stone-200 bg-white">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-stone-50"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className={`h-4 w-4 flex-shrink-0 text-stone-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-stone-800 truncate">
              {turn.userMessage.slice(0, 80) || '(空消息)'}
            </span>
            <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-xs ${badge.cls}`}>
              {badge.label}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-stone-400 mt-0.5">
            <span>{formatTime(turn.startedAt)}</span>
            <span>{durationStr}</span>
            <span>{turn.events.length} events</span>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-stone-100 px-4 py-2">
          {turn.events.map((event, i) => (
            <EventRow key={i} event={event} turnStart={turn.startedAt} />
          ))}
        </div>
      )}
    </div>
  )
}

// Collapsible session section containing multiple turn cards
function SessionSection({
  sessionId,
  sessionTitle,
  turns
}: {
  sessionId: string
  sessionTitle: string
  turns: TurnTrace[]
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  // Newest turn first
  const sorted = [...turns].reverse()

  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-stone-100/50"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className={`h-4 w-4 flex-shrink-0 text-stone-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-stone-800 truncate">
              {sessionTitle || sessionId.slice(0, 12)}
            </span>
            <span className="flex-shrink-0 rounded-full bg-stone-200 px-2 py-0.5 text-xs text-stone-600">
              {turns.length} 个对话
            </span>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="space-y-2 px-4 pb-3">
          {sorted.map((turn) => (
            <TurnCard key={turn.turnId} turn={turn} />
          ))}
        </div>
      )}
    </div>
  )
}

function AgentTrace(): React.JSX.Element {
  const isRunning = useAgentStore((s) => s.isRunning)
  const [traces, setTraces] = useState<TurnTrace[]>([])
  const [sessions, setSessions] = useState<SessionMeta[]>([])

  const loadAll = useCallback(async (): Promise<void> => {
    const [allTraces, allSessions] = await Promise.all([
      window.api.trace.getAll(),
      window.api.sessions.list()
    ])
    setTraces(allTraces)
    setSessions(allSessions)
  }, [])

  useEffect(() => {
    void loadAll()
    // Poll every 1s — shows live progress during runs, and picks up new turns/sessions
    const interval = setInterval(() => {
      void loadAll()
    }, 1000)
    return () => clearInterval(interval)
  }, [loadAll])

  // Build sessionId → title map
  const titleMap = new Map(sessions.map((s) => [s.id, s.title]))

  // Group traces by sessionId, preserving overall newest-session-first order
  const sessionGroups = new Map<string, TurnTrace[]>()
  for (const trace of traces) {
    const list = sessionGroups.get(trace.sessionId)
    if (list) {
      list.push(trace)
    } else {
      sessionGroups.set(trace.sessionId, [trace])
    }
  }

  // Sort sessions by latest turn's startedAt (newest session first)
  const sortedSessions = [...sessionGroups.entries()].sort((a, b) => {
    const aLast = a[1][a[1].length - 1]?.startedAt ?? 0
    const bLast = b[1][b[1].length - 1]?.startedAt ?? 0
    return bLast - aLast
  })

  return (
    <div className="flex h-full flex-col bg-stone-50">
      <div className="border-b border-stone-200 px-6 py-3">
        <h2 className="text-sm font-medium text-stone-800">行为分析</h2>
        <p className="text-xs text-stone-400 mt-0.5">
          按会话、对话维度展示智能体处理每个任务时的关键节点及耗时
        </p>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {sortedSessions.length === 0 ? (
          <div className="flex h-full items-center justify-center text-stone-400 text-sm">
            {isRunning ? '等待 trace 数据...' : '暂无 trace 记录，发送消息后将自动记录'}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {sortedSessions.map(([sessionId, turns]) => (
              <SessionSection
                key={sessionId}
                sessionId={sessionId}
                sessionTitle={titleMap.get(sessionId) ?? ''}
                turns={turns}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default AgentTrace
