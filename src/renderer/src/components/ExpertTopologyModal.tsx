// ExpertTopologyModal — shows the call topology graph for an expert panel.
// Displays the leader at the top, members below, connected by lines.
// Only shown for expert_panel type experts (multi-node).

import { useState, useEffect, useCallback } from 'react'
import type { AgentGraph, AgentDefinitionFull } from '../../../shared/subagent-types'

interface ExpertTopologyModalProps {
  agentId: string
  expertName: string
  expertEmoji?: string
  onClose: () => void
}

interface NodeInfo {
  agentId: string
  role: 'leader' | 'member'
  def: AgentDefinitionFull | null
}

export default function ExpertTopologyModal({
  agentId,
  expertName,
  expertEmoji,
  onClose
}: ExpertTopologyModalProps): React.JSX.Element {
  const [graph, setGraph] = useState<AgentGraph | null>(null)
  const [nodes, setNodes] = useState<NodeInfo[]>([])
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async (): Promise<void> => {
    const g = await window.api.subagent.getGraph(agentId)
    setGraph(g)
    if (g) {
      const details = await Promise.all(
        g.nodes.map(async (n) => {
          const def = await window.api.subagent.getExpert(n.agentId)
          return { agentId: n.agentId, role: n.role, def }
        })
      )
      setNodes(details)
    }
    setLoading(false)
  }, [agentId])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const leader = nodes.find((n) => n.role === 'leader')
  const members = nodes.filter((n) => n.role === 'member')
  const mode = graph?.execution.mode === 'concurrent' ? '并行' : '串行'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-stone-200 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{expertEmoji || '◆'}</span>
            <div>
              <h2 className="text-base font-bold text-stone-800">{expertName}</h2>
              <p className="text-xs text-stone-400">调用拓扑图</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {graph && (
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  mode === '并行' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'
                }`}
              >
                {mode}执行
              </span>
            )}
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
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
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body — topology graph */}
        <div className="flex-1 overflow-auto px-6 py-8">
          {loading ? (
            <div className="flex h-48 items-center justify-center text-sm text-stone-400">
              加载中…
            </div>
          ) : !graph ? (
            <div className="flex h-48 items-center justify-center text-sm text-stone-400">
              未找到图谱定义
            </div>
          ) : (
            <div className="flex flex-col items-center">
              {/* Leader node */}
              {leader && (
                <div className="flex flex-col items-center">
                  <NodeCard node={leader} highlight />
                </div>
              )}

              {/* Connector: vertical line from leader down to horizontal bar */}
              {members.length > 0 && (
                <div className="relative flex w-full justify-center">
                  {/* Vertical line from leader */}
                  <div className="h-8 w-px bg-stone-300" />
                </div>
              )}

              {/* Horizontal connector bar + member nodes */}
              {members.length > 0 && (
                <div className="relative">
                  {/* Horizontal bar — spans from first member center to last member center */}
                  {members.length > 1 && (
                    <div
                      className="absolute top-0 h-px bg-stone-300"
                      style={{
                        left: `${100 / members.length / 2}%`,
                        right: `${100 / members.length / 2}%`
                      }}
                    />
                  )}
                  {/* Member nodes */}
                  <div className="flex w-max gap-4">
                    {members.map((m) => (
                      <div key={m.agentId} className="flex flex-shrink-0 flex-col items-center">
                        {/* Vertical line from horizontal bar down to member */}
                        <div className="h-8 w-px bg-stone-300" />
                        <NodeCard node={m} />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Execution order hint for serial mode */}
              {graph.execution.mode === 'serial' && members.length > 1 && (
                <p className="mt-6 text-xs text-stone-400">
                  串行执行：成员按上述顺序依次执行，后一个成员可读取前一个成员的产物
                </p>
              )}
              {graph.execution.mode === 'concurrent' && members.length > 1 && (
                <p className="mt-6 text-xs text-stone-400">并行执行：所有成员同时执行，互不依赖</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** A single node card in the topology graph. */
function NodeCard({
  node,
  highlight = false
}: {
  node: NodeInfo
  highlight?: boolean
}): React.JSX.Element {
  const name = node.def?.name ?? node.agentId
  const emoji = node.def?.emoji ?? (node.role === 'leader' ? '👑' : '·')
  const description = node.def?.description

  return (
    <div
      className={`flex w-32 flex-col items-center rounded-xl border p-3 ${
        highlight ? 'border-indigo-200 bg-indigo-50/50' : 'border-stone-200 bg-white'
      }`}
    >
      <div
        className={`flex h-10 w-10 items-center justify-center rounded-lg text-xl ${
          highlight ? 'bg-indigo-100' : 'bg-stone-100'
        }`}
      >
        {emoji}
      </div>
      <span className="mt-2 text-xs font-semibold text-stone-800">{name}</span>
      <span
        className={`mt-0.5 rounded px-1.5 py-0.5 text-[10px] ${
          highlight ? 'bg-indigo-100 text-indigo-600' : 'bg-stone-100 text-stone-500'
        }`}
      >
        {node.role === 'leader' ? 'Leader' : 'Member'}
      </span>
      {description && (
        <p className="mt-1.5 line-clamp-2 text-center text-[10px] leading-relaxed text-stone-400">
          {description}
        </p>
      )}
    </div>
  )
}
