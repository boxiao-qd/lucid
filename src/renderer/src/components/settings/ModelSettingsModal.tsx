import { useState, useEffect } from 'react'
import type { SettingsConfig, ModelCategory, ModelConfig } from '@shared/types'
import ModelTabPanel from './ModelTabPanel'
import { useSettingsStore } from '../../store/settingsStore'

interface ModelSettingsModalProps {
  onClose: () => void
}

const TABS: { key: ModelCategory; label: string }[] = [
  { key: 'main', label: '主模型设置' },
  { key: 'auxiliary', label: '向量化模型设置' },
  { key: 'multimodal', label: '多模态模型设置' },
  { key: 'imageGen', label: '文生图模型设置' }
]

function ModelSettingsModal({ onClose }: ModelSettingsModalProps): React.JSX.Element | null {
  const [config, setConfig] = useState<SettingsConfig | null>(null)
  const [activeTab, setActiveTab] = useState<ModelCategory>('main')
  const loadModels = useSettingsStore((s) => s.loadModels)

  useEffect(() => {
    window.api.settings.read().then((c) => setConfig(c))
  }, [])

  if (config === null) return null

  const handleTabChange = (category: ModelCategory, models: ModelConfig[]): void => {
    setConfig((prev) => (prev ? { ...prev, [category]: models } : prev))
  }

  const handleSave = async (): Promise<void> => {
    await window.api.settings.write(config)
    await loadModels()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/50">
      <div className="w-full max-w-4xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-stone-200 px-6 py-4">
          <h2 className="text-base font-semibold text-stone-900">模型设置</h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
            aria-label="关闭"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="flex border-b border-stone-200 px-6">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={
                activeTab === tab.key
                  ? 'border-b-2 border-stone-800 px-4 py-2.5 text-sm font-medium text-stone-800'
                  : 'border-b-2 border-transparent px-4 py-2.5 text-sm text-stone-500 transition-colors hover:text-stone-900'
              }
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="max-h-[65vh] overflow-y-auto px-6 py-4">
          <ModelTabPanel
            models={config[activeTab]}
            onChange={(models) => handleTabChange(activeTab, models)}
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-stone-200 px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-stone-300 px-4 py-2 text-sm text-stone-700 transition-colors hover:bg-stone-50"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="rounded-lg bg-stone-800 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-900"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

export default ModelSettingsModal
