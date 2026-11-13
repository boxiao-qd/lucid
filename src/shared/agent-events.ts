// Agent event protocol — event types for SSE streaming.
// Transported over Electron IPC (agent:event channel) instead of HTTP SSE.

export type AgentEventType =
  | 'stream_start'
  | 'user_ack'
  | 'text_delta'
  | 'thinking_start'
  | 'thinking_delta'
  | 'thinking_end'
  | 'tool_call_start'
  | 'tool_call_delta'
  | 'tool_call_end'
  | 'tool_result'
  | 'plan_created'
  | 'plan_adjusted'
  | 'plan_step_start'
  | 'plan_step_complete'
  | 'plan_complete'
  | 'message_done'
  | 'error'
  | 'task_queued'
  | 'task_steered'
  | 'task_cancelled'
  | 'user_message_added'
  | 'tool_confirm_request'
  | 'tool_confirm_resolved'
  | 'context_compacting'
  | 'context_compacted'
  | 'expert_run_started'
  | 'browser_open'
  | 'browser_closed'

export interface AgentEventEnvelope {
  type: AgentEventType
  sessionId: string
  timestamp: number
  data: Record<string, unknown>
}

// --- Plan step ---

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface PlanStep {
  id: string
  content: string
  status: TodoStatus
  level: number
  activeForm?: string
}

// --- Per-event data shapes (renderer casts envelope.data to these) ---

export interface StreamStartData {
  message_id: string
}
export interface UserAckData {
  message_id: string
  message: string
}
export interface TextDeltaData {
  message_id: string
  delta: string
}
export interface ThinkingData {
  message_id: string
  delta: string
}
export interface ThinkingEndData {
  message_id: string
}
export interface ToolCallStartData {
  tool_call_id: string
  tool_name: string
  args_preview?: string
}
export interface ToolCallDeltaData {
  tool_call_id: string
  args_delta: string
  partial_args?: string
}
export interface ToolCallEndData {
  tool_call_id: string
  tool_name: string
  args: string
}
export interface ToolResultData {
  tool_call_id: string
  tool_name: string
  result: string
  is_error: boolean
}
export interface PlanCreatedData {
  plan_id: string
  steps: PlanStep[]
}
export interface PlanAdjustedData {
  plan_id: string
  steps: PlanStep[]
}
export interface PlanStepStartData {
  plan_id: string
  step_index: number
  activeForm: string
}
export interface PlanStepCompleteData {
  plan_id: string
  step_index: number
}
export interface PlanCompleteData {
  plan_id: string
  summary: string
}
export interface MessageDoneData {
  message_id: string
  role: 'user' | 'assistant'
  content: string
  token_count: number
  stop_reason?: string
}
export interface ErrorData {
  error_code: string
  message: string
  recoverable?: boolean
}
export interface TaskQueuedData {
  queue_depth: number
  mode: 'followup'
  content_preview: string
}
export interface TaskSteeredData {
  run_id: string
  content_preview: string
}
export interface TaskCancelledData {
  run_id: string
  reason: string
}
export interface UserMessageAddedData {
  id: string
  role: 'user'
  content: string
  createdAt: number
}
export interface ToolConfirmChoice {
  title: string
  detail: string
}

export interface ToolConfirmCommandBlock {
  command: string
  reason?: string
}

export interface ToolConfirmData {
  confirmation_id: string
  tool_name: string
  tool_call_id: string
  content: string
  choices?: ToolConfirmChoice[]
  command_blocks?: ToolConfirmCommandBlock[]
  purpose?: string
}
export interface ContextCompactingData {
  message: string
}
export interface ContextCompactedData {
  tokensBefore: number
  tokensAfter: number
  memoriesExtracted: number
}
export interface ExpertRunStartedData {
  runId: string
  toolCallId: string
  expertAgentId: string
  expertName: string
}
export interface BrowserOpenData {
  sessionId: string
}
export interface BrowserClosedData {
  sessionId: string
}
