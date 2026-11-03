// SkillHubModal — search and install skills from the ClawHub registry
// (https://clawhub.ai). Uses the real ClawHub API: search via
// GET /api/v1/search, install via GET /api/v1/skills/{slug}/card.

import { useState, useEffect, useRef } from 'react'
import type { HubSkill } from '@shared/types'
import { useSkillStore } from '../store/skillStore'

interface Props {
  open: boolean
  onClose: () => void
}

function SkillHubModal({ open, onClose }: Props): React.JSX.Element | null {
  const installFromHub = useSkillStore((s) => s.installFromHub)
  const skills = useSkillStore((s) => s.skills)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<HubSkill[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installingSlug, setInstallingSlug] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    // Reset state on open — don't auto-search, just show search prompt
    setQuery('')
    setResults([])
    setError(null)
    setLoading(false)
  }, [open])

  const doSearch = async (q: string): Promise<void> => {
    if (!q.trim()) {
      setResults([])
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await window.api.skills.hubSearch(q)
      setResults(res)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(`搜索失败：${msg}`)
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  const handleQueryChange = (q: string): void => {
    setQuery(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => void doSearch(q), 300)
  }

  const handleInstall = async (slug: string): Promise<void> => {
    setInstallingSlug(slug)
    try {
      await installFromHub(slug)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(`安装失败：${msg}`)
    } finally {
      setInstallingSlug(null)
    }
  }

  if (!open) return null

  const installedSlugs = new Set(skills.map((s) => s.slug))

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-[600px] flex-col rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-stone-800">SkillHub</h2>
          <button
            onClick={onClose}
            className="text-stone-400 transition-colors hover:text-stone-600"
          >
            ×
          </button>
        </div>

        <input
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="搜索 ClawHub 技能..."
          autoFocus
          className="mb-3 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-stone-400"
        />

        <div className="flex-1 space-y-2 overflow-y-auto">
          {error ? (
            <div className="py-8 text-center text-sm text-red-500">{error}</div>
          ) : loading ? (
            <div className="py-8 text-center text-sm text-stone-400">搜索中...</div>
          ) : results.length === 0 ? (
            <div className="py-8 text-center text-sm text-stone-400">
              {query.trim() ? '无匹配技能' : '输入关键词搜索 ClawHub 技能'}
            </div>
          ) : (
            results.map((s) => {
              const installed = installedSlugs.has(s.slug)
              return (
                <div
                  key={s.slug}
                  className="flex items-start gap-3 rounded-lg border border-stone-100 p-3"
                >
                  {s.emoji && <span className="text-xl">{s.emoji}</span>}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-stone-800">{s.name}</div>
                    <div className="truncate text-xs text-stone-500">{s.description}</div>
                  </div>
                  <button
                    onClick={() => void handleInstall(s.slug)}
                    disabled={installed || installingSlug === s.slug}
                    className="flex-shrink-0 rounded-lg px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed"
                    style={{
                      backgroundColor: installed ? '#f5f5f4' : '#1c1917',
                      color: installed ? '#a8a29e' : '#ffffff'
                    }}
                  >
                    {installed ? '已安装' : installingSlug === s.slug ? '安装中...' : '安装'}
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

export default SkillHubModal
export type { Props as SkillHubModalProps }
