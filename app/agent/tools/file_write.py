"""file_write tool — write content to file with path enforcement."""

import json
import os
from pathlib import Path

from app.agent.tools.saas_path_guard import _check_write_allowed, WRITE_DENIED_MSG


def _validate_write_path(path: str) -> Path:
    real = os.path.realpath(path)
    return Path(real)


TOOL_DEF = {
    "type": "function",
    "function": {
        "name": "file_write",
        "description": (
            "Write content to a file. Writable path: tmp-doc/ only. "
            "Writing to /tmp/, /var/tmp/, or arbitrary paths outside tmp-doc/ is blocked. "
            "Use the task work directory under tmp-doc/ for intermediate files."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute file path inside tmp-doc/"},
                "content": {"type": "string", "description": "Content to write"},
            },
            "required": ["path", "content"],
        },
    },
}


async def execute(args_str: str, employee_id: int) -> str:
    args = json.loads(args_str)
    path = args.get("path", "")
    content = args.get("content", "")

    # Path whitelist check — only tmp-doc/ is writable
    if not _check_write_allowed(path):
        return json.dumps({
            "error": WRITE_DENIED_MSG.format(path=path),
            "tool_name": "file_write",
        }, ensure_ascii=False)

    resolved = _validate_write_path(path)

    # Auto-create parent directories
    if not resolved.exists():
        resolved.parent.mkdir(parents=True, exist_ok=True)

    try:
        with open(resolved, "w", encoding="utf-8") as f:
            f.write(content)
    except PermissionError:
        return json.dumps({"error": f"Permission denied: {path}"}, ensure_ascii=False)

    return json.dumps({
        "path": str(resolved),
        "bytes_written": len(content.encode("utf-8")),
        "status": "written",
    }, ensure_ascii=False)
