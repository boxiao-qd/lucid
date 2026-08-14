from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
import asyncio
import json
import logging
import time
from collections import deque
from app.dependencies import get_employee_id, get_db_session
from app.db.database import get_session_factory
from app.dao.session_dao import SessionDAO
from app.config import settings
from app.middleware.error_handler import AppError
from app.sse.event_types import SSEEventType

log = logging.getLogger(__name__)

router = APIRouter()

# Active SSE connections per session
_active_connections: dict[str, asyncio.Queue] = {}
# Active SSE connections per user (for notification push) — list of queues for multi-tab support
_user_connections: dict[int, list[asyncio.Queue]] = {}

# Per-session event replay buffer: stores state-change events so SSE reconnects
# can catch up. Delta events (text_delta, thinking_delta) are excluded — they
# accumulate unboundedly and would produce duplicate content on replay.
_event_buffer: dict[str, deque] = {}
_BUFFER_MAX = 200         # max events kept per session
_BUFFER_TTL = 300.0       # seconds; events older than this are not replayed

# Events worth buffering (state snapshots). Delta / streaming events are excluded.
_BUFFERED_EVENTS = {
    SSEEventType.stream_start,
    SSEEventType.user_ack,
    SSEEventType.tool_call_start,
    SSEEventType.tool_call_end,
    SSEEventType.tool_result,
    SSEEventType.thinking_start,
    SSEEventType.thinking_end,
    SSEEventType.plan_created,
    SSEEventType.plan_adjusted,
    SSEEventType.plan_step_start,
    SSEEventType.plan_step_complete,
    SSEEventType.plan_complete,
    SSEEventType.delegation_start,
    SSEEventType.delegation_update,
    SSEEventType.delegation_end,
    SSEEventType.context_compression,
    SSEEventType.message_done,
    SSEEventType.error,
    SSEEventType.tool_confirm_request,
}

# Events whose loss must be logged at WARNING level (everything else → DEBUG).
_CRITICAL_EVENTS = {
    SSEEventType.message_done,
    SSEEventType.error,
}


def _buffer_event(session_id: str, event: dict) -> None:
    if session_id not in _event_buffer:
        _event_buffer[session_id] = deque(maxlen=_BUFFER_MAX)
    _event_buffer[session_id].append((time.monotonic(), event))


def _clear_buffer(session_id: str) -> None:
    _event_buffer.pop(session_id, None)


def _replay_buffer(session_id: str, queue: asyncio.Queue) -> int:
    """Drain buffered events into queue; skip stale ones. Returns count replayed."""
    buf = _event_buffer.get(session_id)
    if not buf:
        return 0
    now = time.monotonic()
    replayed = 0
    for ts, event in buf:
        if now - ts > _BUFFER_TTL:
            continue
        try:
            queue.put_nowait(event)
            replayed += 1
        except asyncio.QueueFull:
            break
    return replayed


# ── /stream/notifications MUST be registered BEFORE /stream/{session_id} ──
# Otherwise {session_id} captures "notifications" as a path parameter.


@router.get("/stream/notifications")
async def stream_notifications(
    employee_id: int = Depends(get_employee_id),
):
    """Global SSE stream for notification events — not tied to any session."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)

    if employee_id not in _user_connections:
        _user_connections[employee_id] = []
    _user_connections[employee_id].append(queue)

    log.info("SSE notifications connected — user=%d", employee_id)

    async def event_generator():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(
                        queue.get(),
                        timeout=settings.sse_keepalive_interval_seconds,
                    )
                    yield f"event: {event['type']}\ndata: {json.dumps(event['data'], ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            user_queues = _user_connections.get(employee_id)
            if user_queues:
                try:
                    user_queues.remove(queue)
                except ValueError:
                    pass
                if not user_queues:
                    _user_connections.pop(employee_id, None)
            log.info("SSE notifications disconnected — user=%d", employee_id)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/stream/{session_id}")
async def stream_sse(
    session_id: str,
    employee_id: int = Depends(get_employee_id),
    db: AsyncSession = Depends(get_db_session),
):
    # Validate session ownership
    dao = SessionDAO(get_session_factory(), employee_id)
    await dao.get_by_id(session_id)  # Will raise 404 if not found or not owned

    queue: asyncio.Queue = asyncio.Queue(maxsize=500)
    _active_connections[session_id] = queue
    # Also register user-level connection for notification push (multi-tab support)
    if employee_id not in _user_connections:
        _user_connections[employee_id] = []
    _user_connections[employee_id].append(queue)

    # Replay any buffered events from before this connection (handles reconnect gaps)
    replayed = _replay_buffer(session_id, queue)
    log.info("SSE connected — session=%s user=%s replayed=%d active_sessions=%s",
             session_id[:8], employee_id, replayed, list(_active_connections.keys()))

    async def event_generator():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=settings.sse_keepalive_interval_seconds)
                    yield f"event: {event['type']}\ndata: {json.dumps(event['data'], ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            # Guard: only remove if we are still the active queue.
            # A concurrent reconnect may have already registered a new queue;
            # removing it would silently drop all subsequent events.
            if _active_connections.get(session_id) is queue:
                _active_connections.pop(session_id, None)
            # Remove from user connections list
            user_queues = _user_connections.get(employee_id)
            if user_queues:
                try:
                    user_queues.remove(queue)
                except ValueError:
                    pass
                if not user_queues:
                    _user_connections.pop(employee_id, None)
            log.info("SSE disconnected — session=%s user=%s", session_id[:8], employee_id)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def push_event(session_id: str, event_type: SSEEventType, data: dict):
    """Push an SSE event to the active connection for a session.

    State events are also buffered so SSE reconnects can replay missed updates.
    Delta events (text_delta etc.) are not buffered to avoid duplicate content.
    """
    event = {"type": event_type.value, "data": data}

    # Buffer state-change events for reconnect replay.
    # Clear on stream_start (new turn begins) so the previous turn's events — including
    # message_done with full content — remain replayable until the next turn starts.
    if event_type == SSEEventType.stream_start:
        _clear_buffer(session_id)
    if event_type in _BUFFERED_EVENTS:
        _buffer_event(session_id, event)

    queue = _active_connections.get(session_id)
    if queue:
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            log.warning("push_event queue full — session=%s event=%s",
                        session_id[:8], event_type.value)
    else:
        # No active connection: event is already buffered above for replay on reconnect.
        if event_type in _CRITICAL_EVENTS:
            log.warning("push_event buffered (no queue, critical) — session=%s event=%s",
                        session_id[:8], event_type.value)
        else:
            log.debug("push_event buffered (no queue) — session=%s event=%s",
                      session_id[:8], event_type.value)


def push_user_event(employee_id: int, event_type: SSEEventType, data: dict):
    """Push an SSE event to all active connections for a user (multi-tab support)."""
    queues = _user_connections.get(employee_id, [])
    event = {"type": event_type.value, "data": data}
    for queue in queues:
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            log.warning("push_user_event queue full — user=%d event=%s",
                        employee_id, event_type.value)