"""file_search tool — list/search files with SaaS path whitelist."""

import json
import os
import re
from pathlib import Path

from app.agent.tools.saas_path_guard import _check_search_allowed, SEARCH_DENIED_MSG


def _resolve_path(path: str) -> Path:
    if not path:
        return Path(os.path.realpath(os.getcwd()))
    return Path(os.path.realpath(path))


_SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv", ".idea", ".vscode"}

TOOL_DEF = {
    "type": "function",
    "function": {
        "name": "file_search",
        "description": "List files in a directory or search file contents/filenames. Searchable paths: tmp-doc/ (read-write), sys-infra/ (read-only), scripts/ (read-only).",
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Glob pattern for filename search (e.g. '*' to list all files, '*.pdf' for PDFs), or regex for content search"},
                "target": {"type": "string", "enum": ["content", "files"], "default": "files", "description": "'files' to list/search filenames, 'content' to search inside files"},
                "path": {"type": "string", "description": "Directory path to search/list"},
                "file_glob": {"type": "string", "description": "Glob filter for which files to search content in (e.g. '*.py')", "default": "*"},
                "limit": {"type": "integer", "description": "Maximum results to return", "default": 50},
            },
            "required": ["pattern"],
        },
    },
}


async def execute(args_str: str, employee_id: int) -> str:
    args = json.loads(args_str)
    pattern = args.get("pattern", "")
    target = args.get("target", "files")
    search_path = args.get("path", "")
    file_glob = args.get("file_glob", "*")
    limit = args.get("limit", 50)

    resolved_path = _resolve_path(search_path)

    # Path whitelist check
    if not _check_search_allowed(search_path):
        return json.dumps({
            "error": SEARCH_DENIED_MSG.format(path=search_path),
            "tool_name": "file_search",
        }, ensure_ascii=False)

    if not resolved_path.is_dir():
        return json.dumps({"error": f"Directory not found: {search_path}"}, ensure_ascii=False)

    results = []

    if target == "files":
        if pattern == "*" or pattern == "*.*":
            for item in sorted(resolved_path.iterdir()):
                if item.is_file():
                    results.append({
                        "path": str(item),
                        "name": item.name,
                        "size": item.stat().st_size,
                        "type": "file",
                    })
                elif item.is_dir() and item.name not in _SKIP_DIRS:
                    results.append({
                        "path": str(item),
                        "name": item.name,
                        "type": "directory",
                    })
                if len(results) >= limit:
                    break
        else:
            for match in resolved_path.rglob(pattern):
                if match.is_file() and match.parent.name not in _SKIP_DIRS:
                    results.append({"path": str(match), "name": match.name, "size": match.stat().st_size, "type": "file"})
                    if len(results) >= limit:
                        break
    else:
        try:
            regex = re.compile(pattern, re.IGNORECASE)
        except re.error as e:
            return json.dumps({"error": f"Invalid regex pattern: {e}"}, ensure_ascii=False)

        for filepath in resolved_path.rglob(file_glob):
            if not filepath.is_file():
                continue
            if filepath.parent.name in _SKIP_DIRS:
                continue
            if filepath.stat().st_size > 1_000_000:
                continue
            try:
                with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                    for line_num, line in enumerate(f, 1):
                        if regex.search(line):
                            results.append({
                                "path": str(filepath),
                                "line": line_num,
                                "content": line.strip()[:200],
                            })
                            if len(results) >= limit:
                                break
            except (PermissionError, OSError):
                continue
            if len(results) >= limit:
                break

    return json.dumps({
        "pattern": pattern,
        "target": target,
        "path": str(resolved_path),
        "results": results,
        "total": len(results),
        "limit": limit,
    }, ensure_ascii=False)