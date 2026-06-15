"""skill_asset_pull tool — fetch skill L3 assets (scripts/references/assets) from MinIO into in-memory cache."""

import json
import logging
import os

log = logging.getLogger(__name__)

_REF_SIZE_LIMIT = 8 * 1024  # references text content max 8KB


def _validate_filename(filename: str) -> str | None:
    """Reject filenames with path traversal or unsafe characters. Returns error message or None."""
    if not filename:
        return "filename is required"
    if ".." in filename or "/" in filename or "\\" in filename or "\x00" in filename:
        return f"filename '{filename}' contains unsafe characters (path separators, '..', or null bytes)"
    basename = os.path.basename(filename)
    if basename != filename:
        return f"filename must be a simple basename, got '{filename}'"
    return None

TOOL_DEF = {
    "type": "function",
    "function": {
        "name": "skill_asset_pull",
        "description": (
            "Pull a file from a skill's remote assets (scripts, references, or assets) "
            "from MinIO object storage into in-memory cache. "
            "Use this after skill_view shows available assets. "
            "For references: returns the file's text content. "
            "For scripts and assets: returns the file content (bytes represented as base64 for binary files)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "skill_name": {
                    "type": "string",
                    "description": "Name of the skill",
                },
                "category": {
                    "type": "string",
                    "enum": ["scripts", "references", "assets"],
                    "description": "Asset category to pull from",
                },
                "filename": {
                    "type": "string",
                    "description": "Filename within the category directory",
                },
            },
            "required": ["skill_name", "category", "filename"],
        },
    },
}


async def execute(args_str: str, employee_id: int) -> str:
    return json.dumps({
        "error": "skill_asset_pull requires session context — use execute_with_session",
    }, ensure_ascii=False)


async def execute_with_session(args_str: str, employee_id: int, session_id: str) -> str:
    args = json.loads(args_str)
    skill_name = args.get("skill_name", "")
    category = args.get("category", "")
    filename = args.get("filename", "")

    if not skill_name or not category or not filename:
        return json.dumps({
            "error": "skill_name, category, and filename are required",
        }, ensure_ascii=False)

    # Path traversal validation
    filename_error = _validate_filename(filename)
    if filename_error:
        return json.dumps({"ok": False, "error": filename_error, "code": "INVALID_FILENAME"}, ensure_ascii=False)

    valid_categories = {"scripts", "references", "assets"}
    if category not in valid_categories:
        return json.dumps({
            "error": f"Invalid category '{category}'. Must be one of: {', '.join(sorted(valid_categories))}",
        }, ensure_ascii=False)

    from app.agent.skill_asset_loader import _fetch_asset

    data = await _fetch_asset(session_id, employee_id, "skills", skill_name, f"{category}/{filename}")
    if data is None:
        return json.dumps({
            "ok": False,
            "error": f"Failed to fetch '{filename}' from skill '{skill_name}' ({category}/). "
                     f"The file may not exist in remote storage or MinIO is unavailable.",
            "code": "FETCH_FAILED",
        }, ensure_ascii=False)

    if category == "references":
        content = data.decode("utf-8", errors="replace")
        if len(content) > _REF_SIZE_LIMIT:
            content = content[:_REF_SIZE_LIMIT] + "\n... [truncated, use file_read for full content]"
        return json.dumps({
            "ok": True,
            "category": category,
            "filename": filename,
            "content": content,
        }, ensure_ascii=False)

    # scripts and assets: return content, base64 for binary
    try:
        text_content = data.decode("utf-8")
        return json.dumps({
            "ok": True,
            "category": category,
            "filename": filename,
            "content": text_content,
        }, ensure_ascii=False)
    except UnicodeDecodeError:
        import base64
        return json.dumps({
            "ok": True,
            "category": category,
            "filename": filename,
            "content_base64": base64.b64encode(data).decode("ascii"),
            "size": len(data),
        }, ensure_ascii=False)
