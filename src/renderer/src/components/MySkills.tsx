// MySkills — 应用场景 page with three tabs: 技能, 专家, and 记忆.
// 技能 tab lists installed skills with delete + SkillHub.
// 专家 tab lists sub-agent experts from ~/.lucid/subagent/agents/AGENT.md.
// 记忆 tab lists memories from the SQLite memory DB with full CRUD.

import { useState, useEffect } from 'react'
import { useSkillStore } from '../store/skillStore'
import { useUIStore } from '../store/uiStore'
import { useExpertStore } from '../store/expertStore'
import SkillHubModal from './SkillHubModal'
import ExpertTopologyModal from './ExpertTopologyModal'
import type { Memory, MemoryTier, ExtractionTrigger } from '@shared/types'

type Tab = 'skills' | 'experts' | 'memories'

// Human-readable label for extraction trigger values.
const TRIGGER_LABELS: Record<ExtractionTrigger, string> = {
  session_end: '会话结束',
  llm_judgment: 'LLM提取',
  compaction: '压缩',
  manual: '手动'
}

const MEMORY_PAGE_SIZE = 20

function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function MySkills(): React.JSX.Element {
  const skills = useSkillStore((s) => s.skills)
  const load = useSkillStore((s) => s.load)
  const remove = useSkillStore((s) => s.remove)
  const setView = useUIStore((s) => s.setView)
  const selectExpert = useExpertStore((s) => s.select)
  const experts = useExpertStore((s) => s.experts)
  const loadExperts = useExpertStore((s) => s.load)

  const [hubOpen, setHubOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('skills')
  const [topologyAgent, setTopologyAgent] = useState<{
    agentId: string
    name: string
    emoji?: string
  } | null>(null)

  // Memory tab state
  const [memories, setMemories] = useState<Memory[]>([])
  const [editingMemory, setEditingMemory] = useState<{
    mode: 'create' | 'edit'
    memory?: Memory
  } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Memory | null>(null)
  const [detailMemory, setDetailMemory] = useState<Memory | null>(null)
  const [memoryPage, setMemoryPage] = useState(0)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (tab !== 'experts') return
    void loadExperts()
  }, [tab, loadExperts])

  useEffect(() => {
    if (tab !== 'memories') return
    void window.api.memory.list().then(setMemories)
  }, [tab])

  const loadMemories = async (): Promise<void> => {
    const list = await window.api.memory.list()
    setMemories(list)
  }

  const handleDeleteMemory = (m: Memory): void => {
    setDeleteTarget(m)
  }

  const confirmDeleteMemory = async (): Promise<void> => {
    if (!deleteTarget) return
    await window.api.memory.delete(deleteTarget.id)
    const next = memories.filter((x) => x.id !== deleteTarget.id)
    setMemories(next)
    // Clamp page if we deleted the last item on the current page
    const maxPage = Math.max(0, Math.ceil(next.length / MEMORY_PAGE_SIZE) - 1)
    if (memoryPage > maxPage) setMemoryPage(maxPage)
    setDeleteTarget(null)
  }

  const handleSaveMemory = async (content: string, tier: MemoryTier): Promise<void> => {
    if (editingMemory?.mode === 'edit' && editingMemory.memory) {
      await window.api.memory.update(editingMemory.memory.id, content, tier)
    } else {
      await window.api.memory.create(content, tier)
    }
    setEditingMemory(null)
    void loadMemories()
  }

  const handleDelete = async (slug: string, name: string): Promise<void> => {
    if (confirm(`确定删除技能「${name}」？`)) {
      await remove(slug)
    }
  }

  return (
    <div className="flex h-full flex-1 flex-col bg-stone-50">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-stone-200 px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView('chat')}
            className="flex items-center gap-1 text-sm text-stone-500 transition-colors hover:text-stone-700"
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
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            返回
          </button>
          <h1 className="text-lg font-bold text-stone-800">马克战甲</h1>
        </div>
        {tab === 'skills' && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setHubOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-stone-200 px-3 py-1.5 text-sm text-stone-600 transition-colors hover:bg-stone-100"
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
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              去 SkillHub
            </button>
          </div>
        )}
        {tab === 'memories' && (
          <button
            onClick={() => setEditingMemory({ mode: 'create' })}
            className="flex items-center gap-1.5 rounded-lg bg-stone-800 px-3 py-1.5 text-sm text-white transition-colors hover:bg-stone-700"
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
              <path d="M12 5v14M5 12h14" />
            </svg>
            新增记忆
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-stone-200 px-6">
        {(['skills', 'experts', 'memories'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`relative px-4 py-2.5 text-sm transition-colors ${
              tab === t ? 'font-medium text-stone-800' : 'text-stone-500 hover:text-stone-700'
            }`}
          >
            {t === 'skills' ? '技能' : t === 'experts' ? '专家' : '记忆'}
            {tab === t && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-stone-800" />}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {tab === 'skills' ? (
          skills.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-stone-400">
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mb-3"
              >
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              <p className="text-sm">暂无技能</p>
              <p className="mt-1 text-xs">在对话框输入 /skill-creator 创建，或从 SkillHub 安装</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {skills.map((s) => (
                <div
                  key={s.slug}
                  className="flex flex-col rounded-xl border border-stone-200 bg-white shadow-sm transition-shadow hover:shadow-md"
                >
                  {/* Top: emoji + name + source badge */}
                  <div className="flex items-center gap-3 p-4">
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-stone-100 text-2xl">
                      {s.emoji || '★'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-stone-800">
                          {s.name}
                        </span>
                      </div>
                      <div className="mt-0.5">
                        {s.source === 'hub' ? (
                          <span className="inline-flex items-center gap-1 text-xs text-stone-500">
                            <span className="h-1.5 w-1.5 rounded-full bg-stone-400" />
                            SkillHub
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-stone-500">
                            <span className="h-1.5 w-1.5 rounded-full bg-stone-400" />
                            自建
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Middle: description */}
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <div className="rounded-md bg-stone-50 px-3 py-2">
                      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-stone-400">
                        描述
                      </div>
                      <p className="line-clamp-3 text-xs leading-relaxed text-stone-600">
                        {s.description || '—'}
                      </p>
                    </div>
                  </div>

                  {/* Bottom: action buttons */}
                  <div className="flex items-center gap-1 border-t border-stone-100 p-4">
                    <div className="flex-1" />
                    <button
                      onClick={() => void handleDelete(s.slug, s.name)}
                      className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
                      title="删除"
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
                        <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : tab === 'experts' ? (
          experts.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-stone-400">
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mb-3"
              >
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              <p className="text-sm">暂无专家</p>
              <p className="mt-1 text-xs">在 ~/.lucid/subagent/agents/ 下创建 AGENT.md</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {experts.map((e) => (
                <div
                  key={e.agentId}
                  className="flex flex-col rounded-xl border border-stone-200 bg-white shadow-sm transition-shadow hover:shadow-md"
                >
                  <div className="flex items-center gap-3 p-4">
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-stone-100 text-2xl">
                      {e.emoji || '★'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-stone-800">
                          {e.name}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] ${
                            e.type === 'expert_panel'
                              ? 'bg-indigo-100 text-indigo-600'
                              : 'bg-stone-100 text-stone-500'
                          }`}
                        >
                          {e.type === 'expert_panel' ? '专家团' : '单专家'}
                        </span>
                      </div>
                      <div className="mt-0.5">
                        <span className="font-mono text-xs text-stone-400">{e.agentId}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <div className="rounded-md bg-stone-50 px-3 py-2">
                      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-stone-400">
                        描述
                      </div>
                      <p className="line-clamp-3 text-xs leading-relaxed text-stone-600">
                        {e.description || '—'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 border-t border-stone-100 p-4">
                    <div className="flex-1" />
                    {e.type === 'expert_panel' && (
                      <button
                        onClick={() =>
                          setTopologyAgent({ agentId: e.agentId, name: e.name, emoji: e.emoji })
                        }
                        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
                        title="查看调用拓扑图"
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
                          <circle cx="12" cy="5" r="2" />
                          <circle cx="5" cy="19" r="2" />
                          <circle cx="19" cy="19" r="2" />
                          <path d="M12 7v4M12 11l-5 6M12 11l5 6" />
                        </svg>
                        详情
                      </button>
                    )}
                    <button
                      onClick={() => {
                        selectExpert(e.agentId)
                        setView('chat')
                      }}
                      className="flex items-center gap-1.5 rounded-md border border-stone-200 px-3 py-1.5 text-xs text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-800"
                    >
                      使用
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
                        <path d="M5 12h14M12 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : memories.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-stone-400">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mb-3"
            >
              <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm">暂无记忆</p>
            <p className="mt-1 text-xs">点击"新增记忆"手动添加，或在对话中由智能体自动提取</p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {memories
                .slice(memoryPage * MEMORY_PAGE_SIZE, (memoryPage + 1) * MEMORY_PAGE_SIZE)
                .map((m) => {
                  const modified = m.updatedAt !== m.createdAt
                  return (
                    <div
                      key={m.id}
                      className="flex items-start gap-3 rounded-lg border border-stone-200 bg-white px-4 py-3 transition-shadow hover:shadow-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-sm leading-relaxed text-stone-700">
                          {m.content}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-stone-400">
                          <span
                            className={`rounded px-1.5 py-0.5 ${
                              m.tier === 'long'
                                ? 'bg-indigo-100 text-indigo-600'
                                : 'bg-stone-100 text-stone-500'
                            }`}
                          >
                            {m.tier === 'long' ? '长期' : '短期'}
                          </span>
                          <span className="rounded bg-stone-100 px-1.5 py-0.5 text-stone-500">
                            {TRIGGER_LABELS[m.extractionTrigger]}
                          </span>
                          <span>创建: {formatDateTime(m.createdAt)}</span>
                          {modified && (
                            <span className="text-amber-600">
                              修改: {formatDateTime(m.updatedAt)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-1">
                        <button
                          onClick={() => setDetailMemory(m)}
                          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
                          title="查看详情"
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
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        </button>
                        <button
                          onClick={() => setEditingMemory({ mode: 'edit', memory: m })}
                          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
                          title="编辑"
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
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => handleDeleteMemory(m)}
                          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
                          title="删除"
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
                            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  )
                })}
            </div>
            {memories.length > MEMORY_PAGE_SIZE && (
              <div className="mt-4 flex items-center justify-between text-sm text-stone-500">
                <span>
                  共 {memories.length} 条，第 {memoryPage + 1} /{' '}
                  {Math.ceil(memories.length / MEMORY_PAGE_SIZE)} 页
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setMemoryPage((p) => Math.max(0, p - 1))}
                    disabled={memoryPage === 0}
                    className="rounded-md border border-stone-200 px-3 py-1 transition-colors hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    上一页
                  </button>
                  <button
                    onClick={() =>
                      setMemoryPage((p) =>
                        Math.min(Math.ceil(memories.length / MEMORY_PAGE_SIZE) - 1, p + 1)
                      )
                    }
                    disabled={memoryPage >= Math.ceil(memories.length / MEMORY_PAGE_SIZE) - 1}
                    className="rounded-md border border-stone-200 px-3 py-1 transition-colors hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    下一页
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <SkillHubModal open={hubOpen} onClose={() => setHubOpen(false)} />
      {topologyAgent && (
        <ExpertTopologyModal
          agentId={topologyAgent.agentId}
          expertName={topologyAgent.name}
          expertEmoji={topologyAgent.emoji}
          onClose={() => setTopologyAgent(null)}
        />
      )}
      {editingMemory && (
        <MemoryEditModal
          mode={editingMemory.mode}
          memory={editingMemory.memory}
          onClose={() => setEditingMemory(null)}
          onSave={handleSaveMemory}
        />
      )}
      {detailMemory && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setDetailMemory(null)}
        >
          <div
            className="flex max-h-[80vh] w-[600px] max-w-[90vw] flex-col rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-stone-800">记忆详情</h2>
              <button
                onClick={() => setDetailMemory(null)}
                className="text-stone-400 transition-colors hover:text-stone-600"
              >
                ×
              </button>
            </div>
            <div className="mb-4 flex flex-wrap gap-2 text-xs">
              <span
                className={`rounded px-1.5 py-0.5 ${
                  detailMemory.tier === 'long'
                    ? 'bg-indigo-100 text-indigo-600'
                    : 'bg-stone-100 text-stone-500'
                }`}
              >
                {detailMemory.tier === 'long' ? '长期' : '短期'}
              </span>
              <span className="rounded bg-stone-100 px-1.5 py-0.5 text-stone-500">
                {TRIGGER_LABELS[detailMemory.extractionTrigger]}
              </span>
            </div>
            <div className="mb-4 flex-1 overflow-y-auto rounded-lg bg-stone-50 px-4 py-3">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-stone-700">
                {detailMemory.content}
              </p>
            </div>
            <div className="mb-4 grid grid-cols-2 gap-3 border-t border-stone-100 pt-3 text-xs text-stone-400">
              <div>
                <span className="text-stone-500">创建时间</span>
                <p className="mt-0.5 text-stone-600">
                  {new Date(detailMemory.createdAt).toLocaleString('zh-CN')}
                </p>
              </div>
              <div>
                <span className="text-stone-500">修改时间</span>
                <p
                  className={`mt-0.5 ${
                    detailMemory.updatedAt !== detailMemory.createdAt
                      ? 'text-amber-600'
                      : 'text-stone-600'
                  }`}
                >
                  {new Date(detailMemory.updatedAt).toLocaleString('zh-CN')}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setEditingMemory({ mode: 'edit', memory: detailMemory })
                  setDetailMemory(null)
                }}
                className="flex items-center gap-1.5 rounded-lg bg-stone-800 px-4 py-1.5 text-sm text-white transition-colors hover:bg-stone-700"
              >
                编辑
              </button>
              <button
                onClick={() => setDetailMemory(null)}
                className="rounded-lg border border-stone-200 px-4 py-1.5 text-sm text-stone-600 transition-colors hover:bg-stone-100"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="w-[400px] max-w-[90vw] rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-2 text-lg font-bold text-stone-800">删除记忆</h2>
            <p className="mb-4 text-sm text-stone-500">确定删除这条记忆？此操作不可撤销。</p>
            <div className="mb-5 rounded-lg bg-stone-50 px-3 py-2">
              <p className="line-clamp-3 text-sm leading-relaxed text-stone-600">
                {deleteTarget.content}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-stone-200 px-4 py-1.5 text-sm text-stone-600 transition-colors hover:bg-stone-100"
              >
                取消
              </button>
              <button
                onClick={() => void confirmDeleteMemory()}
                className="rounded-lg bg-red-500 px-4 py-1.5 text-sm text-white transition-colors hover:bg-red-600"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MemoryEditModal({
  mode,
  memory,
  onClose,
  onSave
}: {
  mode: 'create' | 'edit'
  memory?: Memory
  onClose: () => void
  onSave: (content: string, tier: MemoryTier) => Promise<void>
}): React.JSX.Element | null {
  const [content, setContent] = useState(memory?.content ?? '')
  const [tier, setTier] = useState<MemoryTier>(memory?.tier ?? 'long')
  const [saving, setSaving] = useState(false)

  const handleSave = async (): Promise<void> => {
    if (!content.trim()) return
    setSaving(true)
    try {
      await onSave(content.trim(), tier)
    } catch (e) {
      console.error('Failed to save memory:', e)
      alert('保存失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex w-[500px] max-w-[90vw] flex-col rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-stone-800">
            {mode === 'create' ? '新增记忆' : '编辑记忆'}
          </h2>
          <button
            onClick={onClose}
            className="text-stone-400 transition-colors hover:text-stone-600"
          >
            ×
          </button>
        </div>

        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="输入记忆内容..."
          autoFocus
          rows={6}
          className="mb-3 w-full resize-none rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-stone-400"
        />

        <div className="mb-4 flex items-center gap-2">
          <span className="text-sm text-stone-500">层级：</span>
          <button
            onClick={() => setTier('short')}
            className={`rounded-lg px-3 py-1 text-sm transition-colors ${
              tier === 'short'
                ? 'bg-stone-800 text-white'
                : 'border border-stone-200 text-stone-600 hover:bg-stone-100'
            }`}
          >
            短期
          </button>
          <button
            onClick={() => setTier('long')}
            className={`rounded-lg px-3 py-1 text-sm transition-colors ${
              tier === 'long'
                ? 'bg-stone-800 text-white'
                : 'border border-stone-200 text-stone-600 hover:bg-stone-100'
            }`}
          >
            长期
          </button>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-stone-200 px-4 py-1.5 text-sm text-stone-600 transition-colors hover:bg-stone-100"
          >
            取消
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={!content.trim() || saving}
            className="rounded-lg bg-stone-800 px-4 py-1.5 text-sm text-white transition-colors hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default MySkills
