import { create } from 'zustand'
import type { Skill } from '@shared/types'

interface SkillState {
  skills: Skill[]
  selectedSlug: string | null
  load: () => Promise<void>
  select: (slug: string | null) => void
  create: (data: {
    name: string
    description: string
    emoji?: string
    content: string
  }) => Promise<Skill>
  update: (
    slug: string,
    data: Partial<{ name: string; description: string; emoji?: string; content: string }>
  ) => Promise<Skill>
  remove: (slug: string) => Promise<void>
  installFromHub: (slug: string) => Promise<Skill>
}

export const useSkillStore = create<SkillState>((set) => ({
  skills: [],
  selectedSlug: null,

  load: async () => {
    const skills = await window.api.skills.list()
    set({ skills })
  },

  select: (slug) => set({ selectedSlug: slug }),

  create: async (data) => {
    const skill = await window.api.skills.create(data)
    set((state) => ({ skills: [skill, ...state.skills] }))
    return skill
  },

  update: async (slug, data) => {
    const skill = await window.api.skills.update(slug, data)
    set((state) => ({
      skills: state.skills.map((s) => (s.slug === slug ? skill : s))
    }))
    return skill
  },

  remove: async (slug) => {
    await window.api.skills.delete(slug)
    set((state) => ({
      skills: state.skills.filter((s) => s.slug !== slug),
      selectedSlug: state.selectedSlug === slug ? null : state.selectedSlug
    }))
  },

  installFromHub: async (slug) => {
    const skill = await window.api.skills.hubInstall(slug)
    set((state) => ({
      skills: [skill, ...state.skills.filter((s) => s.slug !== slug)]
    }))
    return skill
  }
}))
