import { create } from 'zustand'
import type { SessionMeta, Message } from '@shared/types'
import { useAgentStore } from './agentStore'
import type { PlanState, ToolCallState, StreamItem } from './agentStore'
import type { PlanStep } from '../../../shared/agent-events'
import { useUIStore } from './uiStore'
import { useSkillStore } from './skillStore'
import { useExpertStore } from './expertStore'

/** Reconstruct agentStore state from persisted messages when switching back
 * to an in-progress session. This ensures plan + thinking cards remain
 * visible after switching away and back, instead of disappearing until the
 * next SSE event arrives. */
function reconstructAgentState(currentRunMessages: Message[]): void {
  // Plan: use the last plan message (most up-to-date steps)
  let plan: PlanState | null = null
  const planMsgs = currentRunMessages.filter((m) => m.type === 'plan')
  if (planMsgs.length > 0) {
    const lastPlan = planMsgs[planMsgs.length - 1]
    try {
      const steps = JSON.parse(lastPlan.content) as PlanStep[]
      const isDone = steps.filter((s) => s.level === 1).every((s) => s.status === 'completed')
      plan = {
        planId: lastPlan.id,
        steps,
        status: isDone ? 'completed' : 'executing'
      }
    } catch {
      /* malformed plan JSON — leave plan null */
    }
  }

  // Thinking: concatenate all thinking messages into one block
  let thinking: {
    content: string
    active: boolean
    startedAt: number | null
    durationMs: number | null
  } | null = null
  const thinkingMsgs = currentRunMessages.filter((m) => m.type === 'thinking')
  if (thinkingMsgs.length > 0) {
    thinking = {
      content: thinkingMsgs.map((m) => m.content).join('\n\n---\n\n'),
      active: false,
      startedAt: null,
      durationMs: null
    }
  }

  // Tool calls: build toolCalls record + order from tool_call messages,
  // then attach results from matching tool_result messages.
  // Also reconstruct expertRunIds for session_spawn tool calls so the
  // "查看执行详情" link survives session switching.
  const toolCalls: Record<string, ToolCallState> = {}
  const toolCallOrder: string[] = []
  const expertRunIds: Record<string, string> = {}
  for (const m of currentRunMessages) {
    if (m.type === 'tool_call' && m.toolCallId) {
      toolCalls[m.toolCallId] = {
        id: m.toolCallId,
        name: m.toolName ?? '',
        args: m.content
      }
      toolCallOrder.push(m.toolCallId)
      if (m.expert?.runId) {
        expertRunIds[m.toolCallId] = m.expert.runId
      }
    }
  }
  for (const m of currentRunMessages) {
    if (m.type === 'tool_result' && m.toolCallId && toolCalls[m.toolCallId]) {
      toolCalls[m.toolCallId].result = m.content
      toolCalls[m.toolCallId].isError = m.isError
    }
  }

  // Stream items: interleave text and tool_call in temporal order
  const streamItems: StreamItem[] = []
  for (const m of currentRunMessages) {
    if (m.type === 'text' && m.role === 'assistant') {
      streamItems.push({ type: 'text', content: m.content })
    } else if (m.type === 'tool_call' && m.toolCallId) {
      streamItems.push({ type: 'tool_call', toolCallId: m.toolCallId })
    }
  }

  useAgentStore.setState({
    isRunning: true,
    plan,
    thinking,
    toolCalls,
    toolCallOrder,
    expertRunIds,
    streamItems,
    userAckMessage: '任务执行中…'
  })
}

interface SessionState {
  sessions: SessionMeta[]
  currentId: string | null
  messages: Message[]
  loadSessions: () => Promise<void>
  selectSession: (id: string) => Promise<void>
  createSession: () => Promise<void>
  deleteSession: (id: string) => Promise<void>
  sendMessage: (
    content: string,
    attachments?: string[],
    skillSlug?: string,
    expertAgentId?: string
  ) => Promise<void>
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  currentId: null,
  messages: [],

  loadSessions: async () => {
    const sessions = await window.api.sessions.list()
    set({ sessions })
  },

  selectSession: async (id) => {
    // Clear any agent state from the previous session
    useAgentStore.getState().clear()
    // Clear selected skill — new session shouldn't inherit previous skill
    useSkillStore.getState().select(null)
    // Clear selected expert — new session shouldn't inherit previous expert
    useExpertStore.getState().select(null)
    // Switch back to chat view when selecting a session
    useUIStore.getState().setView('chat')
    const messages = await window.api.sessions.get(id)
    const active = await window.api.agent.isActive(id)
    if (active) {
      // Session is still running — reconstruct agentStore state from the
      // current run's persisted messages so plan + thinking cards stay
      // visible. Split at the last user text message: everything up to and
      // including it is history (previous runs + this run's prompt);
      // everything after it is the current run's agent output.
      let lastUserIdx = -1
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].type === 'text' && messages[i].role === 'user') {
          lastUserIdx = i
        }
      }
      const preRun = lastUserIdx >= 0 ? messages.slice(0, lastUserIdx + 1) : []
      const currentRun = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages
      set({ currentId: id, messages: preRun })
      reconstructAgentState(currentRun)
    } else {
      set({ currentId: id, messages })
    }
  },

  createSession: async () => {
    // Don't create a backend session yet — just clear the view so the user
    // sees the empty hero input. The session is created on first send.
    useAgentStore.getState().clear()
    useSkillStore.getState().select(null)
    useExpertStore.getState().select(null)
    useUIStore.getState().setView('chat')
    set({ currentId: null, messages: [] })
  },

  deleteSession: async (id) => {
    await window.api.sessions.delete(id)
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id)
      // If deleted session was the current one, clear selection
      const wasCurrent = state.currentId === id
      return {
        sessions,
        currentId: wasCurrent ? null : state.currentId,
        messages: wasCurrent ? [] : state.messages
      }
    })
  },

  sendMessage: async (content, attachments, skillSlug, expertAgentId) => {
    let { currentId } = get()

    // Auto-create a session if none is selected — so the user can just type
    // and press Enter without manually clicking "新建任务" first.
    if (!currentId) {
      const meta = await window.api.sessions.create()
      set((state) => ({
        sessions: [meta, ...state.sessions.filter((s) => s.id !== meta.id)],
        currentId: meta.id,
        messages: []
      }))
      currentId = meta.id
    }

    // Clear skill/expert selection — the selection applies to this message
    // only. The next message starts fresh.
    useSkillStore.getState().select(null)
    useExpertStore.getState().select(null)

    // If agent is running → enqueue instead of running directly
    if (useAgentStore.getState().isRunning) {
      useAgentStore.getState().addToQueue({ content, addedAt: Date.now() })
      await window.api.agent.queue(currentId, content, attachments)
      return
    }

    // Show "已接收" IMMEDIATELY — before any IPC round trips.
    // This avoids the perceived delay while IPC calls (appendMessage, agent.run)
    // traverse to the main process and back.
    useAgentStore.getState().clear()
    useAgentStore.setState({
      isRunning: true,
      userAckMessage: '已接收到您的问题，正在分析处理中…'
    })

    // 1. Append user message to disk + local state
    const msg = await window.api.sessions.appendMessage(currentId, 'user', content, attachments)
    set((state) => ({ messages: [...state.messages, msg] }))

    // 2. Run agent — events flow through onEvent → agentStore.
    //    runAgent will emit stream_start + user_ack again (overwriting the same values).
    await window.api.agent.run(currentId, content, attachments, skillSlug, expertAgentId)

    // 3. If the agent emitted an error, keep it visible — don't clear.
    const agentState = useAgentStore.getState()
    if (agentState.errorMessage) {
      useAgentStore.setState({ isRunning: false })
      const sessions = await window.api.sessions.list()
      set({ sessions })
      return
    }

    // 4. Reload messages from disk (assistant message was persisted by agent-runner)
    const messages = await window.api.sessions.get(currentId)
    set({ messages })

    // 5. Clear agent store — real-time components replaced by persisted message
    useAgentStore.getState().clear()

    // 6. Refresh sidebar (updatedAt / title)
    const sessions = await window.api.sessions.list()
    set({ sessions })
  }
}))
