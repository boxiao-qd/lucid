"""Tests for tool_confirmation.py — human-in-the-loop confirmation mechanism."""

import asyncio
import json
import sys
import pytest
from unittest.mock import MagicMock, patch
from app.agent.tools.tool_confirmation import (
    is_tool_approved,
    approve_tool_for_session,
    inherit_parent_approvals,
    clear_session_approvals,
    request_confirmation,
    resolve_confirmation,
    _format_confirmation_content,
    _SESSION_APPROVALS,
    _PENDING_CONFIRMATIONS,
)


def _mock_sse_modules():
    """Mock the fastapi-dependent modules so request_confirmation can be tested."""
    return patch.dict(sys.modules, {
        "app.api.v1.stream": MagicMock(push_event=MagicMock()),
        "app.sse.event_types": MagicMock(SSEEventType=MagicMock()),
    })


class TestSessionApprovals:
    def test_not_approved_by_default(self):
        assert not is_tool_approved("sess-1", "terminal")

    def test_approve_adds_to_set(self):
        approve_tool_for_session("sess-1", "terminal")
        assert is_tool_approved("sess-1", "terminal")
        assert not is_tool_approved("sess-1", "code_execute")
        # cleanup
        clear_session_approvals("sess-1")

    def test_approve_does_not_leak_across_sessions(self):
        approve_tool_for_session("sess-a", "terminal")
        assert not is_tool_approved("sess-b", "terminal")
        clear_session_approvals("sess-a")

    def test_clear_removes_approvals(self):
        approve_tool_for_session("sess-1", "terminal")
        approve_tool_for_session("sess-1", "code_execute")
        clear_session_approvals("sess-1")
        assert not is_tool_approved("sess-1", "terminal")
        assert not is_tool_approved("sess-1", "code_execute")


class TestInheritParentApprovals:
    def test_child_inherits_parent_approvals(self):
        approve_tool_for_session("parent-1", "terminal")
        approve_tool_for_session("parent-1", "code_execute")
        inherit_parent_approvals("child-1", "parent-1")
        assert is_tool_approved("child-1", "terminal")
        assert is_tool_approved("child-1", "code_execute")
        clear_session_approvals("parent-1")
        clear_session_approvals("child-1")

    def test_child_with_no_parent_approvals(self):
        inherit_parent_approvals("child-2", "parent-empty")
        assert not is_tool_approved("child-2", "terminal")
        clear_session_approvals("child-2")

    def test_inheritance_is_additive(self):
        approve_tool_for_session("child-3", "terminal")
        inherit_parent_approvals("child-3", "parent-3")
        approve_tool_for_session("parent-3", "code_execute")
        # child already had terminal, parent had code_execute
        # Note: inherit is called BEFORE parent approves, so child only has terminal
        assert is_tool_approved("child-3", "terminal")
        assert not is_tool_approved("child-3", "code_execute")
        clear_session_approvals("child-3")
        clear_session_approvals("parent-3")


class TestClearSessionApprovals:
    @pytest.mark.asyncio
    async def test_clear_resolves_pending_with_timeout(self):
        # Create a pending confirmation
        future = asyncio.get_event_loop().create_future()
        _PENDING_CONFIRMATIONS["test-cf-1"] = {
            "future": future,
            "session_id": "sess-clear-test",
            "tool_name": "terminal",
            "tool_call_id": "tc-1",
        }
        assert not future.done()
        clear_session_approvals("sess-clear-test")
        assert future.done()
        result = future.result()
        assert result["action"] == "timeout"


class TestResolveConfirmation:
    @pytest.mark.asyncio
    async def test_resolve_returns_true_for_valid_id(self):
        future = asyncio.get_event_loop().create_future()
        _PENDING_CONFIRMATIONS["test-cf-2"] = {
            "future": future,
            "session_id": "sess-resolve-test",
            "tool_name": "terminal",
            "tool_call_id": "tc-2",
        }
        ok = resolve_confirmation("test-cf-2", "approve_once", "")
        assert ok
        assert future.done()
        result = future.result()
        assert result["action"] == "approve_once"
        clear_session_approvals("sess-resolve-test")

    def test_resolve_returns_false_for_expired_id(self):
        ok = resolve_confirmation("nonexistent-id", "approve_once", "")
        assert not ok

    @pytest.mark.asyncio
    async def test_resolve_returns_false_for_already_resolved(self):
        future = asyncio.get_event_loop().create_future()
        _PENDING_CONFIRMATIONS["test-cf-3"] = {
            "future": future,
            "session_id": "sess-resolved-test",
            "tool_name": "terminal",
            "tool_call_id": "tc-3",
        }
        future.set_result({"action": "approve_once"})
        ok = resolve_confirmation("test-cf-3", "reject", "")
        assert not ok
        _PENDING_CONFIRMATIONS.pop("test-cf-3", None)


class TestRequestConfirmation:
    @pytest.mark.asyncio
    async def test_request_returns_user_decision(self):
        with _mock_sse_modules():
            # Start request in background, then resolve it
            async def resolve_later():
                await asyncio.sleep(0.05)
                # Find the confirmation_id from _PENDING_CONFIRMATIONS
                for cid, entry in _PENDING_CONFIRMATIONS.items():
                    if entry["session_id"] == "sess-req-test":
                        resolve_confirmation(cid, "approve_session", "")
                        break

            task = asyncio.create_task(resolve_later())
            result = await request_confirmation(
                "sess-req-test", "terminal", "test content", "tc-req-1",
            )
            await task
        assert result["action"] == "approve_session"
        clear_session_approvals("sess-req-test")

    @pytest.mark.asyncio
    async def test_request_timeout_returns_timeout(self):
        import app.agent.tools.tool_confirmation as tc_mod
        original_timeout = tc_mod._CONFIRM_TIMEOUT
        tc_mod._CONFIRM_TIMEOUT = 0.05

        with _mock_sse_modules():
            result = await request_confirmation(
                "sess-timeout-test", "terminal", "test", "tc-timeout-1",
            )
        tc_mod._CONFIRM_TIMEOUT = original_timeout
        assert result["action"] == "timeout"
        clear_session_approvals("sess-timeout-test")


class TestFormatConfirmationContent:
    def test_terminal_command(self):
        args = json.dumps({"command": "ls -la", "workdir": "/tmp"})
        content = _format_confirmation_content("terminal", args)
        assert "terminal" in content
        assert "ls -la" in content
        assert "/tmp" in content

    def test_code_execute_python(self):
        args = json.dumps({"language": "python", "code": "print('hello')"})
        content = _format_confirmation_content("code_execute", args)
        assert "python" in content
        assert "print('hello')" in content

    def test_invalid_json_args(self):
        content = _format_confirmation_content("terminal", "not json")
        assert "terminal" in content
        assert "not json" in content

    def test_empty_command(self):
        args = json.dumps({"command": "", "workdir": ""})
        content = _format_confirmation_content("terminal", args)
        assert "terminal" in content

    def test_unknown_tool(self):
        args = json.dumps({"foo": "bar"})
        content = _format_confirmation_content("unknown_tool", args)
        assert "unknown_tool" in content
