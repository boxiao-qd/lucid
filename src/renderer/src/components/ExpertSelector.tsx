// ExpertSelector — dropdown showing all exposed sub-agent experts.
// User picks one; it sets selectedAgentId in expertStore and shows a chip in
// the input. When an expert is selected, lucid delegates the task via
// session_spawn when the user sends a message.

import { useState, useRef, useEffect } from 'react'
import { useExpertStore } from '../store/expertStore'

function ExpertSelector(): React.JSX.Element {
  const experts = useExpertStore((s) => s.experts)
  const selectedAgentId = useExpertStore((s) => s.selectedAgentId)
  const select = useExpertStore((s) => s.select)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  // Load experts on mount
  useEffect(() => {
    void useExpertStore.getState().load()
  }, [])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const selectedExpert = experts.find((e) => e.agentId === selectedAgentId)

  const filtered = query.trim()
    ? experts.filter(
        (e) =>
          e.name.toLowerCase().includes(query.toLowerCase()) ||
          e.description.toLowerCase().includes(query.toLowerCase()) ||
          e.agentId.toLowerCase().includes(query.toLowerCase())
      )
    : experts

  const handleSelect = (agentId: string | null): void => {
    select(agentId)
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-stone-500 transition-colors hover:bg-stone-100"
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
        >
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        <span className="text-stone-600">
          {selectedExpert ? `${selectedExpert.emoji ?? ''} ${selectedExpert.name}` : '选择专家'}
        </span>
        <span className="select-none text-stone-400">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-[220px] rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
          {/* Search input */}
          <div className="border-b border-stone-100 px-2 pb-1.5">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索专家..."
              autoFocus
              className="w-full rounded-md px-2 py-1 text-xs outline-none placeholder:text-stone-400"
            />
          </div>

          {/* Expert list */}
          <div className="max-h-[160px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-stone-400">无匹配专家</div>
            ) : (
              filtered.map((e) => (
                <button
                  key={e.agentId}
                  onClick={() => handleSelect(e.agentId)}
                  className="flex w-full items-start gap-2 px-3 py-1 text-left text-xs hover:bg-stone-50"
                >
                  {e.emoji && <span className="flex-shrink-0">{e.emoji}</span>}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-stone-700" title={e.name}>
                      {e.name}
                      <span className="ml-1 rounded bg-stone-100 px-1 text-[10px] text-stone-400">
                        {e.type === 'expert_panel' ? '专家团' : '单专家'}
                      </span>
                    </div>
                    <div className="truncate text-stone-400" title={e.description}>
                      {e.description}
                    </div>
                  </div>
                  {selectedAgentId === e.agentId && (
                    <span className="flex-shrink-0 text-stone-400">✓</span>
                  )}
                </button>
              ))
            )}
          </div>

          {/* Footer */}
          {selectedAgentId && (
            <div className="border-t border-stone-100 pt-1">
              <button
                onClick={() => handleSelect(null)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-stone-500 hover:bg-stone-50"
              >
                <span>—</span> 取消选择
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default ExpertSelector
