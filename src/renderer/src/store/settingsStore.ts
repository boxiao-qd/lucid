import { create } from 'zustand'
import type { ModelConfig, SecurityMode } from '@shared/types'

interface SettingsState {
  main: ModelConfig[]
  selectedModel: ModelConfig | null
  securityMode: SecurityMode
  loadModels: () => Promise<void>
  selectModel: (id: string) => Promise<void>
  setSecurityMode: (mode: SecurityMode) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  main: [],
  selectedModel: null,
  securityMode: 'safe',

  loadModels: async () => {
    const config = await window.api.settings.read()
    const selected = config.main.find((m) => m.active) ?? null
    set({
      main: config.main,
      selectedModel: selected,
      securityMode: config.securityMode ?? 'safe'
    })
  },

  selectModel: async (id) => {
    const config = await window.api.settings.setActiveModel('main', id)
    const selected = config.main.find((m) => m.active) ?? null
    set({ main: config.main, selectedModel: selected })
  },

  setSecurityMode: async (mode) => {
    await window.api.settings.setSecurityMode(mode)
    set({ securityMode: mode })
  }
}))
