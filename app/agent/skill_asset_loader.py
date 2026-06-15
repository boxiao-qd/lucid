"""Skill/Subagent L3 asset loader — fetch scripts/references/assets into in-memory cache per session."""

from __future__ import annotations

import logging
import time
from pathlib import Path

log = logging.getLogger(__name__)

# In-memory asset cache: key → bytes
# Key format: "{session_id}/{kind}/{name}/{sub_path}"
_CACHE: dict[str, bytes] = {}


def _cache_key(session_id: str, kind: str, name: str, sub_path: str) -> str:
    return f"{session_id}/{kind}/{name}/{sub_path}"


def cleanup_stale_sessions(max_age_hours: int = 24) -> None:
    """Remove per-session asset entries older than max_age_hours.

    Call once at application startup to recover from any previous
    abnormal exits that left entries behind.
    """
    # In-memory cache doesn't persist across restarts, so this is a no-op.
    # Kept for API compatibility with startup code.
    pass


def cleanup_session_assets(session_id: str) -> None:
    """Remove all L3 cached assets for a session. Call on session end."""
    prefix = f"{session_id}/"
    keys_to_remove = [k for k in _CACHE if k.startswith(prefix)]
    for k in keys_to_remove:
        _CACHE.pop(k, None)
    if keys_to_remove:
        log.debug("Cleaned up L3 assets for session %s (%d entries)", session_id[:8], len(keys_to_remove))


async def skill_has_scripts(employee_id: int, skill_name: str) -> bool:
    """Check if a skill has a scripts/ directory (indicating file-output capability).

    Returns True if the skill has at least one file under scripts/ in object storage.
    """
    from app.dao.skill_dao import SkillDAO
    from app.storage.object_storage import create_object_storage
    from app.db.database import get_session_factory

    session_factory = get_session_factory()
    dao = SkillDAO(session_factory, employee_id)
    obj = await dao.get_by_name(skill_name)
    if not obj or not obj.object_key:
        return False

    try:
        storage = create_object_storage()
        files = await storage.get_directory(employee_id, f"{obj.object_key}/scripts")
        return bool(files)
    except Exception:
        return False


async def fetch_skill_script(
    session_id: str,
    employee_id: int,
    skill_name: str,
    filename: str,
) -> bytes | None:
    """Fetch a script file from skill/scripts/. Returns bytes or None."""
    return await _fetch_asset(session_id, employee_id, "skills", skill_name, f"scripts/{filename}")


async def fetch_skill_reference(
    session_id: str,
    employee_id: int,
    skill_name: str,
    filename: str,
) -> str | None:
    """Fetch a reference file from skill/references/ and return text content."""
    data = await _fetch_asset(session_id, employee_id, "skills", skill_name, f"references/{filename}")
    if data is not None:
        return data.decode("utf-8", errors="replace")
    return None


async def fetch_subagent_script(
    session_id: str,
    employee_id: int,
    subagent_name: str,
    filename: str,
) -> bytes | None:
    return await _fetch_asset(session_id, employee_id, "subagents", subagent_name, f"tools/{filename}")


async def _fetch_asset(
    session_id: str,
    employee_id: int,
    kind: str,         # "skills" | "subagents"
    name: str,
    sub_path: str,
) -> bytes | None:
    from app.dao.skill_dao import SkillDAO
    from app.dao.subagent_dao import SubagentDAO
    from app.storage.object_storage import create_object_storage
    from app.db.database import get_session_factory

    key = _cache_key(session_id, kind, name, sub_path)

    # Cache hit
    if key in _CACHE:
        return _CACHE[key]

    session_factory = get_session_factory()

    # Resolve object_key
    if kind == "skills":
        dao = SkillDAO(session_factory, employee_id)
        obj = await dao.get_by_name(name)
    else:
        dao = SubagentDAO(session_factory, employee_id)
        obj = await dao.get_by_name(name)

    if not obj or not obj.object_key:
        return None

    object_key = f"{obj.object_key}/{sub_path}"
    try:
        storage = create_object_storage()
        data = await storage.get(employee_id, object_key)
        if data is None:
            return None
        _CACHE[key] = data
        return data
    except Exception as e:
        log.warning("L3 asset fetch failed (%s/%s/%s): %s", kind, name, sub_path, e)
        return None
