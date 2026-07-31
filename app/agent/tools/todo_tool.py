"""todo tool -- REST API executor for frontend task operations.

This module provides the execute function for the REST API endpoints
that directly manage tasks in the database. It is NOT exposed as an
LLM tool — TodoWrite is the single LLM-facing todo entry point,
which syncs to the same database internally.
"""

import json
import logging
from app.dao.todo_dao import TodoDAO
from app.db.database import get_session_factory

log = logging.getLogger(__name__)

VALID_STATUSES = ("pending", "in_progress", "completed", "cancelled")


def _to_dict(todo) -> dict:
    return {
        "id": todo.id,
        "content": todo.title,
        "status": todo.status,
        "priority": todo.priority,
        "description": todo.description,
    }


def _summary(items: list[dict]) -> dict:
    counts = {s: 0 for s in VALID_STATUSES}
    for item in items:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    return {"total": len(items), **counts}


# No TOOL_DEF — this module is not an LLM tool.
# Only the execute function is used by the REST API.


async def execute(args_str: str, employee_id: int) -> str:
    args = json.loads(args_str)
    todos_input = args.get("todos", [])
    merge = args.get("merge", False)

    session_factory = get_session_factory()
    dao = TodoDAO(session_factory, employee_id)

    if not todos_input:
        current_todos = await dao.list_todos()
        items = [_to_dict(t) for t in current_todos]
        return json.dumps({
            "todos": items,
            "summary": _summary(items),
        }, ensure_ascii=False)

    if merge:
        existing_todos = await dao.list_todos()
        existing_map = {t.id: t for t in existing_todos}

        for item in todos_input:
            id_ = item.get("id", "")
            content = item.get("content")
            status = item.get("status")

            if id_ in existing_map:
                updates = {}
                if content is not None:
                    updates["title"] = content
                if status is not None:
                    if status in VALID_STATUSES:
                        updates["status"] = status
                if updates:
                    await dao.update(id_, **updates)
            else:
                title = content or "(no description)"
                await dao.create(title=title, priority=0)
    else:
        existing_todos = await dao.list_todos()
        for t in existing_todos:
            await dao.soft_delete(t.id)

        for item in todos_input:
            id_ = item.get("id", "")
            content = item.get("content", "(no description)")
            status = item.get("status", "pending")
            if status not in VALID_STATUSES:
                status = "pending"
            await dao.create(title=content, priority=0)

    current_todos = await dao.list_todos()
    items = [_to_dict(t) for t in current_todos]
    return json.dumps({
        "todos": items,
        "summary": _summary(items),
    }, ensure_ascii=False)