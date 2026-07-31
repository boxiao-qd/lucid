from enum import Enum
from pydantic import BaseModel
from typing import Optional


class SSEEventType(str, Enum):
    stream_start = "stream_start"
    user_ack = "user_ack"
    text_delta = "text_delta"
    thinking_start = "thinking_start"
    thinking_delta = "thinking_delta"
    thinking_end = "thinking_end"
    tool_call_start = "tool_call_start"
    tool_call_delta = "tool_call_delta"
    tool_call_end = "tool_call_end"
    tool_result = "tool_result"
    delegation_start = "delegation_start"
    delegation_update = "delegation_update"
    delegation_end = "delegation_end"
    message_done = "message_done"
    notification_new = "notification_new"
    context_compression = "context_compression"
    error = "error"
    # Plan-execute-observe-review-adjust cycle
    plan_created = "plan_created"
    plan_step_start = "plan_step_start"
    plan_step_complete = "plan_step_complete"
    plan_step_failed = "plan_step_failed"
    plan_adjusted = "plan_adjusted"
    plan_complete = "plan_complete"
    # Task lifecycle management (cancel/queue/steer)
    task_cancelled = "task_cancelled"
    task_queued = "task_queued"
    task_steered = "task_steered"


class SSEEventEnvelope(BaseModel):
    type: SSEEventType
    session_id: str
    timestamp: float
    data: dict


# Per-event data schemas for structured SSE payloads

class TextDeltaData(BaseModel):
    message_id: str
    delta: str

class ThinkingData(BaseModel):
    message_id: str
    delta: str

class ThinkingEndData(BaseModel):
    message_id: str

class ToolCallStartData(BaseModel):
    tool_call_id: str
    tool_name: str
    args_preview: Optional[str] = None

class ToolCallDeltaData(BaseModel):
    tool_call_id: str
    args_delta: str
    partial_args: Optional[str] = None

class ToolCallEndData(BaseModel):
    tool_call_id: str
    tool_name: str
    args: str

class ToolResultData(BaseModel):
    tool_call_id: str
    tool_name: str
    result: str
    is_error: bool = False

class DelegationStartData(BaseModel):
    child_session_id: str
    subagent_name: str
    goal: str
    context: Optional[str] = None

class DelegationUpdateData(BaseModel):
    child_session_id: str
    status: str
    progress_note: Optional[str] = None
    elapsed_seconds: Optional[int] = None

class DelegationEndData(BaseModel):
    child_session_id: str
    subagent_name: str
    summary: str
    is_error: bool = False

class MessageDoneData(BaseModel):
    message_id: str
    role: str
    token_count: int
    stop_reason: Optional[str] = None

class ErrorData(BaseModel):
    error_code: str
    message: str
    recoverable: bool = False

class NotificationNewData(BaseModel):
    notification_id: str
    title: str
    source: str
    cron_job_id: Optional[str] = None
    file_id: Optional[str] = None

class ContextCompressionData(BaseModel):
    tokens_before: int
    tokens_after: int
    compressed_count: int
    summary_preview: str


# ── Plan-execute-observe-review-adjust cycle data schemas ──────────

class PlanStepData(BaseModel):
    id: str
    description: str


class PlanCreatedData(BaseModel):
    plan_id: str
    goal: str
    steps: list[PlanStepData]
    max_steps: int


class PlanStepStartData(BaseModel):
    plan_id: str
    step_index: int
    description: str


class PlanStepCompleteData(BaseModel):
    plan_id: str
    step_index: int
    result_summary: str


class PlanStepFailedData(BaseModel):
    plan_id: str
    step_index: int
    error_summary: str
    will_adjust: bool = False


class PlanAdjustedData(BaseModel):
    plan_id: str
    reason: str
    steps: list[PlanStepData]
    max_steps: int


class PlanCompleteData(BaseModel):
    plan_id: str
    summary: str


# ── Task lifecycle data schemas ─────────────────────────────────────────

class TaskCancelledData(BaseModel):
    run_id: str
    reason: str = "user_requested"


class TaskQueuedData(BaseModel):
    queue_depth: int
    mode: str


class TaskSteeredData(BaseModel):
    run_id: str
    content_preview: str