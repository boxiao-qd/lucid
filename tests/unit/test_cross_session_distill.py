"""Tests for cross-session distillation in memory_distiller.py.

Verifies that run_cross_session_distillation:
- Returns silently when no previous session exists
- Marks session as ended when no un-distilled messages remain
- Distills un-distilled messages and marks them + session
- Handles exceptions without crashing
"""

import sys
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

# Mock heavy/missing modules before any app imports.
_fastapi = MagicMock()
_fastapi.responses = MagicMock(JSONResponse=MagicMock())
_fastapi.exceptions = MagicMock(RequestValidationError=MagicMock())
_fastapi.routing = MagicMock()
for _mod, _val in {
    "elasticsearch": MagicMock(AsyncElasticsearch=MagicMock()),
    "fastapi": _fastapi,
    "fastapi.responses": _fastapi.responses,
    "fastapi.exceptions": _fastapi.exceptions,
    "fastapi.routing": _fastapi.routing,
    "redis": MagicMock(),
    "redis.asyncio": MagicMock(),
    "starlette": MagicMock(),
    "starlette.requests": MagicMock(),
    "starlette.responses": MagicMock(),
}.items():
    if _mod not in sys.modules:
        sys.modules[_mod] = _val


@pytest.fixture(autouse=True)
def _reset_distillation_state():
    """Reset per-session locks and checkpoints between tests."""
    from app.agent import memory_distiller
    memory_distiller._distillation_locks.clear()
    memory_distiller._last_distilled_message_id.clear()
    yield
    memory_distiller._distillation_locks.clear()
    memory_distiller._last_distilled_message_id.clear()


def _make_msg(msg_id, role, content, is_distilled=0, is_compressed=0):
    """Create a mock message object."""
    m = MagicMock()
    m.id = msg_id
    m.role = role
    m.content = content
    m.is_distilled = is_distilled
    m.is_compressed = is_compressed
    return m


class TestNoPreviousSession:
    """When find_previous_active_session returns None, do nothing."""

    @pytest.mark.asyncio
    async def test_no_previous_session_returns_silently(self):
        from app.agent.memory_distiller import run_cross_session_distillation

        with patch("app.agent.memory_distiller.SessionDAO") as MockSessionDAO:
            mock_dao_instance = MockSessionDAO.return_value
            mock_dao_instance.find_previous_active_session = AsyncMock(return_value=None)

            # Should not raise, should not call distill
            await run_cross_session_distillation(1, "sess-current", MagicMock())

            mock_dao_instance.find_previous_active_session.assert_called_once_with("sess-current")


class TestAlreadyDistilled:
    """Previous session exists but all messages are already distilled."""

    @pytest.mark.asyncio
    async def test_all_distilled_marks_ended_only(self):
        from app.agent.memory_distiller import run_cross_session_distillation

        prev_session = MagicMock()
        prev_session.id = "sess-prev"

        msgs = [
            _make_msg("m1", "user", "hello", is_distilled=1),
            _make_msg("m2", "assistant", "hi", is_distilled=1),
        ]

        with patch("app.agent.memory_distiller.SessionDAO") as MockSessionDAO, \
             patch("app.agent.memory_distiller.MessageDAO") as MockMessageDAO, \
             patch("app.agent.memory_distiller.MemoryDistiller") as MockDistiller:

            session_dao = MockSessionDAO.return_value
            session_dao.find_previous_active_session = AsyncMock(return_value=prev_session)
            session_dao.mark_ended = AsyncMock()

            msg_dao = MockMessageDAO.return_value
            msg_dao.get_history = AsyncMock(return_value=(msgs, False))

            await run_cross_session_distillation(1, "sess-current", MagicMock())

            # Should mark session as ended
            session_dao.mark_ended.assert_called_once_with("sess-prev")
            # Should NOT call distiller (no un-distilled messages)
            MockDistiller.return_value.distill.assert_not_called()


class TestWithUndistilledMessages:
    """Previous session has un-distilled messages — distill them."""

    @pytest.mark.asyncio
    async def test_distills_and_marks_messages_and_session(self):
        from app.agent.memory_distiller import run_cross_session_distillation

        prev_session = MagicMock()
        prev_session.id = "sess-prev"

        msgs = [
            _make_msg("m1", "user", "I prefer Python", is_distilled=0),
            _make_msg("m2", "assistant", "Got it", is_distilled=0),
            _make_msg("m3", "tool", "{}", is_distilled=0),  # tool msg — should be filtered
        ]

        mock_result = MagicMock()
        mock_result.distilled_count = 1

        with patch("app.agent.memory_distiller.SessionDAO") as MockSessionDAO, \
             patch("app.agent.memory_distiller.MessageDAO") as MockMessageDAO, \
             patch("app.agent.memory_distiller.MemoryDistiller") as MockDistiller:

            session_dao = MockSessionDAO.return_value
            session_dao.find_previous_active_session = AsyncMock(return_value=prev_session)
            session_dao.mark_ended = AsyncMock()

            msg_dao = MockMessageDAO.return_value
            msg_dao.get_history = AsyncMock(return_value=(msgs, False))
            msg_dao.update = AsyncMock()

            distiller = MockDistiller.return_value
            distiller.distill = AsyncMock(return_value=mock_result)

            await run_cross_session_distillation(1, "sess-current", MagicMock())

            # Should distill only user/assistant un-distilled messages (not tool)
            distiller.distill.assert_called_once()
            call_args = distiller.distill.call_args
            distilled_msgs = call_args[0][2]  # third positional arg
            assert len(distilled_msgs) == 2
            assert distilled_msgs[0]["role"] == "user"
            assert distilled_msgs[1]["role"] == "assistant"

            # Should mark messages as distilled
            assert msg_dao.update.call_count == 2

            # Should mark session as ended
            session_dao.mark_ended.assert_called_once_with("sess-prev")


class TestExceptionHandling:
    """Exceptions should not crash the task."""

    @pytest.mark.asyncio
    async def test_exception_does_not_raise(self):
        from app.agent.memory_distiller import run_cross_session_distillation

        with patch("app.agent.memory_distiller.SessionDAO") as MockSessionDAO:
            session_dao = MockSessionDAO.return_value
            session_dao.find_previous_active_session = AsyncMock(
                side_effect=RuntimeError("DB connection lost")
            )

            # Should not raise
            await run_cross_session_distillation(1, "sess-current", MagicMock())


class TestExcludesCurrentAndChildSessions:
    """find_previous_active_session is called with the current session ID."""

    @pytest.mark.asyncio
    async def test_passes_current_session_id_to_exclude(self):
        from app.agent.memory_distiller import run_cross_session_distillation

        with patch("app.agent.memory_distiller.SessionDAO") as MockSessionDAO:
            session_dao = MockSessionDAO.return_value
            session_dao.find_previous_active_session = AsyncMock(return_value=None)

            await run_cross_session_distillation(42, "sess-current-123", MagicMock())

            # Verify the current session ID was passed to exclude it
            session_dao.find_previous_active_session.assert_called_once_with("sess-current-123")


class TestFormatExistingMemories:
    """_format_existing_memories formats STM for prompt injection."""

    def test_empty_returns_placeholder(self):
        from app.agent.memory_distiller import MemoryDistiller
        distiller = MemoryDistiller.__new__(MemoryDistiller)
        result = distiller._format_existing_memories([])
        assert result == "（无）"

    def test_formats_single_memory(self):
        from app.agent.memory_distiller import MemoryDistiller
        distiller = MemoryDistiller.__new__(MemoryDistiller)
        m = MagicMock()
        m.key = "preferred_language"
        m.value = "Python"
        m.category = "preference"
        m.importance = 0.9
        result = distiller._format_existing_memories([m])
        assert 'key: "preferred_language"' in result
        assert 'value: "Python"' in result
        assert "0.9" in result

    def test_sorts_by_importance_desc(self):
        from app.agent.memory_distiller import MemoryDistiller
        distiller = MemoryDistiller.__new__(MemoryDistiller)
        m_low = MagicMock()
        m_low.key = "low"; m_low.value = "v"; m_low.category = "fact"; m_low.importance = 0.3
        m_high = MagicMock()
        m_high.key = "high"; m_high.value = "v"; m_high.category = "fact"; m_high.importance = 0.9
        m_mid = MagicMock()
        m_mid.key = "mid"; m_mid.value = "v"; m_mid.category = "fact"; m_mid.importance = 0.6
        result = distiller._format_existing_memories([m_low, m_high, m_mid])
        # high should appear before mid, mid before low
        high_pos = result.index('"high"')
        mid_pos = result.index('"mid"')
        low_pos = result.index('"low"')
        assert high_pos < mid_pos < low_pos

    def test_caps_at_15_items(self):
        from app.agent.memory_distiller import MemoryDistiller
        distiller = MemoryDistiller.__new__(MemoryDistiller)
        mems = []
        for i in range(20):
            m = MagicMock()
            m.key = f"key_{i}"
            m.value = f"value_{i}"
            m.category = "fact"
            m.importance = 0.5
            mems.append(m)
        result = distiller._format_existing_memories(mems)
        # Should only have 15 lines
        assert result.count("\n") == 14  # 15 lines = 14 newlines

    def test_caps_total_chars_at_2000(self):
        from app.agent.memory_distiller import MemoryDistiller
        distiller = MemoryDistiller.__new__(MemoryDistiller)
        mems = []
        for i in range(50):
            m = MagicMock()
            m.key = f"key_{i}"
            m.value = "x" * 100  # long value
            m.category = "fact"
            m.importance = 0.5
            mems.append(m)
        result = distiller._format_existing_memories(mems)
        assert len(result) <= 2100  # 2000 char cap + some slack per line
