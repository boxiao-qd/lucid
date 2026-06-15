"""TodoWrite — CC-aligned session task list tool for the agent loop.

The model explicitly calls this tool to create or update its task checklist.
State is stored per-session in-memory. SSE plan events are emitted by
diffing old vs new todos on each call. State is also synced to the DB
for frontend persistence and context_loader consumption.
"""

from __future__ import annotations

import hashlib
import json
import logging

from app.sse.event_types import SSEEventType

log = logging.getLogger(__name__)

# In-memory per-session storage: {session_id: [TodoItem, ...]}
_SESSION_TODOS: dict[str, list[dict]] = {}


def get_session_todos(session_id: str) -> list[dict]:
    """Return current todo list for a session (empty list if none set)."""
    return list(_SESSION_TODOS.get(session_id, []))


def clear_session_todos(session_id: str) -> None:
    """Clear todos for a session (can be called when a new conversation starts)."""
    _SESSION_TODOS.pop(session_id, None)


def todo_summary_for_llm(session_id: str) -> str:
    """Return a compact todo progress string suitable for LLM system message injection.

    Shows each task with its current status icon and label, with hierarchy indentation.
    """
    todos = _SESSION_TODOS.get(session_id, [])
    if not todos:
        return ""

    status_icons = {"pending": "○", "in_progress": "◉", "completed": "●"}
    status_labels = {"pending": "待执行", "in_progress": "执行中", "completed": "已完成"}

    lines = ["[当前任务进度]"]
    for t in todos:
        icon = status_icons.get(t["status"], "○")
        label = status_labels.get(t["status"], t["status"])
        indent = "  " * (t.get("level", 1) - 1)
        active = f" — {t['activeForm']}" if t.get("activeForm") and t["status"] == "in_progress" else ""
        lines.append(f"  {indent}{icon} {t['content']} ({label}){active}")

    return "\n".join(lines)


def _make_id(content: str) -> str:
    return hashlib.md5(content.encode()).hexdigest()[:10]


def _todos_to_sse_steps(todos: list[dict]) -> list[dict]:
    return [
        {
            "id": _make_id(t["content"]),
            "content": t["content"],
            "status": t["status"],
            "level": t.get("level", 1),
            "activeForm": t.get("activeForm") or "",
        }
        for t in todos
    ]


_STATUS_ICON = {"pending": "○", "in_progress": "◉", "completed": "●"}
_STATUS_LABEL = {"pending": "待执行", "in_progress": "执行中", "completed": "已完成"}


def _fmt_todo(t: dict, index: int | None = None) -> str:
    icon = _STATUS_ICON.get(t["status"], "?")
    indent = "  " * (t.get("level", 1) - 1)
    prefix = f"{index + 1}. " if index is not None else "  "
    label = _STATUS_LABEL.get(t["status"], t["status"])
    active = f" — {t['activeForm']}" if t.get("activeForm") and t["status"] == "in_progress" else ""
    return f"  {indent}{prefix}{icon} {t['content']} ({label}){active}"


def _fmt_plan(todos: list[dict], title: str) -> str:
    lines = [title]
    for i, t in enumerate(todos):
        lines.append(_fmt_todo(t, i))
    return "\n".join(lines)


def _fmt_diff(old_todos: list[dict], new_todos: list[dict]) -> str:
    """Show what changed between old and new plan."""
    old_by_id = {_make_id(t["content"]): t for t in old_todos}
    new_by_id = {_make_id(t["content"]): t for t in new_todos}
    old_ids = set(old_by_id)
    new_ids = set(new_by_id)

    lines = []
    added = new_ids - old_ids
    removed = old_ids - new_ids
    common = old_ids & new_ids

    for tid in [_make_id(t["content"]) for t in new_todos if _make_id(t["content"]) in added]:
        t = new_by_id[tid]
        lines.append(f"  + 新增: 「{t['content']}」(level={t.get('level', 1)})")
    for tid in [_make_id(t["content"]) for t in old_todos if _make_id(t["content"]) in removed]:
        t = old_by_id[tid]
        lines.append(f"  - 删除: 「{t['content']}」")
    for tid in common:
        old_t = old_by_id[tid]
        new_t = new_by_id[tid]
        if old_t["status"] != new_t["status"]:
            lines.append(f"  ~ 状态变更: 「{new_t['content']}」{old_t['status']} → {new_t['status']}")

    return "\n".join(lines) if lines else "  (步骤列表不变，仅状态更新)"


def _emit(session_id: str, event_type: SSEEventType, data: dict) -> None:
    from app.api.v1.stream import push_event
    push_event(session_id, event_type, data)


def force_complete_todos(session_id: str) -> bool:
    """Auto-complete any remaining pending/in_progress todos and emit plan_complete.

    Called when the LLM produces a final answer without marking all tasks as
    completed — this ensures the frontend always sees the plan finish.

    Returns True if any todos were auto-completed.
    """
    todos = _SESSION_TODOS.get(session_id, [])
    if not todos:
        return False

    if all(t["status"] == "completed" for t in todos):
        return False

    completed_todos = [{**t, "status": "completed"} for t in todos]
    _SESSION_TODOS[session_id] = completed_todos
    _diff_and_emit(session_id, todos, completed_todos)
    return True


def _diff_and_emit(session_id: str, old_todos: list[dict], new_todos: list[dict]) -> None:
    """Compare old vs new todos, emit SSE plan events, and log detailed plan state."""
    sid = session_id[:8]
    old_by_id = {_make_id(t["content"]): t for t in old_todos}
    new_steps = _todos_to_sse_steps(new_todos)

    if not old_todos:
        _emit(session_id, SSEEventType.plan_created, {
            "plan_id": session_id,
            "steps": new_steps,
        })
        log.info("[%s] ┌─ 计划创建 (%d 步)\n%s", sid, len(new_todos),
                 _fmt_plan(new_todos, ""))
    else:
        _emit(session_id, SSEEventType.plan_adjusted, {
            "plan_id": session_id,
            "steps": new_steps,
        })
        diff_str = _fmt_diff(old_todos, new_todos)
        completed = sum(1 for t in new_todos if t["status"] == "completed")
        log.info("[%s] ├─ 计划调整 (%d→%d 步, 已完成%d)\n变更:\n%s\n当前计划:\n%s",
                 sid, len(old_todos), len(new_todos), completed,
                 diff_str,
                 _fmt_plan(new_todos, ""))

    # Emit per-step status change events and log transitions
    for i, new_t in enumerate(new_todos):
        tid = _make_id(new_t["content"])
        old_t = old_by_id.get(tid)
        old_status = old_t["status"] if old_t else "pending"
        new_status = new_t["status"]

        if new_status == "in_progress" and old_status != "in_progress":
            active_form = new_t.get("activeForm") or new_t["content"]
            _emit(session_id, SSEEventType.plan_step_start, {
                "plan_id": session_id,
                "step_index": i,
                "activeForm": active_form,
            })
            log.info("[%s] ├─ 步骤开始 [%d/%d] ◉ 「%s」",
                     sid, i + 1, len(new_todos), active_form)
        elif new_status == "completed" and old_status != "completed":
            _emit(session_id, SSEEventType.plan_step_complete, {
                "plan_id": session_id,
                "step_index": i,
            })
            log.info("[%s] ├─ 步骤完成 [%d/%d] ● 「%s」",
                     sid, i + 1, len(new_todos), new_t["content"])

    # All completed → emit plan_complete
    if new_todos and all(t["status"] == "completed" for t in new_todos):
        _emit(session_id, SSEEventType.plan_complete, {
            "plan_id": session_id,
            "summary": "所有任务已完成",
        })
        total = len(new_todos)
        log.info("[%s] └─ 计划完成 (%d/%d 步全部完成)\n%s",
                 sid, total, total,
                 _fmt_plan(new_todos, ""))


TOOL_DEF = {
    "type": "function",
    "function": {
        "name": "TodoWrite",
        "description": (
            "Use this tool to create and manage your task list for the current session. "
            "Call this BEFORE starting work on complex tasks to create a plan, "
            "and update it each time you complete or start a task. "
            "Each call fully REPLACES the current todo list. "
            "Keep only ONE task in_progress at a time. "
            "Mark tasks completed IMMEDIATELY when done — never leave them in_progress after completion."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "description": "The complete new todo list. Fully replaces the existing list.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {
                                "type": "string",
                                "description": "Task in imperative form, e.g. 'Run unit tests', 'Analyze requirements'",
                            },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed"],
                                "description": "Current task status. Only ONE task may be in_progress at a time.",
                            },
                            "activeForm": {
                                "type": "string",
                                "description": "Present-continuous form shown while running, e.g. 'Running unit tests'",
                            },
                            "level": {
                                "type": "integer",
                                "enum": [1, 2, 3],
                                "description": "Hierarchy depth: 1=main step, 2=sub-step, 3=detail",
                            },
                        },
                        "required": ["content", "status"],
                    },
                },
            },
            "required": ["todos"],
        },
    },
}


async def execute(args_str: str, employee_id: int) -> str:
    """Stub — TodoWrite requires session_id context; dispatched via execute_with_session."""
    return json.dumps({"error": "TodoWrite must be called with session context"}, ensure_ascii=False)


async def execute_with_session(args_str: str, employee_id: int, session_id: str) -> str:
    """Execute a TodoWrite call: validate, update in-memory state, emit SSE events, sync to DB."""
    try:
        args = json.loads(args_str)
    except json.JSONDecodeError as e:
        return json.dumps({"error": f"Invalid JSON: {e}"}, ensure_ascii=False)

    todos_raw = args.get("todos")
    if not isinstance(todos_raw, list):
        return json.dumps({"error": "todos must be an array"}, ensure_ascii=False)

    new_todos: list[dict] = []
    for t in todos_raw:
        if not isinstance(t, dict) or not t.get("content") or not t.get("status"):
            continue
        status = t["status"]
        if status not in ("pending", "in_progress", "completed"):
            status = "pending"
        new_todos.append({
            "content": t["content"],
            "status": status,
            "activeForm": t.get("activeForm") or t["content"],
            "level": max(1, min(3, int(t.get("level", 1)))),
        })

    old_todos = get_session_todos(session_id)

    # Store new state — keep completed todos so agent loop can detect completion
    _SESSION_TODOS[session_id] = new_todos

    # Emit SSE plan events
    try:
        _diff_and_emit(session_id, old_todos, new_todos)
    except Exception as e:
        log.warning("[%s] TodoWrite SSE emit failed: %s", session_id[:8], e)

    # Sync to DB for frontend task list page and context_loader
    try:
        await _sync_to_db(session_id, employee_id, new_todos)
    except Exception as e:
        log.warning("[%s] TodoWrite DB sync failed: %s", session_id[:8], e)

    return (
        "Todos have been successfully. "
        "Ensure that you continue to use the todo list to track your progress. "
        "Please proceed with the current tasks with the current tasks with applicable."
    )


async def _sync_to_db(session_id: str, employee_id: int, todos: list[dict]) -> None:
    """Sync in-memory todos to the database for frontend persistence and context_loader."""
    from app.dao.todo_dao import TodoDAO
    from app.db.database import get_session_factory

    session_factory = get_session_factory()
    dao = TodoDAO(session_factory, employee_id)

    # Soft-delete existing todos for this session
    existing = await dao.list_todos(session_id=session_id)
    for t in existing:
        await dao.soft_delete(t.id)

    # Create new todos matching in-memory state
    for i, t in enumerate(todos):
        await dao.create(
            title=t["content"],
            description=t.get("activeForm"),
            priority=0,
            session_id=session_id,
            sort_order=i,
            status=t["status"],
        )
