// ConfirmOverlay — the system-wide floating confirmation window.
// Renders inside the frameless alwaysOnTop BrowserWindow created by
// confirm-window.ts. Three modes (same as ToolConfirmDialog):
// 1. Tool execution: tool name + collapsible content + 3 buttons
// 2. Command blocks (terminal): N commands + 3 buttons
// 3. Choices (ask_user): question + N choice rows + reject

import { useState, useEffect, useRef, useLayoutEffect } from 'react'
import type { ToolConfirmChoice, ToolConfirmCommandBlock } from '../../../shared/agent-events'

interface ConfirmData {
  confirmationId: string
  sessionId: string
  toolName: string
  content: string
  choices?: ToolConfirmChoice[]
  commandBlocks?: ToolConfirmCommandBlock[]
  purpose?: string
}

// Tool name → Chinese display name
const TOOL_NAME_CN: Record<string, string> = {
  code_execute: '代码执行',
  terminal: '终端命令',
  web_search: '网页搜索',
  web_fetch: '网页抓取',
  vision: '图像识别',
  read: '读取文件',
  write: '写入文件',
  delete: '删除文件',
  ls: '列出文件',
  TodoWrite: '任务规划',
  save_product: '保存产品',
  save_skill: '保存技能',
  memory_search: '记忆搜索',
  save_memory: '记忆沉淀',
  schedule_task: '定时任务',
  skill_hub_search: '技能市场搜索',
  skill_hub_install: '安装技能',
  ask_user: '用户选择',
  get_current_time: '当前时间'
}

function getToolNameCn(name: string): string {
  return TOOL_NAME_CN[name] ?? name
}

const ConfirmOverlay = (): React.JSX.Element => {
  const [data, setData] = useState<ConfirmData | null>(null)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [contentExpanded, setContentExpanded] = useState(true)
  const [blockExpanded, setBlockExpanded] = useState<Record<number, boolean>>({})
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const off = window.api.confirm.onData((d) => setData(d))
    return off
  }, [])

  // Resize the frameless BrowserWindow to exactly match the rendered content
  // height, eliminating any blank space below the action buttons.
  // Guard: resize may be undefined if preload hasn't been recompiled yet.
  useLayoutEffect(() => {
    if (rootRef.current && typeof window.api.confirm.resize === 'function') {
      const height = rootRef.current.scrollHeight
      window.api.confirm.resize(height)
    }
  }, [data, blockExpanded, contentExpanded, text])

  if (!data) {
    return <div className="flex h-screen items-center justify-center bg-white" />
  }

  const { confirmationId, sessionId, toolName, content, choices, commandBlocks, purpose } = data
  const isChoicesMode = choices && choices.length > 0
  const isCommandBlocksMode = !isChoicesMode && commandBlocks && commandBlocks.length > 0
  const toolNameCn = getToolNameCn(toolName)

  const respond = async (
    action: 'approve_once' | 'approve_session' | 'reject',
    choiceIndex?: number
  ): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      await window.api.confirm.respond(
        sessionId,
        confirmationId,
        action,
        text || undefined,
        choiceIndex
      )
    } catch {
      // ignore — the 5-min timeout in main will auto-reject
    }
    window.api.confirm.close()
  }

  // ── Choices mode (human-in-the-loop) ──
  if (isChoicesMode) {
    return (
      <div ref={rootRef} className="flex flex-col overflow-hidden bg-white">
        {/* Drag region */}
        <div
          className="flex h-8 flex-shrink-0 items-center gap-2 border-b border-stone-100 bg-stone-50 px-3"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-stone-500"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-xs font-medium text-stone-600">智能体需要您的选择</span>
        </div>

        {/* Question */}
        <div className="flex-1 overflow-auto px-3 py-2.5 text-xs text-stone-600">{content}</div>

        {/* Choice rows */}
        <div className="flex-shrink-0 border-t border-stone-100">
          {choices!.map((choice, i) => (
            <button
              key={i}
              onClick={() => void respond('approve_once', i)}
              disabled={submitting}
              className="flex w-full items-start gap-2 border-b border-stone-100 px-3 py-2.5 text-left transition-colors hover:bg-stone-50 disabled:opacity-50"
            >
              <span className="flex-shrink-0 text-xs font-bold text-stone-400">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-stone-800">{choice.title}</span>
                  {i === 0 && (
                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-700">
                      最推荐
                    </span>
                  )}
                </div>
                {choice.detail && (
                  <p className="mt-0.5 text-[10px] leading-relaxed text-stone-500">
                    {choice.detail}
                  </p>
                )}
              </div>
            </button>
          ))}

          <button
            onClick={() => void respond('reject')}
            disabled={submitting}
            className="flex w-full items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-medium text-stone-500 transition-colors hover:bg-stone-50 disabled:opacity-50"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            都不选
          </button>
        </div>
      </div>
    )
  }

  // ── Command blocks mode (terminal chained commands) ──
  if (isCommandBlocksMode) {
    return (
      <div ref={rootRef} className="flex flex-col overflow-hidden bg-white">
        {/* Header */}
        <div
          className="flex h-8 flex-shrink-0 items-center gap-2 border-b border-stone-100 bg-stone-50 px-3"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-stone-500"
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-xs font-medium text-stone-700">确认执行 — {toolNameCn}</span>
          <span className="ml-auto text-[10px] text-stone-400">{commandBlocks!.length} 条命令</span>
        </div>

        {/* Purpose — why the agent wants to run this command */}
        {purpose && (
          <div className="flex-shrink-0 border-b border-stone-100 px-3 py-2">
            <div className="mb-0.5 text-[10px] text-stone-400">执行目的</div>
            <div className="text-sm text-stone-600">{purpose}</div>
          </div>
        )}

        {/* Commands label */}
        <div className="flex-shrink-0 border-b border-stone-100 px-3 py-1.5">
          <div className="text-[10px] text-stone-400">执行命令</div>
        </div>

        {/* Commands list */}
        <div className="max-h-[200px] overflow-auto">
          {commandBlocks!.map((block, i) => (
            <div key={i} className="border-b border-stone-100">
              <button
                onClick={() => setBlockExpanded((s) => ({ ...s, [i]: !s[i] }))}
                disabled={submitting}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-stone-50 disabled:opacity-50"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className={`h-3 w-3 flex-shrink-0 text-stone-400 transition-transform ${blockExpanded[i] ? 'rotate-90' : ''}`}
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
                <span className="flex-1 min-w-0 truncate text-[11px] text-stone-600">
                  {block.command}
                </span>
                {block.reason && (
                  <span className="flex-shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-700">
                    {block.reason}
                  </span>
                )}
              </button>
              {blockExpanded[i] && (
                <div className="px-3 pb-1.5">
                  <pre className="max-h-20 overflow-auto rounded-md bg-stone-50 p-2 text-[10px] leading-relaxed text-stone-700">
                    <code>{block.command}</code>
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Action buttons */}
        <div className="flex flex-shrink-0 flex-col gap-1.5 border-t border-stone-100 p-2.5">
          <button
            onClick={() => void respond('approve_once')}
            disabled={submitting}
            className="flex items-center justify-center gap-1.5 rounded-md bg-stone-100 px-3 py-2 text-[11px] font-medium text-stone-600 transition-colors hover:bg-stone-200 disabled:opacity-50"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            仅此次允许
          </button>
          <button
            onClick={() => void respond('approve_session')}
            disabled={submitting}
            className="flex items-center justify-center gap-1.5 rounded-md bg-stone-100 px-3 py-2 text-[11px] font-medium text-stone-600 transition-colors hover:bg-stone-200 disabled:opacity-50"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
              <path d="M2 2h7v7" />
              <path d="M2 13a9 9 0 0 1 9 9" />
            </svg>
            本次会话允许
          </button>
          <button
            onClick={() => void respond('reject')}
            disabled={submitting}
            className="flex items-center justify-center gap-1.5 rounded-md bg-stone-50 px-3 py-2 text-[11px] font-medium text-stone-500 transition-colors hover:bg-stone-100 disabled:opacity-50"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            拒绝
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="其他"
            className="w-full rounded-md border border-stone-200 px-2.5 py-1.5 text-[11px] text-stone-700 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none"
          />
        </div>
      </div>
    )
  }

  // ── Tool execution mode ──
  return (
    <div ref={rootRef} className="flex flex-col overflow-hidden bg-white">
      {/* Header */}
      <div
        className="flex h-8 flex-shrink-0 items-center gap-2 border-b border-stone-100 bg-stone-50 px-3"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-stone-500"
        >
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span className="text-xs font-medium text-stone-700">确认执行 — {toolNameCn}</span>
      </div>

      {/* Purpose — why the agent wants to run this */}
      {purpose && (
        <div className="flex-shrink-0 border-b border-stone-100 px-3 py-2">
          <div className="mb-0.5 text-[10px] text-stone-400">执行目的</div>
          <div className="text-sm text-stone-600">{purpose}</div>
        </div>
      )}

      {/* Content — expanded by default */}
      <div className="flex-1 overflow-auto">
        <button
          onClick={() => setContentExpanded(!contentExpanded)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-stone-50"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className={`h-3 w-3 flex-shrink-0 text-stone-400 transition-transform ${contentExpanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-[11px] text-stone-500">
            {contentExpanded ? '收起确认内容' : '点击展开确认内容'}
          </span>
        </button>
        {contentExpanded && (
          <div className="px-3 pb-2">
            <pre className="max-h-32 overflow-auto rounded-md bg-stone-50 p-2.5 text-[10px] leading-relaxed text-stone-700">
              <code>{content}</code>
            </pre>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex flex-shrink-0 flex-col gap-1.5 border-t border-stone-100 p-2.5">
        <button
          onClick={() => void respond('approve_once')}
          disabled={submitting}
          className="flex items-center justify-center gap-1.5 rounded-md bg-stone-100 px-3 py-2 text-[11px] font-medium text-stone-600 transition-colors hover:bg-stone-200 disabled:opacity-50"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          仅此次允许
        </button>
        <button
          onClick={() => void respond('approve_session')}
          disabled={submitting}
          className="flex items-center justify-center gap-1.5 rounded-md bg-stone-100 px-3 py-2 text-[11px] font-medium text-stone-600 transition-colors hover:bg-stone-200 disabled:opacity-50"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
            <path d="M2 2h7v7" />
            <path d="M2 13a9 9 0 0 1 9 9" />
          </svg>
          本次会话允许
        </button>
        <button
          onClick={() => void respond('reject')}
          disabled={submitting}
          className="flex items-center justify-center gap-1.5 rounded-md bg-stone-50 px-3 py-2 text-[11px] font-medium text-stone-500 transition-colors hover:bg-stone-100 disabled:opacity-50"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          拒绝
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="其他"
          className="w-full rounded-md border border-stone-200 px-2.5 py-1.5 text-[11px] text-stone-700 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none"
        />
      </div>
    </div>
  )
}

export default ConfirmOverlay
