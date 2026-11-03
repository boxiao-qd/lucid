// SkillSelector — dropdown showing all installed skills.
// User picks one; it sets selectedSlug in skillStore and shows a chip in the input.
// Also has a "管理技能..." link to jump to the MySkills page.

import { useState, useRef, useEffect } from 'react'
import { useSkillStore } from '../store/skillStore'
import { useUIStore } from '../store/uiStore'

function SkillSelector(): React.JSX.Element {
  const skills = useSkillStore((s) => s.skills)
  const selectedSlug = useSkillStore((s) => s.selectedSlug)
  const select = useSkillStore((s) => s.select)
  const setView = useUIStore((s) => s.setView)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

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

  const selectedSkill = skills.find((s) => s.slug === selectedSlug)

  const filtered = query.trim()
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(query.toLowerCase()) ||
          s.description.toLowerCase().includes(query.toLowerCase()) ||
          s.slug.toLowerCase().includes(query.toLowerCase())
      )
    : skills

  const handleSelect = (slug: string | null): void => {
    select(slug)
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
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
        <span className="text-stone-600">{selectedSkill ? selectedSkill.name : '选择技能'}</span>
        <span className="select-none text-stone-400">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-[200px] rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
          {/* Search input */}
          <div className="border-b border-stone-100 px-2 pb-1.5">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索技能..."
              autoFocus
              className="w-full rounded-md px-2 py-1 text-xs outline-none placeholder:text-stone-400"
            />
          </div>

          {/* Skill list */}
          <div className="max-h-[140px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-stone-400">无匹配技能</div>
            ) : (
              filtered.map((s) => (
                <button
                  key={s.slug}
                  onClick={() => handleSelect(s.slug)}
                  className="flex w-full items-start gap-2 px-3 py-1 text-left text-xs hover:bg-stone-50"
                >
                  {s.emoji && <span className="flex-shrink-0">{s.emoji}</span>}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-stone-700" title={s.name}>
                      {s.name}
                    </div>
                    <div className="truncate text-stone-400" title={s.description}>
                      {s.description}
                    </div>
                  </div>
                  {selectedSlug === s.slug && (
                    <span className="flex-shrink-0 text-stone-400">✓</span>
                  )}
                </button>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-stone-100 pt-1">
            {selectedSlug && (
              <button
                onClick={() => handleSelect(null)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-stone-500 hover:bg-stone-50"
              >
                <span>—</span> 无技能
              </button>
            )}
            <button
              onClick={() => {
                setOpen(false)
                setView('skills')
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-stone-500 hover:bg-stone-50"
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
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
              管理技能...
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default SkillSelector
