"""Task lifecycle manager — cancel, queue, and steer for in-progress agent runs.

Based on OpenClaw's patterns:
- Cancel: asyncio.Event signal checked by the agent loop; stops streaming + exits
- Queue: per-session in-memory queue with modes (steer, followup, collect, interrupt)
- Steer: inject queued message into currently streaming turn, re-prompting the LLM
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field

log = logging.getLogger(__name__)

# ── Data structures ──────────────────────────────────────────────────────────


@dataclass
class ActiveRunHandle:
    """Tracks a single active agent run for cancel/steer coordination."""

    session_id: str
    run_id: str
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    steer_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=10))
    is_streaming: bool = False
    started_at: float = field(default_factory=time.monotonic)


@dataclass
class QueueEntry:
    """A single queued task waiting to be processed or steered."""

    content: str
    role: str = "user"
    mode: str = "followup"  # steer | followup | collect | interrupt
    created_at: float = field(default_factory=time.monotonic)


@dataclass
class TaskQueue:
    """Per-session queue of pending tasks."""

    session_id: str
    items: list[QueueEntry] = field(default_factory=list)
    draining: bool = False


# ── Global registries ────────────────────────────────────────────────────────

# session_id → ActiveRunHandle
_ACTIVE_RUNS: dict[str, ActiveRunHandle] = {}

# session_id → TaskQueue
_TASK_QUEUES: dict[str, TaskQueue] = {}

# Cancel trigger words — if a new user message is exactly one of these
# (case-insensitive, trimmed), cancel the active run instead of starting a new one.
_CANCEL_TRIGGER_WORDS: frozenset[str] = frozenset({
    "stop", "esc", "abort", "exit", "cancel", "取消", "终止", "停止",
})


# ── Run lifecycle ────────────────────────────────────────────────────────────


def register_run(session_id: str, run_id: str) -> ActiveRunHandle:
    """Register a new active run for a session. Cancels any previous run."""
    _cancel_existing_run(session_id)
    handle = ActiveRunHandle(session_id=session_id, run_id=run_id)
    _ACTIVE_RUNS[session_id] = handle
    log.info("Run registered — session=%s run=%s", session_id[:8], run_id[:8])
    return handle


def unregister_run(session_id: str, run_id: str | None = None) -> None:
    """Remove an active run from the registry."""
    handle = _ACTIVE_RUNS.pop(session_id, None)
    if handle:
        if run_id and handle.run_id != run_id:
            # A different run replaced this one; put it back
            _ACTIVE_RUNS[session_id] = handle
            return
        log.info("Run unregistered — session=%s run=%s", session_id[:8], handle.run_id[:8])


def get_active_run(session_id: str) -> ActiveRunHandle | None:
    """Return the active run handle for a session, if any."""
    return _ACTIVE_RUNS.get(session_id)


def _cancel_existing_run(session_id: str) -> bool:
    """Cancel any existing run for the session. Returns True if there was one."""
    handle = _ACTIVE_RUNS.get(session_id)
    if handle and not handle.cancel_event.is_set():
        handle.cancel_event.set()
        log.info("Run cancelled (replaced) — session=%s run=%s", session_id[:8], handle.run_id[:8])
        return True
    return False


def cancel_run(session_id: str) -> bool:
    """Cancel the active run for a session. Returns True if there was one to cancel."""
    handle = _ACTIVE_RUNS.get(session_id)
    if handle and not handle.cancel_event.is_set():
        handle.cancel_event.set()
        log.info("Run cancelled — session=%s run=%s", session_id[:8], handle.run_id[:8])
        return True
    return False


def is_cancel_trigger(content: str) -> bool:
    """Check if a message content is a cancel trigger word."""
    return content.strip().lower() in _CANCEL_TRIGGER_WORDS


# ── Queue management ─────────────────────────────────────────────────────────


def get_queue(session_id: str) -> TaskQueue:
    """Get or create the task queue for a session."""
    if session_id not in _TASK_QUEUES:
        _TASK_QUEUES[session_id] = TaskQueue(session_id=session_id)
    return _TASK_QUEUES[session_id]


def enqueue_task(
    session_id: str,
    content: str,
    role: str = "user",
    mode: str = "followup",
) -> QueueEntry:
    """Enqueue a task for a session.

    Modes:
    - steer: inject into the currently streaming run (re-prompts LLM)
    - followup: run after the current run completes
    - collect: accumulate; won't auto-drain
    - interrupt: cancel current run, then run this immediately
    """
    entry = QueueEntry(content=content, role=role, mode=mode)
    queue = get_queue(session_id)

    if mode == "interrupt":
        cancel_run(session_id)
        # Insert at front so it runs next
        queue.items.insert(0, entry)
    elif mode == "steer":
        # Dedupe: remove any queued items with the same content so that
        # promoting a queued followup to steer doesn't leave a duplicate.
        queue.items = [i for i in queue.items if i.content != content]
        # Try to steer immediately; if not streaming, enqueue as followup
        steered = _try_steer(session_id, content)
        if not steered:
            entry.mode = "followup"
            queue.items.append(entry)
    else:
        queue.items.append(entry)

    log.info(
        "Task enqueued — session=%s mode=%s queue_depth=%d",
        session_id[:8], entry.mode, len(queue.items),
    )
    return entry


def dequeue_task(session_id: str) -> QueueEntry | None:
    """Dequeue the next task for a session. Returns None if queue is empty."""
    queue = _TASK_QUEUES.get(session_id)
    if not queue or not queue.items:
        return None
    queue.draining = True
    entry = queue.items.pop(0)
    if not queue.items:
        queue.draining = False
    return entry


def has_queued_tasks(session_id: str) -> bool:
    """Check if there are pending tasks in the queue."""
    queue = _TASK_QUEUES.get(session_id)
    return bool(queue and queue.items)


def clear_queue(session_id: str) -> None:
    """Clear all queued tasks for a session."""
    _TASK_QUEUES.pop(session_id, None)


# ── Steer ────────────────────────────────────────────────────────────────────


def _try_steer(session_id: str, content: str) -> bool:
    """Attempt to steer content into the active streaming run.

    Returns True if steer was delivered, False if no active streaming run.
    """
    handle = _ACTIVE_RUNS.get(session_id)
    if not handle or not handle.is_streaming:
        return False
    try:
        handle.steer_queue.put_nowait(content)
        log.info("Steer delivered — session=%s run=%s", session_id[:8], handle.run_id[:8])
        return True
    except asyncio.QueueFull:
        log.warning("Steer queue full — session=%s", session_id[:8])
        return False


def steer_run(session_id: str, content: str) -> bool:
    """Public API: steer content into an active run. Returns True if delivered."""
    return _try_steer(session_id, content)