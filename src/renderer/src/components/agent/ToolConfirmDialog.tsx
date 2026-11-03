// ToolConfirmDialog — shows a confirmation prompt when a dangerous tool
// (code_execute, terminal) requests user approval before execution, or
// when the agent calls ask_user to present multiple choices (human-in-the-loop).
//
// Two modes:
// 1. Tool execution: collapsed content + 3 stacked full-width buttons
//    (仅此次允许 / 本次会话允许 / 拒绝)
// 2. Human-in-the-loop choices: question + N choice rows (title + detail,
//    ordered most→least recommended) + 都不选 button

import { useState } from 'react'
import { useAgentStore } from '../../store/agentStore'
import { useSessionStore } from '../../store/sessionStore'

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
  ask_user: '用户选择'
}

function getToolNameCn(name: string): string {
  return TOOL_NAME_CN[name] ?? name
}

const ToolConfirmDialog = (): React.JSX.Element | null => {
  const pending = useAgentStore((s) => s.pendingConfirmation)
  const clear = useAgentStore((s) => s.clearPendingConfirmation)
  const currentId = useSessionStore((s) => s.currentId)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [contentExpanded, setContentExpanded] = useState(false)
  const [blockExpanded, setBlockExpanded] = useState<Record<number, boolean>>({})

  if (!pending) return null

  const { confirmationId, toolName, content, choices, command_blocks, purpose } = pending
  const isChoicesMode = choices && choices.length > 0
  const isCommandBlocksMode = !isChoicesMode && command_blocks && command_blocks.length > 0

  const respond = async (
    action: 'approve_once' | 'approve_session' | 'reject',
    choiceIndex?: number
  ): Promise<void> => {
    if (!currentId || submitting) return
    setSubmitting(true)
    try {
      await window.api.agent.confirmTool(
        currentId,
        confirmationId,
        action,
        text || undefined,
        choiceIndex
      )
    } catch {
      // ignore — the 5-min timeout in main will auto-reject
    }
    setText('')
    setSubmitting(false)
    setContentExpanded(false)
    setBlockExpanded({})
    clear()
  }

  const toolNameCn = getToolNameCn(toolName)

  // ── Choices mode (human-in-the-loop) ──
  if (isChoicesMode) {
    return (
      <div className="mx-auto w-[640px] pb-3">
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-stone-100 px-4 py-2.5">
            <svg
              width="16"
              height="16"
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
            <span className="text-sm font-medium text-stone-700">智能体需要您的选择</span>
          </div>

          {/* Question */}
          <div className="px-4 py-2.5 text-sm text-stone-600">{content}</div>

          {/* Choice rows — each full width with padding */}
          {choices!.map((choice, i) => (
            <button
              key={i}
              onClick={() => void respond('approve_once', i)}
              disabled={submitting}
              className="flex w-full items-start gap-3 border-t border-stone-100 px-4 py-3 text-left transition-colors hover:bg-stone-50 disabled:opacity-50"
            >
              <span className="flex-shrink-0 text-sm font-bold text-stone-400">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-stone-800">{choice.title}</span>
                  {i === 0 && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                      最推荐
                    </span>
                  )}
                </div>
                {choice.detail && (
                  <p className="mt-1 text-xs leading-relaxed text-stone-500">{choice.detail}</p>
                )}
              </div>
            </button>
          ))}

          {/* Reject button — full width */}
          <button
            onClick={() => void respond('reject')}
            disabled={submitting}
            className="flex w-full items-center justify-center gap-1.5 border-t border-stone-200 px-4 py-2.5 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-50 disabled:opacity-50"
          >
            <svg
              width="13"
              height="13"
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
      <div className="mx-auto w-[640px] pb-3">
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-stone-100 px-4 py-2.5">
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
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="text-sm font-medium text-stone-700">确认执行 — {toolNameCn}</span>
            <span className="ml-auto text-xs text-stone-400">{command_blocks!.length} 条命令</span>
          </div>

          {/* Purpose — why the agent wants to run this command */}
          {purpose && (
            <div className="border-b border-stone-100 px-4 py-2.5">
              <div className="mb-0.5 text-[10px] text-stone-400">执行目的</div>
              <div className="text-xs text-stone-600">{purpose}</div>
            </div>
          )}

          {/* Each sub-command as a collapsible block */}
          {command_blocks!.map((block, i) => (
            <div key={i} className="border-b border-stone-100">
              <button
                onClick={() => setBlockExpanded((s) => ({ ...s, [i]: !s[i] }))}
                disabled={submitting}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-stone-50 disabled:opacity-50"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className={`h-3.5 w-3.5 flex-shrink-0 text-stone-400 transition-transform ${blockExpanded[i] ? 'rotate-90' : ''}`}
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
                <span className="flex-1 min-w-0 truncate text-xs text-stone-600">
                  {block.command}
                </span>
                {block.reason && (
                  <span className="flex-shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                    {block.reason}
                  </span>
                )}
              </button>
              {blockExpanded[i] && (
                <div className="px-4 pb-2">
                  <pre className="max-h-44 overflow-auto rounded-md bg-stone-50 p-3 text-xs leading-relaxed text-stone-700">
                    <code>{block.command}</code>
                  </pre>
                </div>
              )}
            </div>
          ))}

          {/* Action buttons + input */}
          <div className="flex flex-col gap-2 px-3 pb-3 pt-2">
            <button
              onClick={() => void respond('approve_once')}
              disabled={submitting}
              className="flex items-center justify-center gap-1.5 rounded-md bg-stone-100 px-4 py-2.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-200 disabled:opacity-50"
            >
              <svg
                width="13"
                height="13"
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
              className="flex items-center justify-center gap-1.5 rounded-md bg-stone-100 px-4 py-2.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-200 disabled:opacity-50"
            >
              <svg
                width="13"
                height="13"
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
              className="flex items-center justify-center gap-1.5 rounded-md bg-stone-50 px-4 py-2.5 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-100 disabled:opacity-50"
            >
              <svg
                width="13"
                height="13"
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
              className="w-full rounded-md border border-stone-200 px-3 py-1.5 text-xs text-stone-700 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none"
            />
          </div>
        </div>
      </div>
    )
  }

  // ── Tool execution mode ──
  return (
    <div className="mx-auto w-[640px] pb-3">
      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-stone-100 px-4 py-2.5">
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
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-sm font-medium text-stone-700">确认执行 — {toolNameCn}</span>
        </div>

        {/* Purpose — why the agent wants to run this */}
        {purpose && (
          <div className="border-b border-stone-100 px-4 py-2.5">
            <div className="mb-0.5 text-[10px] text-stone-400">执行目的</div>
            <div className="text-xs text-stone-600">{purpose}</div>
          </div>
        )}

        {/* Collapsible content — collapsed by default */}
        <button
          onClick={() => setContentExpanded(!contentExpanded)}
          className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-stone-50"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className={`h-3.5 w-3.5 flex-shrink-0 text-stone-400 transition-transform ${contentExpanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-xs text-stone-500">
            {contentExpanded ? '收起确认内容' : '点击展开确认内容'}
          </span>
        </button>

        {contentExpanded && (
          <div className="px-4 pb-2">
            <pre className="max-h-44 overflow-auto rounded-md bg-stone-50 p-3 text-xs leading-relaxed text-stone-700">
              <code>{content}</code>
            </pre>
          </div>
        )}

        {/* Action buttons + input — spaced cards */}
        <div className="flex flex-col gap-2 px-3 pb-3 pt-2">
          <button
            onClick={() => void respond('approve_once')}
            disabled={submitting}
            className="flex items-center justify-center gap-1.5 rounded-md bg-stone-100 px-4 py-2.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-200 disabled:opacity-50"
          >
            <svg
              width="13"
              height="13"
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
            className="flex items-center justify-center gap-1.5 rounded-md bg-stone-100 px-4 py-2.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-200 disabled:opacity-50"
          >
            <svg
              width="13"
              height="13"
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
            className="flex items-center justify-center gap-1.5 rounded-md bg-stone-50 px-4 py-2.5 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-100 disabled:opacity-50"
          >
            <svg
              width="13"
              height="13"
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

          {/* Optional feedback input — below action buttons */}
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="其他"
            className="w-full rounded-md border border-stone-200 px-3 py-1.5 text-xs text-stone-700 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none"
          />
        </div>
      </div>
    </div>
  )
}

export default ToolConfirmDialog
