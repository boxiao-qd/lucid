"""Tests for terminal_tools.py write path restriction.

Verifies that _check_terminal_write_allowed blocks file writes to paths
outside tmp-doc/ and allows writes to tmp-doc/.
"""

import pytest
from app.agent.tools.terminal_tools import _check_terminal_write_allowed
from app.agent.tools.saas_path_guard import _PROJECT_ROOT

_TMP_DOC = str(_PROJECT_ROOT / "tmp-doc")


class TestRedirects:
    """Test > and >> redirect detection."""

    def test_redirect_to_root_blocked(self):
        assert _check_terminal_write_allowed("echo x > /root/test/file") == "/root/test/file"

    def test_append_to_root_blocked(self):
        assert _check_terminal_write_allowed("echo x >> /root/test/file") == "/root/test/file"

    def test_redirect_to_etc_blocked(self):
        assert _check_terminal_write_allowed("echo x > /etc/cron.d/backdoor") == "/etc/cron.d/backdoor"

    def test_redirect_to_tmp_doc_allowed(self):
        assert _check_terminal_write_allowed(f"echo x > {_TMP_DOC}/file.txt") is None

    def test_append_to_tmp_doc_allowed(self):
        assert _check_terminal_write_allowed(f"echo x >> {_TMP_DOC}/file.txt") is None

    def test_stderr_redirect_to_root_blocked(self):
        assert _check_terminal_write_allowed("echo x 2> /root/file") == "/root/file"

    def test_no_redirect_allowed(self):
        assert _check_terminal_write_allowed("echo /root/path") is None


class TestMkdir:
    def test_mkdir_root_blocked(self):
        assert _check_terminal_write_allowed("mkdir -p /root/test") == "/root/test"

    def test_mkdir_etc_blocked(self):
        assert _check_terminal_write_allowed("mkdir -p /etc/malicious") == "/etc/malicious"

    def test_mkdir_tmp_doc_allowed(self):
        assert _check_terminal_write_allowed(f"mkdir -p {_TMP_DOC}/subdir") is None


class TestTouch:
    def test_touch_root_blocked(self):
        assert _check_terminal_write_allowed("touch /root/file") == "/root/file"

    def test_touch_tmp_doc_allowed(self):
        assert _check_terminal_write_allowed(f"touch {_TMP_DOC}/file") is None


class TestCp:
    def test_cp_to_root_blocked(self):
        result = _check_terminal_write_allowed(f"cp {_TMP_DOC}/src /root/dest")
        assert result == "/root/dest"

    def test_cp_to_tmp_doc_allowed(self):
        result = _check_terminal_write_allowed(f"cp /root/src {_TMP_DOC}/dest")
        assert result is None

    def test_cp_multiple_dest_blocked(self):
        result = _check_terminal_write_allowed(f"cp a b /root/dest")
        assert result == "/root/dest"


class TestMv:
    def test_mv_to_root_blocked(self):
        result = _check_terminal_write_allowed(f"mv {_TMP_DOC}/src /root/dest")
        assert result == "/root/dest"

    def test_mv_to_tmp_doc_allowed(self):
        result = _check_terminal_write_allowed(f"mv /root/src {_TMP_DOC}/dest")
        assert result is None


class TestTee:
    def test_tee_to_root_blocked(self):
        assert _check_terminal_write_allowed("echo x | tee /root/file") == "/root/file"

    def test_tee_to_tmp_doc_allowed(self):
        assert _check_terminal_write_allowed(f"echo x | tee {_TMP_DOC}/file") is None

    def test_tee_append_to_root_blocked(self):
        assert _check_terminal_write_allowed("echo x | tee -a /root/file") == "/root/file"


class TestDd:
    def test_dd_to_root_blocked(self):
        result = _check_terminal_write_allowed("dd if=/dev/zero of=/root/file bs=1 count=1")
        assert result == "/root/file"

    def test_dd_to_tmp_doc_allowed(self):
        result = _check_terminal_write_allowed(f"dd if=/dev/zero of={_TMP_DOC}/file bs=1")
        assert result is None


class TestSedInPlace:
    def test_sed_i_to_root_blocked(self):
        result = _check_terminal_write_allowed("sed -i 's/old/new/' /root/file")
        assert result == "/root/file"

    def test_sed_i_to_tmp_doc_allowed(self):
        result = _check_terminal_write_allowed(f"sed -i 's/old/new/' {_TMP_DOC}/file")
        assert result is None

    def test_sed_without_i_allowed(self):
        """Non-in-place sed just outputs to stdout, not a file write."""
        assert _check_terminal_write_allowed("sed 's/old/new/' /root/file") is None


class TestInstall:
    def test_install_to_root_blocked(self):
        result = _check_terminal_write_allowed("install -m 644 src /root/file")
        assert result == "/root/file"

    def test_install_to_tmp_doc_allowed(self):
        result = _check_terminal_write_allowed(f"install -m 644 src {_TMP_DOC}/file")
        assert result is None


class TestTar:
    def test_tar_extract_to_root_blocked(self):
        result = _check_terminal_write_allowed("tar xzf arch.tar.gz -C /root/dir")
        assert result == "/root/dir"

    def test_tar_extract_to_tmp_doc_allowed(self):
        result = _check_terminal_write_allowed(f"tar xzf arch.tar.gz -C {_TMP_DOC}")
        assert result is None

    def test_tar_directory_long_form_blocked(self):
        result = _check_terminal_write_allowed("tar xzf arch.tar.gz --directory /root/dir")
        assert result == "/root/dir"


class TestRsync:
    def test_rsync_to_root_blocked(self):
        result = _check_terminal_write_allowed(f"rsync -av src /root/dest/")
        assert result == "/root/dest/"

    def test_rsync_to_tmp_doc_allowed(self):
        result = _check_terminal_write_allowed(f"rsync -av src {_TMP_DOC}/dest/")
        assert result is None


class TestLn:
    def test_ln_to_root_blocked(self):
        result = _check_terminal_write_allowed("ln -s /etc/passwd /root/link")
        assert result == "/root/link"

    def test_ln_to_tmp_doc_allowed(self):
        result = _check_terminal_write_allowed(f"ln -s /etc/passwd {_TMP_DOC}/link")
        assert result is None


class TestNonWriteCommands:
    """Commands that don't write files should not be blocked."""

    def test_ls_allowed(self):
        assert _check_terminal_write_allowed("ls -la /root/") is None

    def test_cat_allowed(self):
        assert _check_terminal_write_allowed("cat /root/file") is None

    def test_cd_allowed(self):
        assert _check_terminal_write_allowed("cd /root/") is None

    def test_echo_no_redirect_allowed(self):
        assert _check_terminal_write_allowed("echo hello world") is None

    def test_grep_allowed(self):
        assert _check_terminal_write_allowed("grep pattern /root/file") is None

    def test_chmod_read_only(self):
        """chmod changes permissions, not file content — not in the write detection scope."""
        assert _check_terminal_write_allowed("chmod 755 /root/file") is None

    def test_rm_not_detected(self):
        """rm deletes, not writes — not in the write detection scope."""
        assert _check_terminal_write_allowed("rm /root/file") is None

    def test_wget_to_tmp_doc_allowed(self):
        """wget downloading to tmp-doc is allowed."""
        result = _check_terminal_write_allowed(f"wget http://example.com/file -O {_TMP_DOC}/downloaded")
        assert result is None

    def test_curl_to_root_blocked(self):
        """curl downloading to /root is blocked (redirect)."""
        result = _check_terminal_write_allowed("curl http://example.com/file -o /root/downloaded")
        assert result == "/root/downloaded"


class TestComplexCommands:
    def test_pipe_with_blocked_write(self):
        result = _check_terminal_write_allowed("echo x | tee /root/file")
        assert result == "/root/file"

    def test_chained_with_blocked_write(self):
        result = _check_terminal_write_allowed("echo hello && echo x > /root/file")
        assert result == "/root/file"

    def test_multiple_writes_one_blocked(self):
        """If any write targets outside tmp-doc/, block it."""
        result = _check_terminal_write_allowed(f"echo x > {_TMP_DOC}/ok && echo y > /root/bad")
        assert result == "/root/bad"

    def test_all_writes_to_tmp_doc_allowed(self):
        result = _check_terminal_write_allowed(f"echo x > {_TMP_DOC}/a && echo y > {_TMP_DOC}/b")
        assert result is None
