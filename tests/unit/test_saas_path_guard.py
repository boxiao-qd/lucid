"""Tests for saas_path_guard.py — path whitelist validation (always-on)."""

import os
from pathlib import Path
from app.agent.tools.saas_path_guard import (
    _is_under_dir,
    _check_read_allowed,
    _check_write_allowed,
    _check_search_allowed,
    _PROJECT_ROOT,
    _READ_DIRS,
    _WRITE_DIRS,
)


class TestIsUnderDir:
    def test_exact_match(self):
        assert _is_under_dir("/data/tmp-doc", "/data/tmp-doc")

    def test_subdirectory(self):
        assert _is_under_dir("/data/tmp-doc/sub/foo", "/data/tmp-doc")

    def test_subdirectory_file(self):
        assert _is_under_dir("/data/tmp-doc/file.txt", "/data/tmp-doc")

    def test_prefix_collision_rejected(self):
        assert not _is_under_dir("/data/tmp-doc-extra", "/data/tmp-doc")

    def test_prefix_collision_rejected_2(self):
        assert not _is_under_dir("/data/uc-data", "/data/uc")

    def test_different_path_rejected(self):
        assert not _is_under_dir("/tmp/other", "/data/tmp-doc")

    def test_parent_path_rejected(self):
        assert not _is_under_dir("/data", "/data/tmp-doc")


class TestWhitelistConfig:
    """Verify the whitelist directories are correctly configured."""

    def test_read_dirs_contain_tmp_doc_sys_infra_scripts(self):
        names = [d.name for d in _READ_DIRS]
        assert "tmp-doc" in names
        assert "sys-infra" in names
        assert "scripts" in names

    def test_write_dirs_only_tmp_doc(self):
        assert len(_WRITE_DIRS) == 1
        assert _WRITE_DIRS[0].name == "tmp-doc"


class TestReadAllowed:
    def test_tmp_doc_allowed(self):
        path = str(_PROJECT_ROOT / "tmp-doc" / "test.txt")
        assert _check_read_allowed(path)

    def test_sys_infra_allowed(self):
        path = str(_PROJECT_ROOT / "sys-infra" / "skills" / "test.md")
        assert _check_read_allowed(path)

    def test_scripts_allowed(self):
        path = str(_PROJECT_ROOT / "scripts" / "run.py")
        assert _check_read_allowed(path)

    def test_tmp_doc_root_allowed(self):
        assert _check_read_allowed(str(_PROJECT_ROOT / "tmp-doc"))

    def test_etc_passwd_denied(self):
        assert not _check_read_allowed("/etc/passwd")

    def test_tmp_denied(self):
        assert not _check_read_allowed("/tmp/some_file")

    def test_home_dir_denied(self):
        assert not _check_read_allowed("/home/user/secret")

    def test_project_root_denied(self):
        assert not _check_read_allowed(str(_PROJECT_ROOT))


class TestWriteAllowed:
    def test_tmp_doc_allowed(self):
        path = str(_PROJECT_ROOT / "tmp-doc" / "output.txt")
        assert _check_write_allowed(path)

    def test_tmp_doc_subdir_allowed(self):
        path = str(_PROJECT_ROOT / "tmp-doc" / "sub" / "deep" / "file.txt")
        assert _check_write_allowed(path)

    def test_sys_infra_denied(self):
        path = str(_PROJECT_ROOT / "sys-infra" / "skills" / "test.md")
        assert not _check_write_allowed(path)

    def test_scripts_denied(self):
        path = str(_PROJECT_ROOT / "scripts" / "run.py")
        assert not _check_write_allowed(path)

    def test_etc_denied(self):
        assert not _check_write_allowed("/etc/test")

    def test_tmp_denied(self):
        assert not _check_write_allowed("/tmp/hack")

    def test_project_root_denied(self):
        assert not _check_write_allowed(str(_PROJECT_ROOT))


class TestSearchAllowed:
    def test_tmp_doc_allowed(self):
        path = str(_PROJECT_ROOT / "tmp-doc")
        assert _check_search_allowed(path)

    def test_sys_infra_allowed(self):
        path = str(_PROJECT_ROOT / "sys-infra")
        assert _check_search_allowed(path)

    def test_scripts_allowed(self):
        path = str(_PROJECT_ROOT / "scripts")
        assert _check_search_allowed(path)

    def test_empty_path_defaults_to_cwd(self):
        # Should not raise — defaults to os.getcwd()
        result = _check_search_allowed("")
        # cwd is likely not in whitelist, so should be False
        assert isinstance(result, bool)

    def test_etc_denied(self):
        assert not _check_search_allowed("/etc")

    def test_root_denied(self):
        assert not _check_search_allowed("/")
