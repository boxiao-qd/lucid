"""terminal + process tools — execute shell commands and manage background processes."""

import asyncio
import json
import os
import re
import time
from pathlib import Path

from app.config import settings
from app.agent.tools.saas_path_guard import _check_write_allowed

# Detect file-writing commands in shell, capturing the target path.
# For cp/mv/install/rsync/ln, the destination is the last path argument
# (regex uses lookahead to ensure the path is followed by end/pipe/semicolon).
# For tar, the target is the path after -C/--directory.
# For dd, the target is the path after of=.
# For sed, only -i (in-place) mode is a write — the expression in quotes is
# skipped, and the file path after it is captured.
# For curl/wget, the target is the path after -o/-O/--output/--output-document.
# Each alternative uses an unnamed capture group; _check_terminal_write_allowed
# extracts the first non-None group from each match.
_WRITE_RE = re.compile(
    r"""
    (?:
        \bmkdir\b[^|&;\n]*?(/[^\s|;&]+)
      | \btouch\b[^|&;\n]*?(/[^\s|;&]+)
      | \b(?:cp|mv|install|rsync|ln)\b[^|&;\n]*?(/[^\s|;&]+)(?=\s*(?:[|;&\n]|$))
      | >(?:>)?\s*(/[^\s|;&]+)
      | \btee\b[^|&;\n]*?(/[^\s|;&]+)
      | \bdd\b[^|&;\n]*?\bof=(\S+)
      | \bsed\b[^|;\n]*?-i[^|;\n]*?(?:'[^']*'|"[^"]*")\s+(/[^\s|;&]+)
      | \btar\b[^|;\n]*(?:-C|--directory)\s+(\S+)
      | \b(?:curl|wget)\b[^|;\n]*?(?:--output-document|-o|--output)(?:=|\s+)(/[^\s|;&]+)
    )
    """,
    re.VERBOSE | re.IGNORECASE,
)

_WRITE_DENIED_MSG = (
    "Writing to paths outside tmp-doc/ is FORBIDDEN. "
    "File writes via terminal must target tmp-doc/. "
    "Use file_write tool for direct file creation. "
    "For final deliverables, use create_artifact to upload to MinIO."
)


def _check_terminal_write_allowed(command: str) -> str | None:
    """Check if a terminal command writes to paths outside tmp-doc/.

    Returns None if all writes target tmp-doc/ or no writes detected.
    Returns the blocked path string if a write targets outside tmp-doc/.
    """
    for match in _WRITE_RE.finditer(command):
        target = next((g for g in match.groups() if g), None)
        if target and not _check_write_allowed(target):
            return target
    return None


_PROJECT_ROOT   = str(Path(__file__).resolve().parents[3])
_UPLOAD_SCRIPT  = str(Path(__file__).resolve().parents[3] / "scripts" / "upload_artifact.py")
_WORKDIR_SCRIPT = str(Path(__file__).resolve().parents[3] / "scripts" / "workdir.py")


def _subprocess_env(employee_id: int) -> dict[str, str]:
    """Build subprocess environment: inherit os.environ + inject settings values.

    Pydantic Settings reads .env into the settings object but does NOT write
    back to os.environ. Scripts running as subprocesses need these values
    explicitly injected so they can reach MinIO, DB, etc.
    """
    env = dict(os.environ)
    overrides = {
        "OBJECT_STORAGE_ENDPOINT":   settings.object_storage_endpoint,
        "OBJECT_STORAGE_ACCESS_KEY": settings.object_storage_access_key,
        "OBJECT_STORAGE_SECRET_KEY": settings.object_storage_secret_key,
        "OBJECT_STORAGE_BUCKET":     settings.object_storage_bucket,
        "OBJECT_STORAGE_REGION":     settings.object_storage_region,
        "OBJECT_STORAGE_PREFIX":     settings.object_storage_prefix,
        "SA_EMPLOYEE_ID":            str(employee_id),
        "SA_PROJECT_ROOT":           _PROJECT_ROOT,
        "SA_UPLOAD_SCRIPT":          _UPLOAD_SCRIPT,
        "SA_WORKDIR_SCRIPT":         _WORKDIR_SCRIPT,
    }
    if settings.db_url:
        overrides["DB_URL"] = settings.db_url
    env.update({k: v for k, v in overrides.items() if v})
    return env


# ── Background process registry ──────────────────────────────────────────

_bg_processes: dict[str, dict] = {}  # session_id → {proc, cwd, started_at, name}


# ── terminal tool ──────────────────────────────────────────────────────────

TOOL_DEF = {
    "type": "function",
    "function": {
        "name": "terminal",
        "description": (
            "Execute a shell command on the server. Returns exit code, stdout, and stderr. "
            "Use `background=true` for long-running processes (servers, builds); use `process` tool "
            "to manage background sessions. Do NOT use terminal for reading/editing files — use "
            "file_read / file_write / patch instead. Prefer foreground for short commands. "
            "Requires user confirmation before execution. "
            "Writing files to /tmp/ or /var/tmp/ is blocked."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to execute"},
                "background": {"type": "boolean", "default": False, "description": "Run in background; returns a session_id for process tool"},
                "timeout": {"type": "integer", "minimum": 1, "description": "Max seconds to wait (foreground only, max 600)", "default": 180},
                "workdir": {"type": "string", "description": "Working directory (absolute path)"},
            },
            "required": ["command"],
        },
    },
}


async def execute(args_str: str, employee_id: int) -> str:
    args = json.loads(args_str)
    command = args.get("command", "")
    background = args.get("background", False)
    timeout = min(args.get("timeout", 180), 600)
    workdir = args.get("workdir") or os.path.realpath(os.getcwd())

    if not command:
        return json.dumps({"error": "No command provided"}, ensure_ascii=False)

    # Block file writes to paths outside tmp-doc/ — code-level barrier.
    blocked_path = _check_terminal_write_allowed(command)
    if blocked_path:
        return json.dumps({
            "error": _WRITE_DENIED_MSG,
            "blocked": True,
            "path": blocked_path,
        }, ensure_ascii=False)

    try:
        if background:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workdir,
                env=_subprocess_env(employee_id),
            )
            session_id = f"bg-{int(time.time_ns())}"
            _bg_processes[session_id] = {
                "proc": proc,
                "cwd": workdir,
                "started_at": time.time(),
                "command": command[:200],
            }
            return json.dumps({
                "session_id": session_id,
                "status": "running",
                "command_preview": command[:200],
            }, ensure_ascii=False)

        # Foreground execution
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=workdir,
            env=_subprocess_env(employee_id),
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            stdout, stderr = await proc.communicate()
            return json.dumps({
                "exit_code": -1,
                "stdout": stdout.decode("utf-8", errors="replace")[:50000],
                "stderr": (stderr.decode("utf-8", errors="replace") + "\n[Timeout: killed after {}s]").format(timeout),
                "timed_out": True,
            }, ensure_ascii=False)

        out = stdout.decode("utf-8", errors="replace")
        err = stderr.decode("utf-8", errors="replace")
        combined = out
        if err:
            combined += "\n--- stderr ---\n" + err

        return json.dumps({
            "exit_code": proc.returncode or 0,
            "stdout": combined[:50000],
            "language": "shell",
        }, ensure_ascii=False)

    except Exception as e:
        return json.dumps({"error": f"Terminal execution failed: {e}", "exit_code": -1}, ensure_ascii=False)


# ── process tool ───────────────────────────────────────────────────────────

PROCESS_TOOL_DEF = {
    "type": "function",
    "function": {
        "name": "process",
        "description": (
            "Manage background terminal processes. Actions: list (all sessions), "
            "poll (check if still running), log (read output), wait (block until done), "
            "kill (terminate process), close (cleanup session)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["list", "poll", "log", "wait", "kill", "close"],
                    "description": "Action to perform on background process",
                },
                "session_id": {"type": "string", "description": "Background process session_id (required for all actions except list)"},
                "timeout": {"type": "integer", "minimum": 1, "description": "Max seconds to block for 'wait' action", "default": 30},
            },
            "required": ["action"],
        },
    },
}


async def process(args_str: str, employee_id: int) -> str:
    args = json.loads(args_str)
    action = args.get("action", "list")
    sid = args.get("session_id", "")
    timeout = min(args.get("timeout", 30), 120)

    if action == "list":
        result = []
        for key, entry in _bg_processes.items():
            proc = entry["proc"]
            running = proc.returncode is None
            result.append({
                "session_id": key,
                "command": entry["command"],
                "running": running,
                "started_at": entry["started_at"],
                "cwd": entry["cwd"],
            })
        return json.dumps({"processes": result, "count": len(result)}, ensure_ascii=False)

    entry = _bg_processes.get(sid)
    if not entry:
        return json.dumps({"error": f"Session '{sid}' not found"}, ensure_ascii=False)

    proc = entry["proc"]

    if action == "poll":
        running = proc.returncode is None
        return json.dumps({
            "session_id": sid,
            "running": running,
            "exit_code": proc.returncode,
        }, ensure_ascii=False)

    elif action == "log":
        # Read current stdout/stderr without consuming the pipe
        # For background processes, output is buffered; we read what's available
        stdout_data = b""
        stderr_data = b""
        if proc.stdout:
            try:
                while True:
                    chunk = await asyncio.wait_for(proc.stdout.read(4096), timeout=0.5)
                    if not chunk:
                        break
                    stdout_data += chunk
            except asyncio.TimeoutError:
                pass
        if proc.stderr:
            try:
                while True:
                    chunk = await asyncio.wait_for(proc.stderr.read(4096), timeout=0.5)
                    if not chunk:
                        break
                    stderr_data += chunk
            except asyncio.TimeoutError:
                pass

        out = stdout_data.decode("utf-8", errors="replace")
        err = stderr_data.decode("utf-8", errors="replace")
        combined = out
        if err:
            combined += "\n--- stderr ---\n" + err

        return json.dumps({
            "session_id": sid,
            "output": combined[:50000],
            "running": proc.returncode is None,
        }, ensure_ascii=False)

    elif action == "wait":
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            out = stdout.decode("utf-8", errors="replace")
            err = stderr.decode("utf-8", errors="replace")
            combined = out
            if err:
                combined += "\n--- stderr ---\n" + err
            _bg_processes.pop(sid, None)
            return json.dumps({
                "session_id": sid,
                "exit_code": proc.returncode or 0,
                "output": combined[:50000],
            }, ensure_ascii=False)
        except asyncio.TimeoutError:
            return json.dumps({
                "session_id": sid,
                "running": True,
                "error": f"Process still running after {timeout}s",
            }, ensure_ascii=False)

    elif action == "kill":
        proc.kill()
        await proc.wait()
        _bg_processes.pop(sid, None)
        return json.dumps({
            "session_id": sid,
            "status": "killed",
            "exit_code": proc.returncode,
        }, ensure_ascii=False)

    elif action == "close":
        # If still running, kill first
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        _bg_processes.pop(sid, None)
        return json.dumps({
            "session_id": sid,
            "status": "closed",
        }, ensure_ascii=False)

    else:
        return json.dumps({"error": f"Unknown action: {action}"}, ensure_ascii=False)


# ── Multi-tool registration ──────────────────────────────────────────────

TOOL_DEFS = [TOOL_DEF, PROCESS_TOOL_DEF]