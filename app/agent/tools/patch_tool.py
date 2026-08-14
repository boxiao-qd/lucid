"""patch tool — fuzzy file editing with old_string/new_string replacement."""

import json
import os
import re
from pathlib import Path

from app.agent.tools.saas_path_guard import _check_write_allowed, WRITE_DENIED_MSG


def _fuzzy_find(content: str, old_string: str) -> tuple[int | None, str]:
    """Find old_string in content with fuzzy matching. Returns (start_idx, match_text) or (None, '')."""
    strategies = [
        # 1. Exact match
        lambda c, o: (c.find(o), o),
        # 2. Line-trimmed (strip leading/trailing whitespace per line)
        lambda c, o: _line_trimmed_match(c, o),
        # 3. Whitespace normalized (collapse multiple spaces/tabs within lines)
        lambda c, o: _whitespace_normalized_match(c, o),
        # 4. Indentation flexible (ignore indentation differences)
        lambda c, o: _indentation_flexible_match(c, o),
    ]

    for strategy in strategies:
        idx, matched = strategy(content, old_string)
        if idx is not None and idx >= 0:
            return idx, matched

    return None, ""


def _normalize_lines(text: str, mode: str) -> str:
    if mode == "trim":
        return "\n".join(line.strip() for line in text.splitlines())
    elif mode == "collapse":
        return "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines())
    elif mode == "indent":
        return "\n".join(line.lstrip() for line in text.splitlines())
    return text


def _line_trimmed_match(content: str, old_string: str) -> tuple[int, str]:
    norm_content = _normalize_lines(content, "trim")
    norm_old = _normalize_lines(old_string, "trim")
    idx = norm_content.find(norm_old)
    if idx < 0:
        return -1, ""
    # Map back to original content position
    content_lines = content.splitlines()
    norm_lines = norm_content.splitlines()
    old_lines = old_string.splitlines()
    norm_old_lines = norm_lines  # norm_old splitlines

    # Find which line in norm_content starts the match
    match_line_start = norm_content[:idx].count("\n")
    # Verify the match
    for i, (norm_line, expected_norm) in enumerate(
        zip(norm_lines[match_line_start:match_line_start + len(old_lines)], _normalize_lines(old_string, "trim").splitlines())
    ):
        if norm_line != expected_norm:
            return -1, ""

    # Map back: line match_line_start in norm corresponds to same line in original
    char_offset = sum(len(line) + 1 for line in content_lines[:match_line_start])
    matched_original = "\n".join(content_lines[match_line_start:match_line_start + len(old_lines)])
    return char_offset, matched_original


def _whitespace_normalized_match(content: str, old_string: str) -> tuple[int, str]:
    norm_content = _normalize_lines(content, "collapse")
    norm_old = _normalize_lines(old_string, "collapse")
    idx = norm_content.find(norm_old)
    if idx < 0:
        return -1, ""
    content_lines = content.splitlines()
    match_line_start = norm_content[:idx].count("\n")
    old_line_count = len(old_string.splitlines())
    char_offset = sum(len(line) + 1 for line in content_lines[:match_line_start])
    matched_original = "\n".join(content_lines[match_line_start:match_line_start + old_line_count])
    return char_offset, matched_original


def _indentation_flexible_match(content: str, old_string: str) -> tuple[int, str]:
    norm_content = _normalize_lines(content, "indent")
    norm_old = _normalize_lines(old_string, "indent")
    idx = norm_content.find(norm_old)
    if idx < 0:
        return -1, ""
    content_lines = content.splitlines()
    match_line_start = norm_content[:idx].count("\n")
    old_line_count = len(old_string.splitlines())
    char_offset = sum(len(line) + 1 for line in content_lines[:match_line_start])
    matched_original = "\n".join(content_lines[match_line_start:match_line_start + old_line_count])
    return char_offset, matched_original


TOOL_DEF = {
    "type": "function",
    "function": {
        "name": "patch",
        "description": (
            "Edit a file by replacing an existing text segment with new text. Uses fuzzy matching "
            "to find the target text — tolerates whitespace, indentation, and formatting differences. "
            "Safer and more targeted than write_file for making changes. Each call can replace one "
            "text segment. For multiple edits, call patch multiple times. Writable path: tmp-doc/ only."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path to edit"},
                "old_string": {"type": "string", "description": "The text to find and replace (fuzzy matched)"},
                "new_string": {"type": "string", "description": "The replacement text"},
                "dry_run": {"type": "boolean", "default": False, "description": "Preview the change without writing to disk"},
            },
            "required": ["path", "old_string", "new_string"],
        },
    },
}


async def execute(args_str: str, employee_id: int) -> str:
    args = json.loads(args_str)
    path = args.get("path", "")
    old_string = args.get("old_string", "")
    new_string = args.get("new_string", "")
    dry_run = args.get("dry_run", False)

    # Path whitelist check — patch is a write operation
    if not _check_write_allowed(path):
        return json.dumps({
            "error": WRITE_DENIED_MSG.format(path=path),
            "tool_name": "patch",
        }, ensure_ascii=False)

    resolved = Path(os.path.realpath(path))

    if not resolved.is_file():
        return json.dumps({"error": f"File not found: {path}"}, ensure_ascii=False)

    try:
        with open(resolved, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except PermissionError:
        return json.dumps({"error": f"Permission denied: {path}"}, ensure_ascii=False)

    idx, matched_text = _fuzzy_find(content, old_string)
    if idx is None:
        return json.dumps({
            "error": "Could not find old_string in file (even with fuzzy matching)",
            "path": str(resolved),
            "old_string_preview": old_string[:200],
        }, ensure_ascii=False)

    # Check for ambiguous matches (multiple occurrences)
    # Count occurrences of the matched text
    occurrences = content.count(matched_text)
    if occurrences > 1:
        return json.dumps({
            "error": f"old_string matches {occurrences} times in file — provide more context to make it unique",
            "path": str(resolved),
            "occurrences": occurrences,
        }, ensure_ascii=False)

    # Apply replacement
    new_content = content[:idx] + new_string + content[idx + len(matched_text):]

    if dry_run:
        # Show preview diff
        old_lines = matched_text.splitlines()
        new_lines = new_string.splitlines()
        diff_preview = []
        for line in old_lines:
            diff_preview.append(f"- {line}")
        for line in new_lines:
            diff_preview.append(f"+ {line}")

        return json.dumps({
            "path": str(resolved),
            "dry_run": True,
            "match_strategy": "fuzzy",
            "diff_preview": diff_preview,
            "lines_changed": len(old_lines),
        }, ensure_ascii=False)

    try:
        with open(resolved, "w", encoding="utf-8") as f:
            f.write(new_content)
    except PermissionError:
        return json.dumps({"error": f"Permission denied: {path}"}, ensure_ascii=False)

    return json.dumps({
        "path": str(resolved),
        "status": "patched",
        "lines_changed": len(matched_text.splitlines()),
        "match_strategy": "fuzzy",
    }, ensure_ascii=False)