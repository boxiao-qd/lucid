import { create } from 'zustand'
import type { AgentDefinitionFull } from '@shared/subagent-types'

interface ExpertState {
  experts: AgentDefinitionFull[]
  selectedAgentId: string | null
  load: () => Promise<void>
  select: (agentId: string | null) => void
}

export const useExpertStore = create<ExpertState>((set) => ({
  experts: [],
  selectedAgentId: null,

  load: async () => {
    const experts = await window.api.subagent.listExperts()
    set({ experts })
  },

  select: (agentId) => set({ selectedAgentId: agentId })
}))
