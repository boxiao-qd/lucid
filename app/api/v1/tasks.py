"""Task lifecycle API — cancel, queue, and steer for in-progress agent runs."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from typing import Optional

from app.dependencies import get_employee_id
from app.agent.task_manager import (
    cancel_run,
    enqueue_task,
    has_queued_tasks,
    get_queue,
    get_active_run,
    is_cancel_trigger,
)
from app.sse.event_types import SSEEventType
from app.middleware.error_handler import AppError

router = APIRouter()


class CancelResponse(BaseModel):
    cancelled: bool
    message: str


class QueueRequest(BaseModel):
    content: str
    role: str = "user"
    mode: str = Field(
        default="followup",
        description="Queue mode: steer (inject into current run), followup (run after current), "
        "collect (accumulate, no auto-drain), interrupt (cancel current + run immediately)",
    )


class QueueResponse(BaseModel):
    queued: bool
    mode: str
    queue_depth: int
    message: str


class QueueStatusResponse(BaseModel):
    has_active_run: bool
    is_streaming: bool
    queue_depth: int
    queued_items: list[dict]


@router.post("/sessions/{session_id}/cancel", response_model=CancelResponse)
async def cancel_session_run(
    session_id: str,
    employee_id: int = Depends(get_employee_id),
):
    """Cancel the currently active agent run for a session.

    Sends a cancellation signal to the agent loop. The loop will stop at the
    next safe checkpoint (before the next LLM call or during streaming).
    """
    cancelled = cancel_run(session_id)
    if cancelled:
        from app.api.v1.stream import push_event
        handle = get_active_run(session_id)
        run_id = handle.run_id if handle else "unknown"
        push_event(session_id, SSEEventType.task_cancelled, {
            "run_id": run_id,
            "reason": "user_requested",
        })
        return CancelResponse(cancelled=True, message="Active run cancelled")
    return CancelResponse(cancelled=False, message="No active run to cancel")


@router.post("/sessions/{session_id}/queue", response_model=QueueResponse)
async def queue_session_task(
    session_id: str,
    req: QueueRequest,
    employee_id: int = Depends(get_employee_id),
):
    """Enqueue a task for a session.

    If mode is 'steer' and the session is currently streaming, the content
    is injected into the current run to supplement the LLM with additional info.
    If mode is 'interrupt', the current run is cancelled and this task runs next.
    """
    valid_modes = {"steer", "followup", "collect", "interrupt"}
    if req.mode not in valid_modes:
        raise AppError(
            status_code=400,
            error_code="BX_TASK_4001",
            message=f"Invalid mode '{req.mode}'. Valid modes: {', '.join(sorted(valid_modes))}",
        )

    # Check if content is a cancel trigger — if so, cancel instead of queuing
    if is_cancel_trigger(req.content):
        cancelled = cancel_run(session_id)
        return QueueResponse(
            queued=False,
            mode="cancel",
            queue_depth=len(get_queue(session_id).items),
            message="Cancel triggered — active run cancelled" if cancelled else "No active run to cancel",
        )

    entry = enqueue_task(session_id, req.content, req.role, req.mode)

    from app.api.v1.stream import push_event
    queue = get_queue(session_id)
    push_event(session_id, SSEEventType.task_queued, {
        "queue_depth": len(queue.items),
        "mode": entry.mode,
    })

    if entry.mode == "steer":
        push_event(session_id, SSEEventType.task_steered, {
            "run_id": get_active_run(session_id).run_id if get_active_run(session_id) else "",
            "content_preview": req.content[:100],
        })

    return QueueResponse(
        queued=True,
        mode=entry.mode,
        queue_depth=len(queue.items),
        message=f"Task enqueued with mode '{entry.mode}'",
    )


@router.get("/sessions/{session_id}/queue", response_model=QueueStatusResponse)
async def get_queue_status(
    session_id: str,
    employee_id: int = Depends(get_employee_id),
):
    """Get the current queue and run status for a session."""
    handle = get_active_run(session_id)
    queue = get_queue(session_id)
    return QueueStatusResponse(
        has_active_run=handle is not None,
        is_streaming=handle.is_streaming if handle else False,
        queue_depth=len(queue.items),
        queued_items=[
            {
                "mode": item.mode,
                "role": item.role,
                "content_preview": item.content[:100],
            }
            for item in queue.items
        ],
    )