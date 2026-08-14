"""Path whitelist validator — restrict file operations to tmp-doc/, sys-infra/, scripts/."""

import os
from pathlib import Path

# Project root: app/agent/tools/ → 3 levels up → project root.
_PROJECT_ROOT = Path(__file__).resolve().parents[3]

# Read whitelist: tmp-doc/ + sys-infra/ + scripts/
_READ_DIRS = [
    _PROJECT_ROOT / "tmp-doc",
    _PROJECT_ROOT / "sys-infra",
    _PROJECT_ROOT / "scripts",
]

# Write whitelist: tmp-doc/ only
_WRITE_DIRS = [_PROJECT_ROOT / "tmp-doc"]


def _is_under_dir(real_path: str, dir_path: str) -> bool:
    """Check if real_path is exactly dir_path or a subdirectory/file under dir_path.
    Uses path separator boundary to prevent prefix collision (e.g. /data/uc matching /data/uc-data)."""
    if real_path == dir_path:
        return True
    if real_path.startswith(dir_path + os.sep):
        return True
    return False


def _check_read_allowed(path: str) -> bool:
    """Only allow reads from tmp-doc/, sys-infra/, scripts/."""
    real = os.path.realpath(path)
    return any(_is_under_dir(real, os.path.realpath(str(d))) for d in _READ_DIRS)


def _check_write_allowed(path: str) -> bool:
    """Only allow writes to tmp-doc/."""
    real = os.path.realpath(path)
    return any(_is_under_dir(real, os.path.realpath(str(d))) for d in _WRITE_DIRS)


def _check_search_allowed(path: str) -> bool:
    """Only allow searches within tmp-doc/, sys-infra/, scripts/."""
    real = os.path.realpath(path) if path else os.path.realpath(os.getcwd())
    return any(_is_under_dir(real, os.path.realpath(str(d))) for d in _READ_DIRS)


READ_DENIED_MSG = (
    "路径不在允许的白名单内。可读目录：tmp-doc/、sys-infra/、scripts/。可写目录：tmp-doc/。（路径：{path}）"
)

WRITE_DENIED_MSG = (
    "路径不在允许的白名单内。可读目录：tmp-doc/、sys-infra/、scripts/。可写目录：tmp-doc/。（路径：{path}）"
)

SEARCH_DENIED_MSG = (
    "路径不在允许的白名单内。可读目录：tmp-doc/、sys-infra/、scripts/。可写目录：tmp-doc/。（路径：{path}）"
)
