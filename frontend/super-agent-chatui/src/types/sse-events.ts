export type SSEEventType =
  | "stream_start"
  | "user_ack"
  | "text_delta"
  | "thinking_start"
  | "thinking_delta"
  | "thinking_end"
  | "tool_call_start"
  | "tool_call_delta"
  | "tool_call_end"
  | "tool_result"
  | "delegation_start"
  | "delegation_update"
  | "delegation_end"
  | "message_done"
  | "notification_new"
  | "context_compression"
  | "error"
  | "plan_created"
  | "plan_step_start"
  | "plan_step_complete"
  | "plan_step_failed"
  | "plan_adjusted"
  | "plan_complete"
  | "task_cancelled"
  | "task_queued"
  | "task_steered"
  | "tool_confirm_request";

export interface SSEEventEnvelope {
  type: SSEEventType;
  session_id: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface TextDeltaData { [key: string]: unknown; message_id: string; delta: string }
export interface ThinkingData { [key: string]: unknown; message_id: string; delta: string }
export interface ThinkingStartData { [key: string]: unknown; message_id: string }
export interface ThinkingEndData { [key: string]: unknown; message_id: string }
export interface ToolCallStartData { [key: string]: unknown; tool_call_id: string; tool_name: string; args_preview?: string }
export interface ToolCallDeltaData { [key: string]: unknown; tool_call_id: string; args_delta: string; partial_args?: string }
export interface ToolCallEndData { [key: string]: unknown; tool_call_id: string; tool_name: string; args: string }
export interface ToolResultData { [key: string]: unknown; tool_call_id: string; tool_name: string; result: string; is_error: boolean }
export interface DelegationStartData { [key: string]: unknown; child_session_id: string; subagent_name: string; goal: string; context?: string }
export interface DelegationUpdateData { [key: string]: unknown; child_session_id: string; status: string; progress_note?: string; elapsed_seconds?: number }
export interface DelegationEndData { [key: string]: unknown; child_session_id: string; subagent_name: string; summary: string; is_error: boolean }
export interface MessageDoneData { [key: string]: unknown; message_id: string; role: string; token_count: number; stop_reason?: string }
export interface NotificationNewData { [key: string]: unknown; notification_id: string; title: string; source: string; cron_job_id?: string }
export interface ContextCompressionData { [key: string]: unknown; tokens_before: number; tokens_after: number; compressed_count: number; summary_preview: string }
export interface ErrorData { [key: string]: unknown; error_code: string; message: string; recoverable: boolean }

// Plan-execute-observe-review-adjust cycle
export interface PlanStepData { id: string; description: string }
export interface PlanCreatedData { [key: string]: unknown; plan_id: string; goal: string; steps: PlanStepData[]; max_steps: number }
export interface PlanStepStartData { [key: string]: unknown; plan_id: string; step_index: number; description: string }
export interface PlanStepCompleteData { [key: string]: unknown; plan_id: string; step_index: number; result_summary: string }
export interface PlanStepFailedData { [key: string]: unknown; plan_id: string; step_index: number; error_summary: string; will_adjust: boolean }
export interface PlanAdjustedData { [key: string]: unknown; plan_id: string; reason: string; steps: PlanStepData[]; max_steps: number }
export interface PlanCompleteData { [key: string]: unknown; plan_id: string; summary: string }

// Task lifecycle (cancel / queue / steer)
export interface TaskCancelledData { [key: string]: unknown; run_id: string; reason: string }
export interface TaskQueuedData { [key: string]: unknown; queue_depth: number; mode: string }
export interface TaskSteeredData { [key: string]: unknown; run_id: string; content_preview: string }

// Human-in-the-loop tool confirmation (terminal / code_execute)
export interface ToolConfirmRequestData {
  confirmation_id: string;
  tool_name: string;
  content: string;
  tool_call_id: string;
}

export type SSEEventData =
  | TextDeltaData
  | ThinkingStartData
  | ThinkingData
  | ThinkingEndData
  | ToolCallStartData
  | ToolCallDeltaData
  | ToolCallEndData
  | ToolResultData
  | DelegationStartData
  | DelegationUpdateData
  | DelegationEndData
  | MessageDoneData
  | NotificationNewData
  | ContextCompressionData
  | ErrorData
  | PlanCreatedData
  | PlanStepStartData
  | PlanStepCompleteData
  | PlanStepFailedData
  | PlanAdjustedData
  | PlanCompleteData
  | TaskCancelledData
  | TaskQueuedData
  | TaskSteeredData
  | ToolConfirmRequestData;