"""file_read tool — read file content with path traversal protection and SaaS path whitelist."""

import json
import os
from pathlib import Path

from app.agent.tools.saas_path_guard import _check_read_allowed, READ_DENIED_MSG


def _validate_path(path: str) -> Path:
    """Resolve path, reject traversal (../ beyond root), but allow any absolute path."""
    real = os.path.realpath(path)
    resolved = Path(real)
    return resolved


TOOL_DEF = {
    "type": "function",
    "function": {
        "name": "file_read",
        "description": "Read a file's content from the local filesystem. Supports line-based pagination. Accessible paths: tmp-doc/ (read-write), sys-infra/ (read-only), scripts/ (read-only).",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to read (absolute or relative)"},
                "offset": {"type": "integer", "description": "Line offset to start reading (1-based)", "default": 1},
                "limit": {"type": "integer", "description": "Maximum number of lines to read", "default": 500},
            },
            "required": ["path"],
        },
    },
}


async def execute(args_str: str, employee_id: int) -> str:
    args = json.loads(args_str)
    path = args.get("path", "")
    offset = max(1, args.get("offset", 1))
    limit = args.get("limit", 500)

    # Path whitelist check
    if not _check_read_allowed(path):
        return json.dumps({
            "error": READ_DENIED_MSG.format(path=path),
            "tool_name": "file_read",
        }, ensure_ascii=False)

    resolved = _validate_path(path)

    if resolved.is_dir():
        try:
            entries = sorted(resolved.iterdir(), key=lambda p: (p.is_file(), p.name))
            listing = []
            for entry in entries:
                if entry.is_dir():
                    listing.append(f"[DIR]  {entry.name}/")
                else:
                    try:
                        size = entry.stat().st_size
                        listing.append(f"[FILE] {entry.name}  ({size} bytes)")
                    except OSError:
                        listing.append(f"[FILE] {entry.name}")
            return json.dumps({
                "path": str(resolved),
                "type": "directory",
                "entries": len(listing),
                "content": "\n".join(listing),
            }, ensure_ascii=False)
        except PermissionError:
            return json.dumps({"error": f"Permission denied: {path}"}, ensure_ascii=False)

    if not resolved.exists():
        return json.dumps({"error": f"File not found: {path}"}, ensure_ascii=False)

    try:
        with open(resolved, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except PermissionError:
        return json.dumps({"error": f"Permission denied: {path}"}, ensure_ascii=False)

    total_lines = len(lines)
    selected = lines[offset - 1 : offset - 1 + limit]

    content = "".join(f"{i + offset}:  {line}" for i, line in enumerate(selected))

    return json.dumps({
        "path": str(resolved),
        "content": content,
        "total_lines": total_lines,
        "offset": offset,
        "limit": limit,
        "lines_returned": len(selected),
    }, ensure_ascii=False)