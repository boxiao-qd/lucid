import { useState } from 'react'
import type { ModelConfig } from '@shared/types'

interface ModelTabPanelProps {
  models: ModelConfig[]
  onChange: (models: ModelConfig[]) => void
}

type EditableField = 'endpoint' | 'name' | 'apiKey' | 'contextWindow'

// Eye icon for showing/hiding API key
const EyeIcon = ({ open }: { open: boolean }): React.JSX.Element => (
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
    {open ? (
      <>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ) : (
      <>
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </>
    )}
  </svg>
)

function ModelTabPanel({ models, onChange }: ModelTabPanelProps): React.JSX.Element {
  // Track which model IDs have their API key visible
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set())

  const toggleKeyVisible = (id: string): void => {
    setVisibleKeys((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleAdd = (): void => {
    const newModel: ModelConfig = {
      id: crypto.randomUUID(),
      endpoint: '',
      name: '',
      apiKey: '',
      active: false
    }
    onChange([...models, newModel])
  }

  const handleDelete = (id: string): void => {
    onChange(models.filter((m) => m.id !== id))
    setVisibleKeys((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const handleSetActive = (id: string): void => {
    onChange(models.map((m) => ({ ...m, active: m.id === id })))
  }

  const handleFieldChange = (id: string, field: EditableField, value: string): void => {
    if (field === 'contextWindow') {
      const num = parseInt(value, 10)
      onChange(models.map((m) => (m.id === id ? { ...m, contextWindow: isNaN(num) ? 0 : num } : m)))
      return
    }
    onChange(models.map((m) => (m.id === id ? { ...m, [field]: value } : m)))
  }

  return (
    <div className="space-y-3">
      {models.length === 0 && (
        <div className="py-8 text-center text-sm text-stone-400">暂无模型配置</div>
      )}
      {models.map((model) => {
        const showKey = visibleKeys.has(model.id)
        return (
          <div
            key={model.id}
            className={
              'relative rounded-lg border p-4 transition-colors ' +
              (model.active ? 'border-stone-400 bg-stone-50' : 'border-stone-200 bg-white')
            }
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-4 w-4 text-stone-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <rect x="9" y="9" width="6" height="6" />
                  <path d="M9 2v2M9 20v2M15 2v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
                </svg>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-stone-700">
                  <input
                    type="radio"
                    checked={model.active}
                    onChange={() => handleSetActive(model.id)}
                    className="h-4 w-4 text-stone-700 focus:ring-stone-500"
                  />
                  设为默认
                </label>
                {model.active && (
                  <span className="rounded-full bg-stone-700 px-2 py-0.5 text-xs font-medium text-white">
                    当前
                  </span>
                )}
              </div>
              <button
                onClick={() => handleDelete(model.id)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-red-50 hover:text-red-500"
                aria-label="删除"
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
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
                </svg>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-stone-500">模型地址</label>
                <input
                  type="text"
                  value={model.endpoint}
                  onChange={(e) => handleFieldChange(model.id, 'endpoint', e.target.value)}
                  className="w-full rounded-md border border-stone-300 px-3 py-1.5 text-sm outline-none focus:border-stone-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-stone-500">模型名称</label>
                <input
                  type="text"
                  value={model.name}
                  onChange={(e) => handleFieldChange(model.id, 'name', e.target.value)}
                  className="w-full rounded-md border border-stone-300 px-3 py-1.5 text-sm outline-none focus:border-stone-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-stone-500">模型 Key</label>
                <div className="relative">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={model.apiKey}
                    onChange={(e) => handleFieldChange(model.id, 'apiKey', e.target.value)}
                    className="w-full rounded-md border border-stone-300 px-3 py-1.5 pr-9 text-sm outline-none focus:border-stone-500"
                  />
                  <button
                    type="button"
                    onClick={() => toggleKeyVisible(model.id)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-400 transition-colors hover:text-stone-600"
                    aria-label={showKey ? '隐藏 key' : '显示 key'}
                  >
                    <EyeIcon open={showKey} />
                  </button>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-stone-500">
                  上下文窗口（tokens，0 = 不压缩）
                </label>
                <input
                  type="number"
                  value={model.contextWindow ?? 0}
                  onChange={(e) => handleFieldChange(model.id, 'contextWindow', e.target.value)}
                  placeholder="如 32000"
                  className="w-full rounded-md border border-stone-300 px-3 py-1.5 text-sm outline-none focus:border-stone-500"
                />
              </div>
            </div>
          </div>
        )
      })}
      <button
        onClick={handleAdd}
        className="w-full rounded-lg border border-dashed border-stone-300 py-2.5 text-sm text-stone-500 transition-colors hover:bg-stone-50"
      >
        + 添加模型
      </button>
    </div>
  )
}

export default ModelTabPanel
