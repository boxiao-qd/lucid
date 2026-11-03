// Agent event store — message and plan state management.
// Zustand store that consumes AgentEventEnvelope events from the main process
// via IPC and exposes reactive state to ChatView / PlanCard / ThinkingCard / ToolCallCard.

import { create } from 'zustand'
import type { AgentEventEnvelope, PlanStep, TodoStatus } from '../../../shared/agent-events'

export interface PlanState {
  planId: string
  steps: PlanStep[]
  status: 'executing' | 'completed'
}

export interface ToolCallState {
  id: string
  name: string
  args: string
  result?: string
  isError?: boolean
}

export interface QueueItem {
  content: string
  addedAt: number
  steered?: boolean
}

export interface PendingChoice {
  title: string
  detail: string
}

export interface PendingCommandBlock {
  command: string
  reason?: string
}

export interface PendingConfirmation {
  confirmationId: string
  toolName: string
  toolCallId: string
  content: string
  choices?: PendingChoice[]
  command_blocks?: PendingCommandBlock[]
  purpose?: string
}

export interface CompactionResult {
  tokensBefore: number
  tokensAfter: number
  memoriesExtracted: number
}

/** A temporally-ordered item in the streaming view — either a text segment
 * (LLM narration before/after tool calls) or a tool call reference. This
 * lets ChatView render text and tool calls interleaved, instead of all
 * tool calls grouped together followed by all text. */
export interface StreamItem {
  type: 'text' | 'tool_call'
  /** Text content for 'text' items */
  content?: string
  /** Tool call ID for 'tool_call' items — look up in toolCalls record */
  toolCallId?: string
}

interface AgentState {
  isRunning: boolean
  plan: PlanState | null
  streamingMessageId: string | null
  streamingDelta: string
  thinking: {
    content: string
    active: boolean
    startedAt: number | null
    durationMs: number | null
  } | null
  toolCalls: Record<string, ToolCallState>
  toolCallOrder: string[]
  /** Temporally-ordered list of text segments and tool call IDs — used by
   * ChatView to render narration and tool calls interleaved. */
  streamItems: StreamItem[]
  userAckMessage: string | null
  errorMessage: string | null
  finalContent: string | null
  taskNotice: string | null
  queue: QueueItem[]
  pendingConfirmation: PendingConfirmation | null
  isCompacting: boolean
  compactionResult: CompactionResult | null
  // Maps toolCallId → runId for session_spawn calls. Populated by the
  // expert_run_started event so the real-time ToolCallCard can show
  // "查看执行详情" before the tool finishes executing.
  expertRunIds: Record<string, string>

  handleEvent: (env: AgentEventEnvelope) => void
  clear: () => void
  setTaskNotice: (msg: string) => void
  clearTaskNotice: () => void
  clearPendingConfirmation: () => void
  addToQueue: (item: QueueItem) => void
  removeFromQueue: (content: string) => void
  markQueueItemSteered: (content: string) => void
  clearQueue: () => void
}

export const useAgentStore = create<AgentState>((set, get) => ({
  isRunning: false,
  plan: null,
  streamingMessageId: null,
  streamingDelta: '',
  thinking: null,
  toolCalls: {},
  toolCallOrder: [],
  streamItems: [],
  userAckMessage: null,
  errorMessage: null,
  finalContent: null,
  taskNotice: null,
  queue: [],
  pendingConfirmation: null,
  isCompacting: false,
  compactionResult: null,
  expertRunIds: {},

  setTaskNotice: (msg) => {
    set({ taskNotice: msg })
    setTimeout(() => get().clearTaskNotice(), 3000)
  },
  clearTaskNotice: () => set({ taskNotice: null }),
  clearPendingConfirmation: () => set({ pendingConfirmation: null }),
  addToQueue: (item) => set((s) => ({ queue: [...s.queue, item] })),
  removeFromQueue: (content) =>
    set((s) => ({ queue: s.queue.filter((q) => q.content !== content) })),
  markQueueItemSteered: (content) =>
    set((s) => ({
      queue: s.queue.map((q) => (q.content === content ? { ...q, steered: true } : q))
    })),
  clearQueue: () => set({ queue: [] }),

  clear: () =>
    set({
      isRunning: false,
      plan: null,
      streamingMessageId: null,
      streamingDelta: '',
      thinking: null,
      toolCalls: {},
      toolCallOrder: [],
      streamItems: [],
      userAckMessage: null,
      errorMessage: null,
      finalContent: null,
      taskNotice: null,
      queue: [],
      pendingConfirmation: null,
      isCompacting: false,
      compactionResult: null,
      expertRunIds: {}
    }),

  handleEvent: (env) => {
    // Sub-agent events are tagged with agentId by tagEmit. They must NOT
    // affect the main chat's UI state — plan cards, confirmation dialogs,
    // streaming, tool calls, etc. belong to the sub-agent's own ExecutionView.
    // The system-wide overlay (ConfirmOverlay) handles sub-agent confirmations
    // independently. The ExecutionView polls sub-agent session JSONL via IPC
    // for plan data, so no real-time plan events are needed here.
    if (typeof (env.data as { agentId?: unknown })?.agentId === 'string') return
    switch (env.type) {
      case 'stream_start': {
        const data = env.data as { message_id: string }
        set({
          isRunning: true,
          streamingMessageId: data.message_id,
          streamingDelta: '',
          thinking: null,
          toolCalls: {},
          toolCallOrder: [],
          streamItems: [],
          plan: null,
          userAckMessage: null,
          errorMessage: null,
          finalContent: null,
          expertRunIds: {}
        })
        break
      }
      case 'user_ack': {
        const data = env.data as { message: string }
        set({ userAckMessage: data.message })
        break
      }
      case 'text_delta': {
        const data = env.data as { delta: string }
        set((s) => {
          const items = [...s.streamItems]
          const last = items[items.length - 1]
          if (last && last.type === 'text') {
            // Append to existing text segment
            items[items.length - 1] = {
              ...last,
              content: (last.content ?? '') + data.delta
            }
          } else {
            // Start a new text segment after a tool call (or at the start)
            items.push({ type: 'text', content: data.delta })
          }
          return {
            streamingDelta: s.streamingDelta + data.delta,
            streamItems: items
          }
        })
        break
      }
      case 'thinking_start': {
        set({ thinking: { content: '', active: true, startedAt: Date.now(), durationMs: null } })
        break
      }
      case 'thinking_delta': {
        const data = env.data as { delta: string }
        set((s) => ({
          thinking: s.thinking
            ? {
                content: s.thinking.content + data.delta,
                active: s.thinking.active,
                startedAt: s.thinking.startedAt,
                durationMs: s.thinking.durationMs
              }
            : { content: data.delta, active: true, startedAt: Date.now(), durationMs: null }
        }))
        break
      }
      case 'thinking_end': {
        set((s) => ({
          thinking: s.thinking
            ? {
                content: s.thinking.content,
                active: false,
                startedAt: s.thinking.startedAt,
                durationMs: s.thinking.startedAt ? Date.now() - s.thinking.startedAt : null
              }
            : null
        }))
        break
      }
      case 'tool_call_start': {
        const data = env.data as { tool_call_id: string; tool_name: string }
        set((s) => {
          if (s.toolCalls[data.tool_call_id]) return s
          return {
            toolCalls: {
              ...s.toolCalls,
              [data.tool_call_id]: { id: data.tool_call_id, name: data.tool_name, args: '' }
            },
            toolCallOrder: [...s.toolCallOrder, data.tool_call_id],
            streamItems: [...s.streamItems, { type: 'tool_call', toolCallId: data.tool_call_id }]
          }
        })
        break
      }
      case 'tool_call_delta': {
        const data = env.data as { tool_call_id: string; partial_args: string }
        set((s) => {
          const existing = s.toolCalls[data.tool_call_id]
          if (!existing) return s
          return {
            toolCalls: {
              ...s.toolCalls,
              [data.tool_call_id]: { ...existing, args: data.partial_args }
            }
          }
        })
        break
      }
      case 'tool_call_end': {
        const data = env.data as { tool_call_id: string; tool_name: string; args: string }
        set((s) => {
          const existing = s.toolCalls[data.tool_call_id]
          const updated: ToolCallState = {
            id: data.tool_call_id,
            name: data.tool_name,
            args: data.args,
            result: existing?.result,
            isError: existing?.isError
          }
          return {
            toolCalls: { ...s.toolCalls, [data.tool_call_id]: updated },
            toolCallOrder: existing ? s.toolCallOrder : [...s.toolCallOrder, data.tool_call_id]
          }
        })
        break
      }
      case 'tool_result': {
        const data = env.data as {
          tool_call_id: string
          result: string
          is_error: boolean
        }
        set((s) => {
          const existing = s.toolCalls[data.tool_call_id]
          if (!existing) return s
          return {
            toolCalls: {
              ...s.toolCalls,
              [data.tool_call_id]: {
                ...existing,
                result: data.result,
                isError: data.is_error
              }
            }
          }
        })
        break
      }
      case 'plan_created': {
        const data = env.data as { plan_id: string; steps: PlanStep[] }
        set({ plan: { planId: data.plan_id, steps: data.steps, status: 'executing' } })
        break
      }
      case 'plan_adjusted': {
        const data = env.data as { plan_id: string; steps: PlanStep[] }
        set((s) => ({
          plan: s.plan
            ? { ...s.plan, steps: data.steps }
            : { planId: data.plan_id, steps: data.steps, status: 'executing' }
        }))
        break
      }
      case 'plan_step_start': {
        const data = env.data as { step_index: number }
        set((s) => {
          if (!s.plan) return s
          const steps = s.plan.steps.map((step, i) =>
            i === data.step_index ? { ...step, status: 'in_progress' as TodoStatus } : step
          )
          return { plan: { ...s.plan, steps } }
        })
        break
      }
      case 'plan_step_complete': {
        const data = env.data as { step_index: number }
        set((s) => {
          if (!s.plan) return s
          const steps = s.plan.steps.map((step, i) =>
            i === data.step_index ? { ...step, status: 'completed' as TodoStatus } : step
          )
          return { plan: { ...s.plan, steps } }
        })
        break
      }
      case 'plan_complete': {
        set((s) => (s.plan ? { plan: { ...s.plan, status: 'completed' } } : s))
        break
      }
      case 'message_done': {
        const data = env.data as { content: string }
        set({
          isRunning: false,
          finalContent: data.content,
          streamingMessageId: null
        })
        break
      }
      case 'error': {
        const data = env.data as { message: string }
        set({
          isRunning: false,
          errorMessage: data.message,
          streamingMessageId: null
        })
        break
      }
      case 'task_queued': {
        const data = env.data as { queue_depth: number }
        get().setTaskNotice(`已加入队列（第 ${data.queue_depth} 位，排队等待），将在当前任务后执行`)
        break
      }
      case 'task_steered': {
        get().setTaskNotice('信息补充已提交，agent 将结合此信息继续')
        break
      }
      case 'task_cancelled': {
        get().setTaskNotice('任务已取消')
        break
      }
      case 'tool_confirm_request': {
        const data = env.data as {
          confirmation_id: string
          tool_name: string
          tool_call_id: string
          content: string
          choices?: { title: string; detail: string }[]
          command_blocks?: { command: string; reason?: string }[]
          purpose?: string
        }
        set({
          pendingConfirmation: {
            confirmationId: data.confirmation_id,
            toolName: data.tool_name,
            toolCallId: data.tool_call_id,
            content: data.content,
            choices: data.choices,
            command_blocks: data.command_blocks,
            purpose: data.purpose
          }
        })
        break
      }
      case 'tool_confirm_resolved': {
        const data = env.data as { confirmation_id: string }
        set((s) => {
          if (s.pendingConfirmation?.confirmationId === data.confirmation_id) {
            return { pendingConfirmation: null }
          }
          return s
        })
        break
      }
      case 'context_compacting': {
        set({ isCompacting: true, compactionResult: null })
        break
      }
      case 'context_compacted': {
        const data = env.data as {
          tokensBefore: number
          tokensAfter: number
          memoriesExtracted: number
        }
        set({ isCompacting: false, compactionResult: data })
        break
      }
      case 'expert_run_started': {
        const data = env.data as { runId: string; toolCallId: string }
        set((s) => ({
          expertRunIds: { ...s.expertRunIds, [data.toolCallId]: data.runId }
        }))
        break
      }
      default:
        break
    }
  }
}))
