"""Human-in-the-loop confirmation for terminal/code_execute tools.

When the agent calls terminal or code_execute, this module pauses the agent loop
and sends an SSE event to the frontend requesting user confirmation. The user has
4 options: approve_once, approve_session, reject, or provide custom feedback.

Cron sessions bypass confirmation entirely (the user pre-authorized the cron job).
Child sessions inherit the parent session's approval set (the user can't see the
child's SSE stream, so independent confirmation would time out).
"""

import asyncio
import json
import logging
import uuid

log = logging.getLogger(__name__)

# Session-level approval set: {session_id: {"terminal", "code_execute"}}
_SESSION_APPROVALS: dict[str, set[str]] = {}

# Pending confirmation requests: {confirmation_id: {"future", "session_id", "tool_name", "tool_call_id"}}
_PENDING_CONFIRMATIONS: dict[str, dict] = {}

# 5-minute timeout — auto-reject if user doesn't respond.
_CONFIRM_TIMEOUT = 300


def is_tool_approved(session_id: str, tool_name: str) -> bool:
    return tool_name in _SESSION_APPROVALS.get(session_id, set())


def approve_tool_for_session(session_id: str, tool_name: str) -> None:
    _SESSION_APPROVALS.setdefault(session_id, set()).add(tool_name)


def inherit_parent_approvals(child_session_id: str, parent_session_id: str) -> None:
    """Child session inherits parent session's approval set."""
    parent = _SESSION_APPROVALS.get(parent_session_id, set())
    if parent:
        _SESSION_APPROVALS.setdefault(child_session_id, set()).update(parent)


def clear_session_approvals(session_id: str) -> None:
    """Clean up approvals and any pending confirmations when a session ends."""
    _SESSION_APPROVALS.pop(session_id, None)
    stale = [cid for cid, entry in _PENDING_CONFIRMATIONS.items() if entry["session_id"] == session_id]
    for cid in stale:
        entry = _PENDING_CONFIRMATIONS.pop(cid, None)
        if entry and not entry["future"].done():
            entry["future"].set_result({"action": "timeout"})


async def request_confirmation(session_id: str, tool_name: str,
                               content: str, tool_call_id: str) -> dict:
    """Pause the agent loop and wait for user confirmation via SSE.

    Returns a dict with "action" (approve_once|approve_session|reject|custom|timeout)
    and optionally "text" (for custom feedback).
    """
    confirmation_id = f"cf-{uuid.uuid4().hex[:12]}"
    future: asyncio.Future = asyncio.get_event_loop().create_future()
    _PENDING_CONFIRMATIONS[confirmation_id] = {
        "future": future,
        "session_id": session_id,
        "tool_name": tool_name,
        "tool_call_id": tool_call_id,
    }

    # Lazy import to avoid pulling fastapi into the tools layer at module load time
    from app.api.v1.stream import push_event
    from app.sse.event_types import SSEEventType

    push_event(session_id, SSEEventType.tool_confirm_request, {
        "confirmation_id": confirmation_id,
        "tool_name": tool_name,
        "content": content,
        "tool_call_id": tool_call_id,
    })

    try:
        return await asyncio.wait_for(future, timeout=_CONFIRM_TIMEOUT)
    except asyncio.TimeoutError:
        _PENDING_CONFIRMATIONS.pop(confirmation_id, None)
        return {"action": "timeout"}


def resolve_confirmation(confirmation_id: str, action: str, text: str = "") -> bool:
    """Called by the API endpoint when the user submits their decision.

    Returns True if the confirmation was found and resolved, False if expired/invalid.
    """
    entry = _PENDING_CONFIRMATIONS.pop(confirmation_id, None)
    if not entry or entry["future"].done():
        return False
    entry["future"].set_result({"action": action, "text": text})
    return True


def _format_confirmation_content(tool_name: str, args_str: str) -> str:
    """Extract human-readable command/code from tool args for the confirmation UI."""
    try:
        args = json.loads(args_str)
    except (json.JSONDecodeError, TypeError):
        return f"[{tool_name}] {args_str[:500]}"

    if tool_name == "terminal":
        command = args.get("command", "")
        workdir = args.get("workdir", "")
        header = f"[terminal] 命令：\n{command}"
        if workdir:
            header += f"\n（工作目录：{workdir}）"
        return header

    if tool_name == "code_execute":
        language = args.get("language", "unknown")
        code = args.get("code", "")
        return f"[code_execute] 语言：{language}\n代码：\n{code}"

    return f"[{tool_name}] {args_str[:500]}"
