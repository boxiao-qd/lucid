"""Sub-agent delegation executor — goal+context delegation with pure memory loop."""

import json
import time
import uuid
import logging
from app.dao.message_dao import MessageDAO
from app.api.v1.stream import push_event
from app.sse.event_types import SSEEventType
from app.db.database import get_session_factory
from app.agent.llm_router import LLMRouter
from app.agent.tools import get_tool_definitions, get_tool_executor
from app.config import settings

log = logging.getLogger(__name__)


class DelegateExecutor:
    def __init__(self, employee_id: int):
        self._employee_id = employee_id
        self._session_factory = get_session_factory()
        self._llm_router = LLMRouter()

    
    async def delegate_from_definition(self, parent_session_id: str, agent_type: str, goal: str, context: str | None = None) -> str:
        """Spawn a sub-agent from an AgentDefinition (via SubagentLoader) — pure memory execution.

        - Loads AgentDefinition from SubagentLoader (builtin priority)
        - Applies three-layer tool filtering (global → per-agent disallowed → per-agent allowlist)
        - Uses AgentDefinition.max_turns for iteration cap
        - Pure memory loop: no child session/messages in DB
        - Only the final summary is written to the parent session's message history
        """
        from app.subagents.agent_loader import SubagentLoader
        from app.subagents.tool_filter import filter_tools_for_agent

        loader = SubagentLoader.get_instance()
        agent_def = await loader.get_agent(agent_type)
        if not agent_def:
            available = [a.agent_type for a in await loader.list_agents()]
            msg = f"Sub-agent '{agent_type}' not found. Available: {', '.join(available)}. Retry with an exact name from this list, or do the research yourself and follow the AGENT.md workflow (create workdir → write file → upload to MinIO)."
            push_event(parent_session_id, SSEEventType.error, {
                "error_code": "BX_SUBAGENT_6002",
                "message": msg,
                "recoverable": True,
            })
            return msg

        # Build system prompt from AgentDefinition body + goal + context
        system_prompt = f"{agent_def.system_prompt}\n\nGoal: {goal}"
        if context:
            system_prompt += f"\nContext: {context}"

        # Apply tool filtering
        all_tool_defs = get_tool_definitions("child")
        tool_defs = filter_tools_for_agent(all_tool_defs, agent_def)

        # Determine model (sub-agent may override via AGENT.md; default to main model)
        model = agent_def.model if agent_def.model and agent_def.model != "inherit" else settings.default_model
        max_turns = agent_def.max_turns

        # Push delegation_start
        delegation_id = str(uuid.uuid4())[:8]
        push_event(parent_session_id, SSEEventType.delegation_start, {
            "child_session_id": delegation_id,
            "subagent_name": agent_type,
            "goal": goal,
            "context": context,
            "max_turns": max_turns,
        })

        # Run sub-agent loop — pure memory, no DB writes for internal messages
        child_messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": goal}]
        summary = ""
        has_used_tools = False  # track whether the agent has called at least one tool

        for iteration in range(max_turns):
            push_event(parent_session_id, SSEEventType.delegation_update, {
                "child_session_id": delegation_id,
                "subagent_name": agent_type,
                "status": "running",
                "progress_note": f"Iteration {iteration + 1}",
                "elapsed_seconds": int(time.time()),
            })

            try:
                stream = await self._llm_router.chat(
                    model=model,
                    messages=child_messages,
                    tools=tool_defs,
                    stream=True,
                )

                content = ""
                tool_calls = []
                async for chunk in stream:
                    delta = chunk.choices[0].delta
                    if delta.content:
                        content += delta.content
                    if delta.tool_calls:
                        for tc in delta.tool_calls:
                            while len(tool_calls) <= tc.index:
                                tool_calls.append({"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                            if tc.id:
                                tool_calls[tc.index]["id"] = tc.id
                            if tc.function:
                                if tc.function.name:
                                    tool_calls[tc.index]["function"]["name"] = tc.function.name
                                if tc.function.arguments:
                                    tool_calls[tc.index]["function"]["arguments"] += tc.function.arguments

                if not tool_calls:
                    if not has_used_tools:
                        # Agent produced only text without ever calling a tool.
                        # Force it to actually use tools before we accept any summary.
                        log.warning(
                            "Sub-agent '%s' produced no tool calls on iteration %d — injecting reminder",
                            agent_type, iteration + 1,
                        )
                        child_messages.append({"role": "assistant", "content": content})
                        child_messages.append({
                            "role": "user",
                            "content": (
                                "You have not used any tools yet. "
                                "You MUST call a tool now — do not produce a text-only response. "
                                "Start your work immediately with your first tool call."
                            ),
                        })
                        continue
                    # Agent has used tools at least once — this is a genuine final response.
                    summary = content
                    break

                # Execute tools in-memory (no DB writes)
                has_used_tools = True
                child_messages.append({"role": "assistant", "content": content, "tool_calls": tool_calls})
                for tc in tool_calls:
                    tool_name = tc["function"]["name"]
                    args_str = tc["function"]["arguments"]

                    # ── Human-in-the-loop confirmation for terminal / code_execute ──
                    # Sub-agent tool calls bypass _execute_tool, so we check here.
                    # Use parent_session_id for approval/confirmation (user watches parent stream).
                    CONFIRM_TOOLS = {"terminal", "code_execute"}
                    if tool_name in CONFIRM_TOOLS:
                        from app.agent.tools.tool_confirmation import (
                            is_tool_approved, approve_tool_for_session,
                            request_confirmation, _format_confirmation_content,
                        )
                        if not is_tool_approved(parent_session_id, tool_name):
                            content_str = _format_confirmation_content(tool_name, args_str)
                            decision = await request_confirmation(
                                parent_session_id, tool_name, content_str, tc["id"],
                            )
                            action = decision.get("action")
                            if action == "reject":
                                result = json.dumps({"error": "用户拒绝了本次命令执行"}, ensure_ascii=False)
                                child_messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})
                                continue
                            elif action == "custom":
                                result = json.dumps({"user_feedback": decision.get("text", "")}, ensure_ascii=False)
                                child_messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})
                                continue
                            elif action == "timeout":
                                result = json.dumps({"error": "确认超时（5 分钟未响应），命令未执行"}, ensure_ascii=False)
                                child_messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})
                                continue
                            elif action == "approve_session":
                                approve_tool_for_session(parent_session_id, tool_name)
                            # approve_once: proceed to execution

                    executor = get_tool_executor(tool_name)
                    result = await executor(args_str, self._employee_id) if executor else json.dumps({"error": "Tool not found"}, ensure_ascii=False)
                    child_messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})

            except Exception as exc:
                log.warning("Sub-agent '%s' failed at iteration %d: %s", agent_type, iteration + 1, exc)
                push_event(parent_session_id, SSEEventType.delegation_end, {
                    "child_session_id": delegation_id,
                    "subagent_name": agent_type,
                    "summary": f"Delegation failed: {exc}",
                    "is_error": True,
                })
                return f"Sub-agent '{agent_type}' failed: {exc}. Please retry or handle this task yourself."

        # Push delegation_end
        push_event(parent_session_id, SSEEventType.delegation_end, {
            "child_session_id": delegation_id,
            "subagent_name": agent_type,
            "summary": summary or "Task completed with no summary",
            "is_error": False,
        })

        # Write summary into parent session history
        msg_dao = MessageDAO(self._session_factory, self._employee_id)
        await msg_dao.create(
            session_id=parent_session_id, role="assistant",
            content=f"[Sub-agent result from {agent_type}]: {summary}",
        )

        return summary or "Task completed with no summary"