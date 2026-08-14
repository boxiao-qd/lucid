"""code_execute tool — execute code directly via subprocess (no Docker sandbox)."""

import asyncio
import json
import tempfile
import os
from pathlib import Path

from app.config import settings

# Absolute path to the upload script so skills can call it without knowing the project layout.
_PROJECT_ROOT   = str(Path(__file__).resolve().parents[3])
_UPLOAD_SCRIPT  = str(Path(__file__).resolve().parents[3] / "scripts" / "upload_artifact.py")


TOOL_DEF = {
    "type": "function",
    "function": {
        "name": "code_execute",
        "description": "Execute Python, JavaScript, or Bash code on the server. Returns exit code, stdout, and stderr. Requires user confirmation before execution.",
        "parameters": {
            "type": "object",
            "properties": {
                "language": {"type": "string", "description": "Programming language", "enum": ["python", "javascript", "bash"]},
                "code": {"type": "string", "description": "Code to execute"},
            },
            "required": ["language", "code"],
        },
    },
}


async def execute(args_str: str, employee_id: int) -> str:
    return await execute_with_session(args_str, employee_id, session_id="")


async def execute_with_session(args_str: str, employee_id: int, session_id: str) -> str:
    args = json.loads(args_str)
    language = args.get("language", "python")
    code = args.get("code", "")

    # Inject SA_* and storage env vars. Pydantic Settings reads .env into the
    # settings object but does NOT write back to os.environ, so we must inject
    # them explicitly so subprocesses can reach MinIO and DB.
    extra_env: dict[str, str] = {
        "SA_EMPLOYEE_ID":   str(employee_id),
        "SA_SESSION_ID":    session_id,
        "SA_UPLOAD_SCRIPT": _UPLOAD_SCRIPT,
        "SA_PROJECT_ROOT":  _PROJECT_ROOT,
        "OBJECT_STORAGE_ENDPOINT":   settings.object_storage_endpoint,
        "OBJECT_STORAGE_ACCESS_KEY": settings.object_storage_access_key,
        "OBJECT_STORAGE_SECRET_KEY": settings.object_storage_secret_key,
        "OBJECT_STORAGE_BUCKET":     settings.object_storage_bucket,
        "OBJECT_STORAGE_REGION":     settings.object_storage_region,
        "OBJECT_STORAGE_PREFIX":     settings.object_storage_prefix,
    }
    if settings.db_url:
        extra_env["DB_URL"] = settings.db_url
    env = {**os.environ, **{k: v for k, v in extra_env.items() if v}}

    interpreters = {"python": ("python3", ".py"), "javascript": ("node", ".js"), "bash": ("bash", ".sh")}
    if language not in interpreters:
        return json.dumps({"error": f"Unsupported language: {language}", "exit_code": -1}, ensure_ascii=False)

    interpreter, suffix = interpreters[language]

    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=suffix, delete=False) as f:
            f.write(code)
            tmp_path = f.name

        proc = await asyncio.create_subprocess_exec(
            interpreter, tmp_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, stderr = await proc.communicate()
        os.unlink(tmp_path)

        output = stdout.decode("utf-8", errors="replace")
        error_output = stderr.decode("utf-8", errors="replace")
        combined = output
        if error_output:
            combined += "\n--- stderr ---\n" + error_output

        return json.dumps({
            "exit_code": proc.returncode or 0,
            "output": combined,
            "language": language,
        }, ensure_ascii=False)

    except FileNotFoundError as e:
        return json.dumps({"error": f"Interpreter not found: {e}", "exit_code": -1}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": f"Code execution failed: {e}", "exit_code": -1}, ensure_ascii=False)