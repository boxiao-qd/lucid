"""Unit tests for skill_asset_pull tool and skill_view assets enhancement."""

import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from pathlib import Path


# ─── skill_view returns assets listing ──────────────────────────────────────────

class TestSkillViewAssets:
    @pytest.mark.asyncio
    async def test_skill_view_returns_assets_when_object_key_exists(self):
        from app.agent.tools.skills_tool import skill_view

        mock_skill = MagicMock()
        mock_skill.name = "my-skill"
        mock_skill.is_global = False
        mock_skill.object_key = "user-skill/abc123"
        mock_skill.id = "abc123"

        mock_dao = AsyncMock()
        mock_dao.get_by_name = AsyncMock(return_value=mock_skill)
        mock_dao.get_skill_md = AsyncMock(return_value="# My Skill")
        mock_dao.increment_usage = AsyncMock()

        mock_storage = AsyncMock()
        mock_storage.list_directory = AsyncMock(side_effect=lambda eid, key: {
            "user-skill/abc123/scripts": ["run.py", "setup.sh"],
            "user-skill/abc123/references": ["api-docs.md"],
            "user-skill/abc123/assets": ["template.html"],
        }.get(key, []))

        with patch("app.agent.tools.skills_tool.get_system_skill_md", return_value=None), \
             patch("app.agent.tools.skills_tool.get_session_factory"), \
             patch("app.agent.tools.skills_tool.SkillDAO", return_value=mock_dao), \
             patch("app.storage.object_storage.create_object_storage", return_value=mock_storage):
            result = await skill_view(json.dumps({"name": "my-skill"}), employee_id=1)

        data = json.loads(result)
        assert data["name"] == "my-skill"
        assert data["assets"] is not None
        assert data["assets"]["scripts"] == ["run.py", "setup.sh"]
        assert data["assets"]["references"] == ["api-docs.md"]
        assert data["assets"]["assets"] == ["template.html"]

    @pytest.mark.asyncio
    async def test_skill_view_returns_null_assets_when_no_object_key(self):
        from app.agent.tools.skills_tool import skill_view

        mock_skill = MagicMock()
        mock_skill.name = "simple-skill"
        mock_skill.is_global = False
        mock_skill.object_key = None
        mock_skill.id = "xyz"

        mock_dao = AsyncMock()
        mock_dao.get_by_name = AsyncMock(return_value=mock_skill)
        mock_dao.get_skill_md = AsyncMock(return_value="# Simple Skill")
        mock_dao.increment_usage = AsyncMock()

        with patch("app.agent.tools.skills_tool.get_system_skill_md", return_value=None), \
             patch("app.agent.tools.skills_tool.get_session_factory"), \
             patch("app.agent.tools.skills_tool.SkillDAO", return_value=mock_dao):
            result = await skill_view(json.dumps({"name": "simple-skill"}), employee_id=1)

        data = json.loads(result)
        assert data["assets"] is None

    @pytest.mark.asyncio
    async def test_skill_view_handles_minio_error_gracefully(self):
        from app.agent.tools.skills_tool import skill_view

        mock_skill = MagicMock()
        mock_skill.name = "broken-skill"
        mock_skill.is_global = False
        mock_skill.object_key = "user-skill/broken"
        mock_skill.id = "broken"

        mock_dao = AsyncMock()
        mock_dao.get_by_name = AsyncMock(return_value=mock_skill)
        mock_dao.get_skill_md = AsyncMock(return_value="# Broken Skill")
        mock_dao.increment_usage = AsyncMock()

        mock_storage = AsyncMock()
        mock_storage.list_directory = AsyncMock(side_effect=Exception("MinIO down"))

        with patch("app.agent.tools.skills_tool.get_system_skill_md", return_value=None), \
             patch("app.agent.tools.skills_tool.get_session_factory"), \
             patch("app.agent.tools.skills_tool.SkillDAO", return_value=mock_dao), \
             patch("app.storage.object_storage.create_object_storage", return_value=mock_storage):
            result = await skill_view(json.dumps({"name": "broken-skill"}), employee_id=1)

        data = json.loads(result)
        assert data["assets"] is not None
        assert "error" in data["assets"]


# ─── skill_asset_pull tool ────────────────────────────────────────────────────

class TestSkillAssetPull:
    @pytest.mark.asyncio
    async def test_pull_script_returns_content(self):
        from app.agent.tools.skill_asset_pull import execute_with_session

        fake_data = b"print('hello')"

        with patch("app.agent.skill_asset_loader._fetch_asset", AsyncMock(return_value=fake_data)):
            result = await execute_with_session(
                json.dumps({"skill_name": "my-skill", "category": "scripts", "filename": "run.py"}),
                employee_id=1, session_id="test-session",
            )

        data = json.loads(result)
        assert data["ok"] is True
        assert data["category"] == "scripts"
        assert data["filename"] == "run.py"
        assert data["content"] == "print('hello')"

    @pytest.mark.asyncio
    async def test_pull_reference_returns_content(self):
        from app.agent.tools.skill_asset_pull import execute_with_session

        fake_data = b"# API Docs\nSome reference content."

        with patch("app.agent.skill_asset_loader._fetch_asset", AsyncMock(return_value=fake_data)):
            result = await execute_with_session(
                json.dumps({"skill_name": "my-skill", "category": "references", "filename": "api-docs.md"}),
                employee_id=1, session_id="test-session",
            )

        data = json.loads(result)
        assert data["ok"] is True
        assert data["category"] == "references"
        assert data["content"] == "# API Docs\nSome reference content."

    @pytest.mark.asyncio
    async def test_pull_asset_returns_content(self):
        from app.agent.tools.skill_asset_pull import execute_with_session

        fake_data = b"<html>template</html>"

        with patch("app.agent.skill_asset_loader._fetch_asset", AsyncMock(return_value=fake_data)):
            result = await execute_with_session(
                json.dumps({"skill_name": "my-skill", "category": "assets", "filename": "template.html"}),
                employee_id=1, session_id="test-session",
            )

        data = json.loads(result)
        assert data["ok"] is True
        assert data["category"] == "assets"
        assert data["content"] == "<html>template</html>"

    @pytest.mark.asyncio
    async def test_pull_binary_asset_returns_base64(self):
        from app.agent.tools.skill_asset_pull import execute_with_session

        fake_data = bytes(range(256))  # non-UTF-8 binary data

        with patch("app.agent.skill_asset_loader._fetch_asset", AsyncMock(return_value=fake_data)):
            result = await execute_with_session(
                json.dumps({"skill_name": "my-skill", "category": "assets", "filename": "image.png"}),
                employee_id=1, session_id="test-session",
            )

        data = json.loads(result)
        assert data["ok"] is True
        assert "content_base64" in data
        assert data["size"] == 256

    @pytest.mark.asyncio
    async def test_fetch_failure_returns_error(self):
        from app.agent.tools.skill_asset_pull import execute_with_session

        with patch("app.agent.skill_asset_loader._fetch_asset", AsyncMock(return_value=None)):
            result = await execute_with_session(
                json.dumps({"skill_name": "missing-skill", "category": "scripts", "filename": "ghost.py"}),
                employee_id=1, session_id="test-session",
            )

        data = json.loads(result)
        assert data["ok"] is False
        assert data["code"] == "FETCH_FAILED"
        assert "ghost.py" in data["error"]

    @pytest.mark.asyncio
    async def test_invalid_category_returns_error(self):
        from app.agent.tools.skill_asset_pull import execute_with_session

        result = await execute_with_session(
            json.dumps({"skill_name": "my-skill", "category": "invalid", "filename": "x"}),
            employee_id=1, session_id="test-session",
        )

        data = json.loads(result)
        assert "error" in data
        assert "invalid" in data["error"]

    @pytest.mark.asyncio
    async def test_missing_required_params_returns_error(self):
        from app.agent.tools.skill_asset_pull import execute_with_session

        result = await execute_with_session(
            json.dumps({"skill_name": "my-skill"}),
            employee_id=1, session_id="test-session",
        )

        data = json.loads(result)
        assert "error" in data

    def test_execute_without_session_returns_error(self):
        from app.agent.tools.skill_asset_pull import execute

        import asyncio
        result = asyncio.get_event_loop().run_until_complete(
            execute(json.dumps({"skill_name": "x", "category": "scripts", "filename": "y"}), employee_id=1)
        )
        data = json.loads(result)
        assert "error" in data


# ─── get_index has_assets field ────────────────────────────────────────────────

class TestGetIndexHasAssets:
    @pytest.mark.asyncio
    async def test_has_assets_true_when_object_key_exists(self):
        from app.dao.skill_dao import SkillDAO

        mock_session = AsyncMock()
        mock_factory = MagicMock(return_value=mock_session)

        row = MagicMock()
        row.__getitem__ = lambda self, i: ["complex-skill", "Has scripts", False, "user-skill/abc", "name: complex-skill\ndescription: Has scripts"][i]
        mock_result = MagicMock()
        mock_result.fetchall.return_value = [row]
        mock_session.execute = AsyncMock(return_value=mock_result)
        mock_session.close = AsyncMock()

        dao = SkillDAO(mock_factory, employee_id=42)
        result = await dao.get_index()

        assert result[0]["has_assets"] is True

    @pytest.mark.asyncio
    async def test_has_assets_false_when_object_key_is_none(self):
        from app.dao.skill_dao import SkillDAO

        mock_session = AsyncMock()
        mock_factory = MagicMock(return_value=mock_session)

        row = MagicMock()
        row.__getitem__ = lambda self, i: ["simple-skill", "No scripts", False, None, "name: simple-skill\ndescription: No scripts"][i]
        mock_result = MagicMock()
        mock_result.fetchall.return_value = [row]
        mock_session.execute = AsyncMock(return_value=mock_result)
        mock_session.close = AsyncMock()

        dao = SkillDAO(mock_factory, employee_id=42)
        result = await dao.get_index()

        assert result[0]["has_assets"] is False


# ─── Path traversal security ──────────────────────────────────────────────────

class TestPathTraversalSecurity:
    @pytest.mark.asyncio
    async def test_rejects_dotdot_in_filename(self):
        from app.agent.tools.skill_asset_pull import execute_with_session

        result = await execute_with_session(
            json.dumps({"skill_name": "my-skill", "category": "scripts", "filename": "../../etc/passwd"}),
            employee_id=1, session_id="test-session",
        )
        data = json.loads(result)
        assert data["ok"] is False
        assert data["code"] == "INVALID_FILENAME"

    @pytest.mark.asyncio
    async def test_rejects_slash_in_filename(self):
        from app.agent.tools.skill_asset_pull import execute_with_session

        result = await execute_with_session(
            json.dumps({"skill_name": "my-skill", "category": "scripts", "filename": "sub/run.py"}),
            employee_id=1, session_id="test-session",
        )
        data = json.loads(result)
        assert data["ok"] is False
        assert data["code"] == "INVALID_FILENAME"

    @pytest.mark.asyncio
    async def test_rejects_backslash_in_filename(self):
        from app.agent.tools.skill_asset_pull import execute_with_session

        result = await execute_with_session(
            json.dumps({"skill_name": "my-skill", "category": "scripts", "filename": "sub\\run.py"}),
            employee_id=1, session_id="test-session",
        )
        data = json.loads(result)
        assert data["ok"] is False
        assert data["code"] == "INVALID_FILENAME"

    @pytest.mark.asyncio
    async def test_rejects_null_byte_in_filename(self):
        from app.agent.tools.skill_asset_pull import execute_with_session

        result = await execute_with_session(
            json.dumps({"skill_name": "my-skill", "category": "scripts", "filename": "run.py\x00"}),
            employee_id=1, session_id="test-session",
        )
        data = json.loads(result)
        assert data["ok"] is False
        assert data["code"] == "INVALID_FILENAME"

    @pytest.mark.asyncio
    async def test_accepts_normal_filename(self):
        from app.agent.tools.skill_asset_pull import _validate_filename

        assert _validate_filename("run.py") is None
        assert _validate_filename("setup.sh") is None
        assert _validate_filename("api-docs.md") is None

    @pytest.mark.asyncio
    async def test_fetch_asset_returns_none_for_missing_object(self):
        from app.agent.skill_asset_loader import _fetch_asset

        with patch("app.dao.skill_dao.SkillDAO") as mock_dao_cls, \
             patch("app.dao.subagent_dao.SubagentDAO"), \
             patch("app.storage.object_storage.create_object_storage"), \
             patch("app.db.database.get_session_factory"):
            mock_dao = mock_dao_cls.return_value
            mock_dao.get_by_name = AsyncMock(return_value=None)
            result = await _fetch_asset(
                session_id="test-session",
                employee_id=1,
                kind="skills",
                name="missing-skill",
                sub_path="scripts/run.py",
            )
            assert result is None

    @pytest.mark.asyncio
    async def test_references_truncated_when_over_limit(self):
        from app.agent.tools.skill_asset_pull import execute_with_session, _REF_SIZE_LIMIT

        big_content = "A" * (_REF_SIZE_LIMIT + 1000)
        fake_data = big_content.encode("utf-8")

        with patch("app.agent.skill_asset_loader._fetch_asset", AsyncMock(return_value=fake_data)):
            result = await execute_with_session(
                json.dumps({"skill_name": "my-skill", "category": "references", "filename": "big.md"}),
                employee_id=1, session_id="test-session",
            )

        data = json.loads(result)
        assert data["ok"] is True
        assert "truncated" in data["content"]

# ─── cleanup_session_assets tests ──────────────────────────────────────────────

class TestCleanupSessionAssets:
    def test_cleanup_removes_session_entries(self):
        from app.agent import skill_asset_loader as loader

        loader._CACHE.clear()
        loader._CACHE["sess1/skills/a/references/b.md"] = b"data1"
        loader._CACHE["sess1/skills/c/scripts/d.py"] = b"data2"
        loader._CACHE["sess2/skills/e/references/f.md"] = b"data3"

        loader.cleanup_session_assets("sess1")

        assert "sess1/skills/a/references/b.md" not in loader._CACHE
        assert "sess1/skills/c/scripts/d.py" not in loader._CACHE
        assert "sess2/skills/e/references/f.md" in loader._CACHE

    def test_cleanup_noop_when_no_matching_entries(self):
        from app.agent import skill_asset_loader as loader

        loader._CACHE.clear()
        loader.cleanup_session_assets("nonexistent")
        assert len(loader._CACHE) == 0

    def test_cleanup_stale_sessions_is_noop(self):
        from app.agent import skill_asset_loader as loader

        loader._CACHE.clear()
        loader._CACHE["old/data"] = b"x"
        loader.cleanup_stale_sessions()
        # In-memory cache doesn't persist, so cleanup_stale_sessions is a no-op
        assert "old/data" in loader._CACHE

    def test_cache_hit_returns_cached_bytes(self):
        from app.agent import skill_asset_loader as loader

        loader._CACHE.clear()
        loader._CACHE["sess/skills/my-skill/references/doc.md"] = b"cached content"

        import asyncio
        result = asyncio.get_event_loop().run_until_complete(
            loader._fetch_asset("sess", 1, "skills", "my-skill", "references/doc.md")
        )
        assert result == b"cached content"
