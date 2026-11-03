// ModelSelector — dropdown showing main models from settings.
// User picks one; it persists to settings.json and becomes the active model
// for the next agent run.

import { useState, useRef, useEffect } from 'react'
import { useSettingsStore } from '../store/settingsStore'

function ModelSelector(): React.JSX.Element {
  const main = useSettingsStore((s) => s.main)
  const selectedModel = useSettingsStore((s) => s.selectedModel)
  const selectModel = useSettingsStore((s) => s.selectModel)

  const [open, setOpen] = useState(false)
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

  const handleSelect = (id: string): void => {
    void selectModel(id)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-stone-500 transition-colors hover:bg-stone-100"
      >
        <span className="text-stone-600">{selectedModel ? selectedModel.name : '选择模型'}</span>
        <span className="select-none text-stone-400">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 min-w-[200px] rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
          {main.map((m) => (
            <button
              key={m.id}
              onClick={() => handleSelect(m.id)}
              className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-stone-700 hover:bg-stone-50"
            >
              <span className="truncate">{m.name}</span>
              {selectedModel?.id === m.id && <span className="ml-2 text-stone-400">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default ModelSelector
