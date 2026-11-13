// AgentTrace — behavior analysis view with horizontal timeline.
// Shows per-session, per-turn structured event timelines as time blocks.
// Each block is positioned by start time, width = duration.
// Click a block to see details in the right sidebar.
// Polls every 1s while the view is active to show live progress during runs.

import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
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
  browser_use: '浏览器操作',
  TodoWrite: '任务计划'
}

// Fields to hide from the detail panel (already shown in the block label)
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
  result_preview: '结果',
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

// Fields whose values are durations (ms) — formatted nicely
const DURATION_FIELDS = new Set(['durationMs', 'first_token_ms'])

// ── Utility functions (preserved from vertical version) ──

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
      return iter !== undefined ? `迭代 ${iter}` : '开始迭代'
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

// Block style — light blue default, light pink for error blocks
function blockStyleClasses(block: TimelineBlock): { bg: string; ring: string } {
  const isError = block.mergedData.is_error === true
  if (isError) {
    return { bg: 'bg-rose-100 hover:bg-rose-200', ring: 'ring-rose-400' }
  }
  return { bg: 'bg-sky-100 hover:bg-sky-200', ring: 'ring-sky-400' }
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

// ── Timeline block building ──

interface TimelineBlock {
  id: string
  label: string
  startOffset: number // ms from turn start
  durationMs: number // 0 for point events
  isPoint: boolean // true for instantaneous events
  isIteration: boolean // true for iteration divider lines
  mergedData: Record<string, unknown> // merged from start/end events
  rawEvents: TraceEvent[] // underlying raw events
}

// Walk through events in order, pairing start/end events into duration blocks.
// Unpaired starts (e.g., cancelled mid-call) become point blocks.
function buildTimelineBlocks(events: TraceEvent[], turnStart: number): TimelineBlock[] {
  const blocks: TimelineBlock[] = []
  let pendingLLMStart: TraceEvent | null = null
  let pendingToolStart: TraceEvent | null = null

  for (const event of events) {
    const offset = event.timestamp - turnStart

    if (event.type === 'LLM调用开始') {
      pendingLLMStart = event
    } else if (event.type === 'LLM调用完成') {
      if (pendingLLMStart) {
        const startOffset = pendingLLMStart.timestamp - turnStart
        const duration =
          typeof event.data?.durationMs === 'number'
            ? (event.data.durationMs as number)
            : event.timestamp - pendingLLMStart.timestamp
        blocks.push({
          id: `llm-${startOffset}`,
          label: '大模型推理',
          startOffset,
          durationMs: duration,
          isPoint: false,
          isIteration: false,
          mergedData: { ...pendingLLMStart.data, ...event.data },
          rawEvents: [pendingLLMStart, event]
        })
        pendingLLMStart = null
      }
    } else if (event.type === '工具执行开始') {
      pendingToolStart = event
    } else if (event.type === '工具执行完成') {
      if (pendingToolStart) {
        const startOffset = pendingToolStart.timestamp - turnStart
        const duration =
          typeof event.data?.durationMs === 'number'
            ? (event.data.durationMs as number)
            : event.timestamp - pendingToolStart.timestamp
        const toolName =
          typeof pendingToolStart.data?.tool_name === 'string'
            ? pendingToolStart.data.tool_name
            : ''
        const toolDisplay = TOOL_DISPLAY_NAME[toolName] ?? toolName
        blocks.push({
          id: `tool-${startOffset}`,
          label: toolDisplay,
          startOffset,
          durationMs: duration,
          isPoint: false,
          isIteration: false,
          mergedData: { ...pendingToolStart.data, ...event.data },
          rawEvents: [pendingToolStart, event]
        })
        pendingToolStart = null
      }
    } else if (event.type === '工具执行跳过') {
      const toolName = typeof event.data?.tool_name === 'string' ? event.data.tool_name : ''
      const toolDisplay = TOOL_DISPLAY_NAME[toolName] ?? toolName
      blocks.push({
        id: `skip-${offset}`,
        label: `跳过${toolDisplay}`,
        startOffset: offset,
        durationMs: 0,
        isPoint: true,
        isIteration: false,
        mergedData: event.data ?? {},
        rawEvents: [event]
      })
    } else {
      // Point events: 迭代开始, 收到请求, 首token到达, 技能已加载, 最终回答, 任务异常
      blocks.push({
        id: `${event.type}-${offset}`,
        label: eventDisplayLabel(event.type, event.data),
        startOffset: offset,
        durationMs: 0,
        isPoint: true,
        isIteration: event.type === '迭代开始',
        mergedData: event.data ?? {},
        rawEvents: [event]
      })
    }
  }

  // Handle unmatched starts (e.g., run cancelled mid-LLM-call)
  if (pendingLLMStart) {
    const offset = pendingLLMStart.timestamp - turnStart
    blocks.push({
      id: `llm-pending-${offset}`,
      label: '大模型推理',
      startOffset: offset,
      durationMs: 0,
      isPoint: true,
      isIteration: false,
      mergedData: pendingLLMStart.data ?? {},
      rawEvents: [pendingLLMStart]
    })
  }
  if (pendingToolStart) {
    const offset = pendingToolStart.timestamp - turnStart
    const toolName =
      typeof pendingToolStart.data?.tool_name === 'string' ? pendingToolStart.data.tool_name : ''
    const toolDisplay = TOOL_DISPLAY_NAME[toolName] ?? toolName
    blocks.push({
      id: `tool-pending-${offset}`,
      label: toolDisplay,
      startOffset: offset,
      durationMs: 0,
      isPoint: true,
      isIteration: false,
      mergedData: pendingToolStart.data ?? {},
      rawEvents: [pendingToolStart]
    })
  }

  return blocks
}

// Generate nice time axis ticks (0s, 5s, 10s, ...)
function generateTicks(totalMs: number): Array<{ pct: number; label: string }> {
  if (totalMs <= 0) return []
  const ticks: Array<{ pct: number; label: string }> = []
  const totalS = totalMs / 1000
  let interval: number
  if (totalS <= 5) interval = 1
  else if (totalS <= 10) interval = 2
  else if (totalS <= 30) interval = 5
  else if (totalS <= 60) interval = 10
  else interval = 30

  for (let t = 0; t <= totalS + 0.01; t += interval) {
    ticks.push({ pct: ((t * 1000) / totalMs) * 100, label: `${t}s` })
  }
  return ticks
}

// ── Timeline row (one block) ──

function TimelineRow({
  block,
  totalDurationMs,
  isSelected,
  onClick
}: {
  block: TimelineBlock
  totalDurationMs: number
  isSelected: boolean
  onClick: () => void
}): React.JSX.Element {
  const startPct = totalDurationMs > 0 ? (block.startOffset / totalDurationMs) * 100 : 0
  const widthPct =
    totalDurationMs > 0 ? Math.max((block.durationMs / totalDurationMs) * 100, 1.2) : 100
  const style = blockStyleClasses(block)

  // Iteration marker → full-width horizontal line across the entire track
  if (block.isIteration) {
    return (
      <div className="flex items-center gap-2 h-6 group">
        <span className="w-24 flex-shrink-0 truncate text-right text-xs font-medium text-stone-500">
          {block.label}
        </span>
        <div className="relative flex-1 h-5 flex items-center">
          <div
            onClick={(e) => {
              e.stopPropagation()
              onClick()
            }}
            className={`w-full cursor-pointer border-t border-stone-300 hover:border-stone-400 ${
              isSelected ? 'border-stone-500 border-t-2' : ''
            }`}
          />
        </div>
      </div>
    )
  }

  // 首 token 到达 → small gold star (North Star metric)
  if (block.label === '首 token 到达') {
    return (
      <div className="flex items-center gap-2 h-6 group">
        <span className="w-24 flex-shrink-0 truncate text-right text-xs font-medium text-stone-500">
          {block.label}
        </span>
        <div className="relative flex-1 h-5 flex items-center">
          <svg
            onClick={(e) => {
              e.stopPropagation()
              onClick()
            }}
            className={`absolute h-4 w-4 cursor-pointer transition-colors ${
              isSelected ? 'text-amber-500' : 'text-amber-400 hover:text-amber-600'
            }`}
            style={{ left: `${startPct}%`, transform: 'translateX(-50%)' }}
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7.4L12 17l-6.3 4.4L8 14 2 9.4h7.6z" />
          </svg>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 h-6 group">
      {/* Label */}
      <span className="w-24 flex-shrink-0 truncate text-right text-xs font-medium text-stone-700">
        {block.label}
      </span>
      {/* Track */}
      <div className="relative flex-1 h-5">
        <div
          onClick={(e) => {
            e.stopPropagation()
            onClick()
          }}
          className={`absolute h-5 cursor-pointer rounded transition-all ${style.bg} ${
            isSelected ? `ring-2 ${style.ring} z-10` : 'hover:opacity-80'
          } ${block.isPoint ? 'w-2' : ''}`}
          style={
            block.isPoint
              ? { left: `${startPct}%`, transform: 'translateX(-50%)' }
              : { left: `${startPct}%`, width: `${widthPct}%` }
          }
        >
          {!block.isPoint && block.durationMs > 0 && (
            <span className="px-1 text-[9px] leading-5 text-stone-600 truncate block">
              {formatDuration(block.durationMs)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Detail panel (right sidebar, table style) ──

interface DetailEntry {
  label: string
  value: string
  // For structured fields like output_preview, render sub-rows
  subRows?: Array<{ label: string; value: string }>
}

function DetailPanel({ block }: { block: TimelineBlock | null }): React.JSX.Element {
  const [showRaw, setShowRaw] = useState(false)

  if (!block) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-stone-400">
        点击时间区块查看详情
      </div>
    )
  }

  // Build structured entries from merged data
  const entries: DetailEntry[] = [
    { label: '名称', value: block.label },
    { label: '开始', value: `+${(block.startOffset / 1000).toFixed(1)}s` }
  ]
  if (block.durationMs > 0) {
    entries.push({ label: '耗时', value: formatDuration(block.durationMs) })
  }

  for (const [key, value] of Object.entries(block.mergedData)) {
    if (HIDDEN_FIELDS.has(key)) continue
    if (value === undefined || value === null) continue
    const fieldLabel = FIELD_LABELS[key] ?? key

    // Structured output_preview (new object format)
    if (
      key === 'output_preview' &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const op = value as {
        reasoning?: string | null
        text?: string | null
        tool_calls?: string[]
      }
      const subRows: Array<{ label: string; value: string }> = []
      if (op.reasoning) subRows.push({ label: '思考', value: op.reasoning })
      if (op.text) subRows.push({ label: '文本', value: op.text })
      if (op.tool_calls && op.tool_calls.length > 0) {
        subRows.push({ label: '工具', value: op.tool_calls.join(', ') })
      }
      entries.push({ label: fieldLabel, value: '', subRows })
    } else {
      const str = DURATION_FIELDS.has(key) ? formatDurationValue(value) : String(value)
      entries.push({ label: fieldLabel, value: str })
    }
  }

  // Raw JSON for completeness
  const rawJson = JSON.stringify(
    block.rawEvents.map((e) => ({ type: e.type, data: e.data })),
    null,
    2
  )

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3">
      <table className="w-full border-collapse text-xs font-mono">
        <tbody>
          {entries.map((e, i) => (
            <Fragment key={i}>
              <tr className="border-b border-stone-100">
                <td className="w-16 py-1 pr-2 text-stone-400 align-top">{e.label}</td>
                <td className="py-1 break-all text-stone-700">{e.value}</td>
              </tr>
              {e.subRows?.map((sr, j) => (
                <tr key={j} className="border-b border-stone-50">
                  <td className="w-16 py-1 pr-2 pl-3 text-stone-400 align-top">└ {sr.label}</td>
                  <td className="py-1 break-all text-stone-600">{sr.value}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
      <button
        onClick={() => setShowRaw(!showRaw)}
        className="mt-3 text-[10px] text-stone-400 hover:text-stone-600"
      >
        {showRaw ? '▾ 隐藏原始数据' : '▸ 查看原始数据'}
      </button>
      {showRaw && (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-stone-50 p-2 text-[10px] text-stone-500">
          {rawJson}
        </pre>
      )}
    </div>
  )
}

// ── Turn card with timeline + detail panel ──

function TurnCard({
  turn,
  defaultExpanded = false
}: {
  turn: TurnTrace
  defaultExpanded?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  const badge = stopReasonBadge(turn.stopReason)
  const durationStr = turn.durationMs ? formatDuration(turn.durationMs) : '...'

  // Build timeline blocks
  const blocks = useMemo(
    () => buildTimelineBlocks(turn.events, turn.startedAt),
    [turn.events, turn.startedAt]
  )

  // Summary metrics
  const totalIterations = useMemo(
    () => turn.events.filter((e) => e.type === '迭代开始').length,
    [turn.events]
  )
  const totalTokens = useMemo(() => {
    let sum = 0
    for (const e of turn.events) {
      if (e.type === 'LLM调用完成' && typeof e.data?.tokens === 'number') {
        sum += e.data.tokens as number
      }
    }
    return sum
  }, [turn.events])

  const totalDuration = useMemo(() => {
    if (turn.durationMs && turn.durationMs > 0) return turn.durationMs
    if (turn.events.length > 0) {
      return turn.events[turn.events.length - 1].timestamp - turn.startedAt
    }
    return 0
  }, [turn.durationMs, turn.events, turn.startedAt])

  const ticks = useMemo(() => generateTicks(totalDuration), [totalDuration])
  const selectedBlock = blocks.find((b) => b.id === selectedBlockId) ?? null

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
            <span>耗时 {durationStr}</span>
            <span>{totalIterations} 次迭代</span>
            {totalTokens > 0 && <span>{totalTokens.toLocaleString()} tokens</span>}
            <span>{blocks.length} 区块</span>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-stone-100">
          <div className="relative">
            {/* Timeline (left, 75% width, determines height) */}
            <div className="overflow-x-auto px-4 py-3" style={{ width: '75%' }}>
              {/* Time axis */}
              <div className="flex items-center gap-2 h-6 mb-1">
                <span className="w-24 flex-shrink-0 text-right text-[10px] text-stone-400">
                  事件
                </span>
                <div className="relative flex-1 h-5">
                  {ticks.map((t, i) => (
                    <div
                      key={i}
                      className="absolute flex flex-col items-center"
                      style={{ left: `${t.pct}%`, transform: 'translateX(-50%)' }}
                    >
                      <div className="h-2 w-px bg-stone-200" />
                      <span className="mt-0.5 text-[9px] text-stone-400">{t.label}</span>
                    </div>
                  ))}
                </div>
              </div>
              {/* Block rows */}
              <div className="space-y-0.5">
                {blocks.map((b) => (
                  <TimelineRow
                    key={b.id}
                    block={b}
                    totalDurationMs={totalDuration}
                    isSelected={b.id === selectedBlockId}
                    onClick={() => setSelectedBlockId((prev) => (prev === b.id ? null : b.id))}
                  />
                ))}
              </div>
            </div>
            {/* Detail panel (absolute right, matches timeline height, scrolls if taller) */}
            <div
              className="absolute top-0 right-0 bottom-0 overflow-y-auto border-l border-stone-100"
              style={{ width: '25%' }}
            >
              <DetailPanel block={selectedBlock} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Session section (mostly unchanged) ──

function SessionSection({
  sessionId,
  sessionTitle,
  turns,
  defaultExpanded = false
}: {
  sessionId: string
  sessionTitle: string
  turns: TurnTrace[]
  defaultExpanded?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)
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
          {sorted.map((turn, i) => (
            <TurnCard key={turn.turnId} turn={turn} defaultExpanded={i === 0 && defaultExpanded} />
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
    const interval = setInterval(() => {
      void loadAll()
    }, 1000)
    return () => clearInterval(interval)
  }, [loadAll])

  const titleMap = new Map(sessions.map((s) => [s.id, s.title]))

  const sessionGroups = new Map<string, TurnTrace[]>()
  for (const trace of traces) {
    const list = sessionGroups.get(trace.sessionId)
    if (list) {
      list.push(trace)
    } else {
      sessionGroups.set(trace.sessionId, [trace])
    }
  }

  const sortedSessions = [...sessionGroups.entries()].sort((a, b) => {
    const aLast = a[1][a[1].length - 1]?.startedAt ?? 0
    const bLast = b[1][b[1].length - 1]?.startedAt ?? 0
    return bLast - aLast
  })

  return (
    <div className="flex h-full flex-1 flex-col bg-stone-50">
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
            {sortedSessions.map(([sessionId, turns], idx) => (
              <SessionSection
                key={sessionId}
                sessionId={sessionId}
                sessionTitle={titleMap.get(sessionId) ?? ''}
                turns={turns}
                defaultExpanded={idx === 0}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default AgentTrace
