// ThinkingCard — Hermes-style collapsible reasoning block.
// Auto-expands while streaming (active=true), auto-collapses when done.
// Header shows metadata: 💭 思考中... / 执行思考 · 耗时 · 字数.
// Body uses MarkdownRenderer with italic muted styling, max-h-[4.5rem] scroll.

import { useState, useEffect, useRef } from 'react'
import { useAgentStore } from '../../store/agentStore'
import MarkdownRenderer from '../MarkdownRenderer'

function ThinkingCard(): React.JSX.Element {
  const thinking = useAgentStore((s) => s.thinking)
  const [userOverride, setUserOverride] = useState<boolean | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Reset user override when a new thinking block starts so the
  // default behavior (auto-expand during streaming, auto-collapse
  // when done) takes effect fresh for each block.
  useEffect(() => {
    if (thinking?.active) {
      setUserOverride(null)
    }
  }, [thinking?.active])

  // Auto-scroll to bottom during streaming so the latest content
  // is always visible within the max-height scroll area.
  useEffect(() => {
    if (thinking?.active && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [thinking?.content, thinking?.active])

  if (!thinking || !thinking.content.trim()) return <></>

  // Force-expand during streaming; otherwise use user override or
  // default collapsed.
  const expanded = thinking.active ? true : (userOverride ?? false)

  const charCount = thinking.content.length
  const duration = thinking.durationMs

  return (
    <div className="w-full rounded-lg border border-stone-200 bg-stone-50">
      <button
        onClick={() => setUserOverride(!expanded)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs hover:bg-stone-100"
      >
        <span className="select-none text-stone-400">{expanded ? '▾' : '▸'}</span>
        <span className="text-stone-600">{thinking.active ? '思考中...' : '执行思考'}</span>
        {thinking.active && (
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-stone-500" />
        )}
        {!thinking.active && duration !== null && (
          <span className="text-stone-400">· {(duration / 1000).toFixed(1)}秒</span>
        )}
        <span className="text-stone-400">· {charCount}字</span>
      </button>
      {expanded && (
        <div className="border-t border-stone-200 px-4 py-3">
          <div ref={scrollRef} className="max-h-[4.5rem] overflow-y-auto">
            <MarkdownRenderer
              content={thinking.content}
              className="text-sm leading-relaxed text-stone-500 italic"
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default ThinkingCard
