"""Agent conversation loop — agentic multi-step execution with LLM streaming and tool dispatch."""

import asyncio
import json
import logging
import re
import time

import httpx
import openai

from app.dao.session_dao import SessionDAO
from app.dao.message_dao import MessageDAO
from app.api.v1.stream import push_event
from app.sse.event_types import SSEEventType
from app.db.database import get_session_factory
from app.agent.llm_router import LLMRouter
from app.agent.tools import get_tool_definitions, get_tool_executor
from app.agent.context_loader import ContextLoader
from app.agent.context_compressor import compress_if_needed, reset_circuit_breaker
from app.agent.llm_router import ContextOverflowError
from app.agent.tools.todo_write import get_session_todos, todo_summary_for_llm, force_complete_todos
from app.agent.task_manager import (
    register_run, unregister_run, cancel_run, get_active_run,
    enqueue_task, dequeue_task, has_queued_tasks, is_cancel_trigger,
    get_queue,
)
from app.config import settings

log = logging.getLogger(__name__)

_THINK_START_RE = re.compile(r"<think>|<thinking>", re.IGNORECASE)


def _build_time_header() -> str:
    from datetime import datetime
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S")
    return f"[当前时间]\n{now}（Asia/Shanghai）"


def _build_tools_section(session_type: str) -> str:
    from app.agent.tools import get_tool_definitions
    defs = get_tool_definitions(session_type)
    if not defs:
        return ""
    lines = []
    for d in defs:
        fn = d.get("function", {})
        name = fn.get("name", "")
        desc = fn.get("description", "").split("\n")[0][:80]
        lines.append(f"  - {name}: {desc}")
    return "[可用工具]\n" + "\n".join(lines)
_THINK_END_RE = re.compile(r"</think>|</thinking>", re.IGNORECASE)

_LOG_ARGS_MAX = 500    # truncate tool args in log lines
_LOG_RESULT_MAX = 600  # truncate tool results in log lines

# Context size management — multi-level trim strategy.
# web_fetch returns full HTML (50-100KB each); cap inline immediately, then trim in tiers.
_TOOL_RESULT_INLINE_CAP = 8_000    # cap each tool result when appending to llm_messages

_CONTEXT_TRIM_CHARS = 80_000       # soft trim: kick in early
_TOOL_RESULT_KEEP_RECENT = 2       # keep last N results at full length (soft)
_TOOL_RESULT_KEEP_CHARS = 400      # chars per old result after soft trim

_CONTEXT_HARD_LIMIT_CHARS = 200_000  # hard trim: near-emergency
_TOOL_RESULT_HARD_RECENT = 1         # keep last N results at full length (hard)
_TOOL_RESULT_HARD_CHARS = 100        # chars per old result after hard trim

_CHARS_PER_TOKEN = 3.5             # rough estimate for mixed Chinese/HTML

# Microcompact placeholder — matches Claude Code's "[Old tool result content cleared]"
_MICROCOMPACT_PLACEHOLDER = "[Old tool result content cleared]"

# Tools safe to execute concurrently — read-only or independent side effects.
_CONCURRENT_TOOLS = frozenset({
    "web_search", "web_fetch", "file_read", "file_search",
    "session_search", "memory_query", "clarify",
    "skills_list", "skill_view",
    "spawn_subagent",
})


class AgentService:
    def __init__(self, employee_id: int):
        self._employee_id = employee_id
        self._session_factory = get_session_factory()
        self._llm_router = LLMRouter()
        self._tool_results: dict[str, str] = {}
        self._context_loader = ContextLoader(employee_id, self._session_factory)

    async def process_message(self, session_id: str, content: str, role: str = "user", user_msg_id: str | None = None) -> str:
        sid = session_id[:8]
        log.info("[%s] 收到消息 — role=%s 长度=%d 预览=%r",
                 sid, role, len(content), content[:80])

        msg_dao = MessageDAO(self._session_factory, self._employee_id)
        session_dao = SessionDAO(self._session_factory, self._employee_id)

        session = await session_dao.get_by_id(session_id)

        # Reset circuit breaker on new user message
        reset_circuit_breaker(session_id)

        if user_msg_id is None:
            # Parallel: save user message and load history concurrently
            msg_dao2 = MessageDAO(self._session_factory, self._employee_id)
            create_task = msg_dao.create(session_id=session_id, role=role, content=content)
            history_task = msg_dao2.get_history(session_id, limit=settings.history_load_limit - 1)
            user_msg, (history, _) = await asyncio.gather(create_task, history_task)
            user_msg_id = user_msg.id
            history.append(user_msg)
            log.info("[%s] 用户消息已保存 — msg_id=%s", sid, user_msg_id)
        else:
            history, _ = await msg_dao.get_history(session_id, limit=settings.history_load_limit)
        push_event(session_id, SSEEventType.message_done, {
            "message_id": user_msg_id,
            "role": role,
            "content": content,
            "token_count": 0,
            "stop_reason": None,
        })
        log.info("[%s] 历史消息已加载 — 上下文共 %d 条", sid, len(history))

        # ── System commands: intercept before agent loop ──
        if content.startswith("/compact"):
            return await self._handle_compact_command(
                session_id, session, content, user_msg_id, sid, msg_dao, session_dao
            )

        # ── Cancel trigger: if user sends a cancel word while a run is active ──
        if is_cancel_trigger(content):
            active = get_active_run(session_id)
            if active and not active.cancel_event.is_set():
                cancel_run(session_id)
                push_event(session_id, SSEEventType.task_cancelled, {
                    "run_id": active.run_id,
                    "reason": "user_cancel_trigger",
                })
                log.info("[%s] 取消触发词检测 — 已取消活动运行", sid)
                return user_msg_id
            # No active run — treat as a normal message (user might just be saying "stop" in conversation)

        # ── Active run guard: if a run is already in progress, enqueue the message ──
        active = get_active_run(session_id)
        if active and not active.cancel_event.is_set():
            entry = enqueue_task(session_id, content, role, mode="followup")
            queue = get_queue(session_id)
            push_event(session_id, SSEEventType.task_queued, {
                "queue_depth": len(queue.items),
                "mode": entry.mode,
                "content_preview": content[:100],
            })
            log.info("[%s] 活动运行进行中 — 消息已入队（followup）队列深度=%d", sid, len(queue.items))
            return user_msg_id

        # ── Register this run for cancel/steer coordination ──
        assistant_id = str(time.time_ns())
        run_handle = register_run(session_id, assistant_id)

        llm_messages = await self._build_llm_messages(session, history)
        base_system_prompt = llm_messages[0]["content"] if llm_messages and llm_messages[0]["role"] == "system" else ""

        model = session.model or settings.default_model
        session_type = "child" if session.parent_session_id else "full"
        tools = get_tool_definitions(session_type)
        tool_defs = tools if tools else None

        log.info("[%s] Agent循环启动 — model=%s session_type=%s 工具数=%d 历史消息=%d",
                 sid, model, session_type, len(tools) if tools else 0, len(history))

        # Clear stale TodoWrite state from previous agent loops in this session
        from app.agent.tools.todo_write import clear_session_todos
        clear_session_todos(session_id)

        loop_start = time.perf_counter()
        reasoning_reprompt_done = False
        all_todos_done = False
        execution_count = 0
        max_iterations = settings.max_plan_steps

        # Notify frontend immediately so it can show a loading indicator
        push_event(session_id, SSEEventType.stream_start, {"message_id": assistant_id})
        # Send acknowledgement so user knows the question was received and being processed
        push_event(session_id, SSEEventType.user_ack, {
            "message_id": assistant_id,
            "message": "已接收到您的问题，正在分析处理中…",
        })

        try:
            # Overflow recovery: max retries before giving up
            overflow_attempts = 0
            for iteration in range(max_iterations):
                # ── Cancel check: stop at safe checkpoint if cancel was requested ──
                if run_handle.cancel_event.is_set():
                    log.info("[%s] 第%d轮 — 检测到取消信号，终止循环", sid, iteration)
                    current_content = "（任务已被取消。）"
                    push_event(session_id, SSEEventType.text_delta, {
                        "message_id": assistant_id, "delta": current_content,
                    })
                    final_msg = await msg_dao.create(
                        session_id=session_id,
                        role="assistant",
                        content=current_content,
                        token_count=0,
                    )
                    push_event(session_id, SSEEventType.message_done, {
                        "message_id": final_msg.id,
                        "streaming_message_id": assistant_id,
                        "content": current_content,
                        "role": "assistant",
                        "token_count": 0,
                        "stop_reason": "cancelled",
                    })
                    break

                # ── Microcompact: clear old tool results before each API call ──
                if settings.microcompact_enabled:
                    self._microcompact_tool_results(sid, llm_messages)

                # ── Proactive context trim ──
                self._trim_context_if_needed(sid, llm_messages)

                # ── Proactive pre-API check: compress if near context window limit ──
                # Uses absolute-offset threshold: contextWindow - maxOutput - buffer
                # matching Claude Code's approach. More predictable than a percentage.
                estimated_tokens = int(
                    sum(len(str(m.get("content") or "")) for m in llm_messages) / _CHARS_PER_TOKEN
                )
                effective_window = min(settings.context_window_tokens, session.max_tokens or settings.context_window_tokens)
                proactive_threshold = effective_window - settings.max_output_tokens - settings.auto_compact_buffer_tokens
                if proactive_threshold > 0 and estimated_tokens > proactive_threshold:
                    log.warning("[%s] 第%d轮 — 上下文接近上限 (~%d/%d tokens)，主动压缩",
                                sid, iteration, estimated_tokens, effective_window)
                    try:
                        compressed = await compress_if_needed(self._employee_id, session_id, force=True)
                    except Exception as _ce:
                        log.warning("[%s] 主动压缩失败: %s", sid, _ce)
                        compressed = False

                    if compressed:
                        history, _ = await msg_dao.get_history(session_id, limit=settings.history_load_limit)
                        llm_messages = await self._build_llm_messages(session, history)
                        base_system_prompt = llm_messages[0]["content"] if llm_messages and llm_messages[0]["role"] == "system" else ""
                        self._trim_context_if_needed(sid, llm_messages)
                        estimated_tokens = int(
                            sum(len(str(m.get("content") or "")) for m in llm_messages) / _CHARS_PER_TOKEN
                        )
                        log.info("[%s] 压缩后重建消息: 估算=%d tokens，继续任务", sid, estimated_tokens)

                    if estimated_tokens > proactive_threshold:
                        log.error("[%s] 第%d轮 — 上下文过长 (~%d tokens)，压缩后仍超限，终止循环",
                                  sid, iteration, estimated_tokens)
                        current_content = (
                            "（当前任务上下文已超出模型处理上限，无法继续。"
                            "请简化任务或开启新对话后重试。）"
                        )
                        push_event(session_id, SSEEventType.text_delta, {
                            "message_id": assistant_id, "delta": current_content,
                        })
                        final_msg = await msg_dao.create(
                            session_id=session_id,
                            role="assistant",
                            content=current_content,
                            token_count=0,
                        )
                        push_event(session_id, SSEEventType.message_done, {
                            "message_id": final_msg.id,
                            "streaming_message_id": assistant_id,
                            "content": current_content,
                            "role": "assistant",
                            "token_count": 0,
                            "stop_reason": "context_limit",
                        })
                        break

                log.info("[%s] 第%d轮 — 调用LLM（消息数=%d 估算=%dtokens）",
                         sid, iteration, len(llm_messages), estimated_tokens)
                # Inject current todo progress into system message so LLM sees it.
                # When all todos are completed, prompt the LLM to produce final answer.
                effective_tool_defs = tool_defs
                if base_system_prompt and llm_messages and llm_messages[0]["role"] == "system":
                    todos = get_session_todos(session_id)
                    if todos and all(t.get("status") == "completed" for t in todos):
                        llm_messages[0]["content"] = (
                            base_system_prompt
                            + "\n\n所有任务已完成，请直接给出最终的文字回答，不要调用任何工具。"
                        )
                        # Remove TodoWrite to prevent the model from looping on it
                        if effective_tool_defs:
                            effective_tool_defs = [
                                t for t in effective_tool_defs
                                if t.get("function", {}).get("name") != "TodoWrite"
                            ]
                    else:
                        todo_ctx = todo_summary_for_llm(session_id)
                        if todo_ctx:
                            log.info("[%s] 第%d轮 — 注入 Todo 上下文到 LLM:\n%s", sid, iteration, todo_ctx)
                            llm_messages[0]["content"] = base_system_prompt + "\n\n" + todo_ctx
                        else:
                            llm_messages[0]["content"] = base_system_prompt

                # ── LLM call with reactive overflow recovery ──
                # If the LLM returns a context overflow error, compress and retry
                # instead of failing immediately (matching OpenClaw's approach).
                try:
                    stream = await self._llm_router.chat(
                        model=model,
                        messages=llm_messages,
                        tools=effective_tool_defs,
                        stream=True,
                    )
                except ContextOverflowError:
                    overflow_attempts += 1
                    if overflow_attempts > settings.max_overflow_retries:
                        log.error("[%s] 第%d轮 — 上下文溢出恢复失败（已达最大重试次数 %d），终止",
                                  sid, iteration, settings.max_overflow_retries)
                        raise
                    log.warning("[%s] 第%d轮 — 上下文溢出，触发压缩恢复（第%d/%d次）",
                                sid, iteration, overflow_attempts, settings.max_overflow_retries)
                    try:
                        compressed = await compress_if_needed(self._employee_id, session_id, force=True)
                    except Exception as _ce:
                        log.warning("[%s] 溢出恢复压缩失败: %s", sid, _ce)
                        compressed = False

                    if compressed:
                        history, _ = await msg_dao.get_history(session_id, limit=settings.history_load_limit)
                        llm_messages = await self._build_llm_messages(session, history)
                        base_system_prompt = llm_messages[0]["content"] if llm_messages and llm_messages[0]["role"] == "system" else ""
                        self._trim_context_if_needed(sid, llm_messages)
                        log.info("[%s] 溢出恢复：压缩成功，重试 LLM 调用", sid)
                        continue  # retry the iteration
                    else:
                        log.warning("[%s] 溢出恢复：压缩失败，继续尝试", sid)
                        continue  # still try again (may hit circuit breaker)

                log.info("[%s] 第%d轮 — 流式响应已建立", sid, iteration)

                current_content = ""
                reasoning_content = ""
                thinking_started = False
                thinking_ended = False
                in_think_tag = False
                think_buffer = ""
                tool_calls_accum = []
                total_tokens = 0
                steered = False

                try:
                    run_handle.is_streaming = True
                    async for chunk in stream:
                        # ── Cancel check during streaming ──
                        if run_handle.cancel_event.is_set():
                            log.info("[%s] 第%d轮 — 流式传输中检测到取消信号", sid, iteration)
                            # Close the underlying stream to abort the LLM call
                            if hasattr(stream, "close"):
                                try:
                                    await stream.close()
                                except Exception:
                                    pass
                            break

                        # ── Steer check during streaming ──
                        try:
                            steer_text = run_handle.steer_queue.get_nowait()
                        except asyncio.QueueEmpty:
                            steer_text = None
                        if steer_text is not None:
                            log.info("[%s] 第%d轮 — 流式传输中收到 steer 指令", sid, iteration)
                            if hasattr(stream, "close"):
                                try:
                                    await stream.close()
                                except Exception:
                                    pass
                            # Discard partially-accumulated tool calls — their
                            # arguments are truncated mid-stream and would fail
                            # JSON parsing if executed (e.g. create_artifact).
                            # The LLM will re-emit them (adjusted for the steer)
                            # in the next iteration.
                            if tool_calls_accum:
                                log.info("[%s] 第%d轮 — steer 丢弃 %d 个未完成的工具调用",
                                         sid, iteration, len(tool_calls_accum))
                                tool_calls_accum = []
                            # Inject steer text as user message and re-prompt.
                            # Wording follows OpenClaw's steer semantics: the user is
                            # supplementing the active run, not forcing a replan —
                            # the LLM should judge whether to adjust the plan.
                            llm_messages.append({
                                "role": "user",
                                "content": (
                                    f"[用户补充信息] {steer_text}\n"
                                    "（请结合当前任务和此信息，判断是否需要调整当前 plan 和执行。）"
                                ),
                            })
                            push_event(session_id, SSEEventType.task_steered, {
                                "run_id": assistant_id,
                                "content_preview": steer_text[:100],
                            })
                            run_handle.is_streaming = False
                            steered = True
                            # Break out of streaming; the outer loop will re-call LLM
                            break

                        if not chunk.choices:
                            if chunk.usage:
                                total_tokens = chunk.usage.total_tokens
                            continue
                        delta = chunk.choices[0].delta

                        if hasattr(delta, "reasoning_content") and delta.reasoning_content:
                            reasoning_content += delta.reasoning_content
                            if not thinking_started:
                                push_event(session_id, SSEEventType.thinking_start, {
                                    "message_id": assistant_id, "delta": "",
                                })
                                thinking_started = True
                                log.info("[%s] 第%d轮 — 开始思考（reasoning_content字段）",
                                         sid, iteration)
                            push_event(session_id, SSEEventType.thinking_delta, {
                                "message_id": assistant_id,
                                "delta": delta.reasoning_content,
                            })

                        if delta.content:
                            text = delta.content
                            for char in text:
                                think_buffer += char
                                if not in_think_tag:
                                    if _THINK_START_RE.search(think_buffer):
                                        in_think_tag = True
                                        if not thinking_started:
                                            push_event(session_id, SSEEventType.thinking_start, {
                                                "message_id": assistant_id, "delta": "",
                                            })
                                            thinking_started = True
                                            log.info("[%s] 第%d轮 — 开始思考（<think>标签）",
                                                     sid, iteration)
                                        before_tag = _THINK_START_RE.sub("", think_buffer, count=1)
                                        think_buffer = ""
                                        if before_tag.strip():
                                            current_content += before_tag
                                            push_event(session_id, SSEEventType.text_delta, {
                                                "message_id": assistant_id, "delta": before_tag,
                                            })
                                    elif len(think_buffer) > 20:
                                        current_content += think_buffer
                                        push_event(session_id, SSEEventType.text_delta, {
                                            "message_id": assistant_id, "delta": think_buffer,
                                        })
                                        think_buffer = ""
                                else:
                                    if _THINK_END_RE.search(think_buffer):
                                        in_think_tag = False
                                        think_content = _THINK_END_RE.sub("", think_buffer, count=1)
                                        reasoning_content += think_content
                                        push_event(session_id, SSEEventType.thinking_delta, {
                                            "message_id": assistant_id, "delta": think_content,
                                        })
                                        push_event(session_id, SSEEventType.thinking_end, {
                                            "message_id": assistant_id,
                                        })
                                        thinking_ended = True
                                        log.info("[%s] 第%d轮 — 思考结束（<think>标签）— 思考内容长度=%d",
                                                 sid, iteration, len(reasoning_content))
                                        think_buffer = ""
                                    elif len(think_buffer) > 5:
                                        # Safe-flush: keep any trailing prefix of </think> to avoid splitting the tag
                                        think_end_tag = "</think>"
                                        keep = ""
                                        for i in range(len(think_end_tag) - 1, 0, -1):
                                            if think_buffer.endswith(think_end_tag[:i]):
                                                keep = think_buffer[-i:]
                                                break
                                        flush_part = think_buffer[:-len(keep)] if keep else think_buffer
                                        if flush_part:
                                            reasoning_content += flush_part
                                            push_event(session_id, SSEEventType.thinking_delta, {
                                                "message_id": assistant_id, "delta": flush_part,
                                            })
                                        think_buffer = keep

                            if think_buffer and not in_think_tag:
                                current_content += think_buffer
                                push_event(session_id, SSEEventType.text_delta, {
                                    "message_id": assistant_id, "delta": think_buffer,
                                })
                                think_buffer = ""

                        if delta.tool_calls:
                            for tc_delta in delta.tool_calls:
                                idx = tc_delta.index
                                while len(tool_calls_accum) <= idx:
                                    tool_calls_accum.append({"id": "", "name": "", "arguments": ""})
                                if tc_delta.id:
                                    tool_calls_accum[idx]["id"] = tc_delta.id
                                    push_event(session_id, SSEEventType.tool_call_start, {
                                        "tool_call_id": tc_delta.id,
                                        "tool_name": tc_delta.function.name if tc_delta.function and tc_delta.function.name else tool_calls_accum[idx]["name"],
                                        "args_preview": "",
                                    })
                                if tc_delta.function:
                                    if tc_delta.function.name:
                                        tool_calls_accum[idx]["name"] = tc_delta.function.name
                                    if tc_delta.function.arguments:
                                        tool_calls_accum[idx]["arguments"] += tc_delta.function.arguments
                                        push_event(session_id, SSEEventType.tool_call_delta, {
                                            "tool_call_id": tool_calls_accum[idx]["id"],
                                            "args_delta": tc_delta.function.arguments,
                                            "partial_args": tool_calls_accum[idx]["arguments"],
                                        })

                        if chunk.usage:
                            total_tokens = chunk.usage.total_tokens

                except httpx.ReadTimeout:
                    run_handle.is_streaming = False
                    friendly_msg = "网络连接超时，模型响应时间较长。请稍后重试，或尝试简化问题后再次提问。"
                    log.warning("[%s] 第%d轮 — LLM流式响应超时，给用户友好提示", sid, iteration)
                    push_event(session_id, SSEEventType.text_delta, {
                        "message_id": assistant_id, "delta": friendly_msg,
                    })
                    # Persist the timeout message as an normal assistant message
                    final_msg = await msg_dao.create(
                        session_id=session_id,
                        role="assistant",
                        content=friendly_msg,
                        token_count=0,
                    )
                    push_event(session_id, SSEEventType.message_done, {
                        "message_id": final_msg.id,
                        "streaming_message_id": assistant_id,
                        "content": friendly_msg,
                        "role": "assistant",
                        "token_count": 0,
                        "stop_reason": "read_timeout",
                    })
                    break

                # ── Post-streaming: handle cancel/steer break-out ──
                run_handle.is_streaming = False

                # If cancelled during streaming, break out of the iteration loop
                if run_handle.cancel_event.is_set():
                    log.info("[%s] 第%d轮 — 流已取消，终止循环", sid, iteration)
                    if not current_content.strip():
                        current_content = "（任务已被取消。）"
                        push_event(session_id, SSEEventType.text_delta, {
                            "message_id": assistant_id, "delta": current_content,
                        })
                    final_msg = await msg_dao.create(
                        session_id=session_id,
                        role="assistant",
                        content=current_content.strip() or "（任务已被取消。）",
                        reasoning_content=reasoning_content.strip() or None,
                        token_count=total_tokens,
                    )
                    push_event(session_id, SSEEventType.message_done, {
                        "message_id": final_msg.id,
                        "streaming_message_id": assistant_id,
                        "content": current_content.strip() or "（任务已被取消。）",
                        "role": "assistant",
                        "token_count": total_tokens,
                        "stop_reason": "cancelled",
                    })
                    break

                # If steered during streaming, re-prompt LLM with the injected
                # steer text. Partial tool calls were already discarded in the
                # steer block, so this is safe regardless of what was streamed.
                if steered:
                    log.info("[%s] 第%d轮 — steer 后重新提示 LLM", sid, iteration)
                    continue

                # Flush remaining think buffer
                if think_buffer and in_think_tag:
                    reasoning_content += think_buffer
                    push_event(session_id, SSEEventType.thinking_delta, {
                        "message_id": assistant_id, "delta": think_buffer,
                    })
                    think_buffer = ""

                if thinking_started and not in_think_tag and not thinking_ended:
                    push_event(session_id, SSEEventType.thinking_end, {"message_id": assistant_id})
                    thinking_ended = True
                    log.info("[%s] 第%d轮 — 思考结束（流结束后）— 思考内容长度=%d",
                             sid, iteration, len(reasoning_content))

                log.info("[%s] 第%d轮 — 流接收完毕: 文本长度=%d 思考长度=%d token数=%d 工具调用数=%d",
                         sid, iteration, len(current_content), len(reasoning_content), total_tokens, len(tool_calls_accum))

                execution_count += 1

                # Accumulate token usage into session for compressor threshold tracking
                if total_tokens > 0:
                    try:
                        await session_dao.add_token_count(session_id, total_tokens)
                    except Exception as e:
                        log.warning("[%s] 更新session token_count失败: %s", sid, e)

                # ── Branch: tool calls present → execute and loop ──────────
                if tool_calls_accum:
                    log.info("[%s] 第%d轮 — 检测到工具调用: %s",
                             sid, iteration, [tc["name"] for tc in tool_calls_accum])
                    # Emit tool_call_end for all tools first (args streaming complete)
                    for tc in tool_calls_accum:
                        push_event(session_id, SSEEventType.tool_call_end, {
                            "tool_call_id": tc["id"],
                            "tool_name": tc["name"],
                            "args": tc["arguments"],
                        })
                        args_preview = tc["arguments"][:_LOG_ARGS_MAX] + ("…" if len(tc["arguments"]) > _LOG_ARGS_MAX else "")
                        log.info("[%s] 工具 [%s] %s — 执行中 | 参数: %s",
                                 sid, tc["id"][:8], tc["name"], args_preview)
                    # Execute: read-only tools concurrently, write tools serially
                    await self._execute_tools_batch(session_id, tool_calls_accum)

                    # Persist intermediate assistant message (with tool_calls) to DB
                    inter_msg = await msg_dao.create(
                        session_id=session_id,
                        role="assistant",
                        content=current_content.strip() or None,
                        tool_calls=json.dumps(tool_calls_accum, ensure_ascii=False),
                        reasoning_content=reasoning_content.strip() or None,
                        token_count=total_tokens,
                    )
                    log.info("[%s] 第%d轮 — 中间助手消息已保存 — msg_id=%s 工具调用=%s",
                             sid, iteration, inter_msg.id, [tc["name"] for tc in tool_calls_accum])

                    # Build formatted tool_calls for OpenAI message format
                    formatted_tool_calls = [
                        {"id": tc["id"], "type": "function", "function": {"name": tc["name"], "arguments": tc["arguments"]}}
                        for tc in tool_calls_accum
                    ]
                    llm_messages.append({
                        "role": "assistant",
                        "content": current_content,
                        "tool_calls": formatted_tool_calls,
                    })

                    # Persist tool result messages to DB and add to context
                    for tc in tool_calls_accum:
                        result_content = self._tool_results.get(tc["id"], "")
                        tool_msg = await msg_dao.create(
                            session_id=session_id,
                            role="tool",
                            content=result_content,  # full result persisted to DB
                            tool_call_id=tc["id"],
                        )
                        log.info("[%s] 第%d轮 — 工具结果消息已保存 — msg_id=%s 工具=[%s] %s",
                                 sid, iteration, tool_msg.id, tc["id"][:8], tc["name"])
                        # Cap large results inline (HTML pages can be 50-100KB each)
                        inline_content = result_content
                        if len(inline_content) > _TOOL_RESULT_INLINE_CAP:
                            inline_content = inline_content[:_TOOL_RESULT_INLINE_CAP] + "\n…[内容过长已截断，完整结果已保存]"
                            log.info("[%s] 工具 [%s] 结果入队截断: %d → %d 字符",
                                     sid, tc["id"][:8], len(result_content), _TOOL_RESULT_INLINE_CAP)
                        llm_messages.append({
                            "role": "tool",
                            "tool_call_id": tc["id"],
                            "content": inline_content,
                        })

                    log.info("[%s] 第%d轮 — 工具结果已就绪，继续循环（%d个工具调用）",
                             sid, iteration, len(tool_calls_accum))
                    # When all todos are completed, prompt LLM to produce final answer
                    todos = get_session_todos(session_id)
                    if todos and all(t.get("status") == "completed" for t in todos):
                        if not all_todos_done:
                            all_todos_done = True
                            log.info("[%s] 第%d轮 — 所有任务已完成，追加提示让LLM给出最终回答", sid, iteration)
                            llm_messages.append({
                                "role": "user",
                                "content": "所有任务已完成，请直接给出最终的文字回答，不要调用任何工具。",
                            })
                        else:
                            # LLM still called tools after being told to stop — try re-prompt or force final answer
                            log.info("[%s] 第%d轮 — 所有任务已完成但LLM仍调用工具", sid, iteration)
                            if not current_content.strip() and reasoning_content.strip() and not reasoning_reprompt_done:
                                log.info("[%s] 第%d轮 — force_break: 文本为空但有思考，补充提示获取最终回答", sid, iteration)
                                reasoning_reprompt_done = True
                                reasoning_ctx = reasoning_content[:800]
                                llm_messages.append({"role": "assistant", "content": f"<think>{reasoning_ctx}</think>"})
                                llm_messages.append({"role": "user", "content": "所有任务已完成，请基于以上思考直接给出你的最终文字回答，不要重复思考过程，不要调用任何工具。"})
                                continue
                            # Re-prompt failed or no reasoning — force break with best available content
                            log.info("[%s] 第%d轮 — 所有任务已完成但LLM仍调用工具，强制终止循环", sid, iteration)
                            final_text = current_content.strip()
                            if not final_text and reasoning_content.strip():
                                final_text = re.sub(r'</?think(?:ing)?>', '', reasoning_content, flags=re.IGNORECASE).strip()
                            if not final_text:
                                final_text = "（所有任务已完成。）"
                            push_event(session_id, SSEEventType.text_delta, {
                                "message_id": assistant_id, "delta": final_text,
                            })
                            final_msg = await msg_dao.create(
                                session_id=session_id,
                                role="assistant",
                                content=final_text,
                                reasoning_content=reasoning_content.strip() or None,
                                token_count=total_tokens,
                            )
                            push_event(session_id, SSEEventType.message_done, {
                                "message_id": final_msg.id,
                                "streaming_message_id": assistant_id,
                                "content": final_text,
                                "role": "assistant",
                                "token_count": total_tokens,
                                "stop_reason": "force_break",
                            })
                            log.info("[%s] force_break最终回答已保存 — msg_id=%s streaming_id=%s 文本长度=%d",
                                     sid, final_msg.id, assistant_id, len(final_text))
                            break
                    # Check max executions — the counter was already incremented above
                    if execution_count >= max_iterations:
                        log.warning("[%s] 达到最大执行次数 %d，强制终止", sid, max_iterations)
                        # Fall through to final response
                        current_content = "（已达到最大执行步骤限制，任务中止。）"
                        push_event(session_id, SSEEventType.text_delta, {
                            "message_id": assistant_id, "delta": current_content,
                        })
                    else:
                        continue

                # ── Branch: no tool calls → final response, done ──────────
                # Safety net: auto-complete remaining todos if the model
                # produced a final answer without marking all tasks as completed.
                if force_complete_todos(session_id):
                    log.info("[%s] 第%d轮 — 自动完成剩余待办任务", sid, iteration)
                # Safety: if model produced empty content, inject a fallback
                if not current_content.strip():
                    if reasoning_content.strip() and not reasoning_reprompt_done:
                        # Model reasoned but produced no text — re-prompt once, passing reasoning as context
                        log.info("[%s] 第%d轮 — 文本内容为空但有思考内容，补充提示以获取文字回答",
                                 sid, iteration)
                        reasoning_reprompt_done = True
                        reasoning_ctx = reasoning_content[:800]
                        llm_messages.append({"role": "assistant", "content": f"<think>{reasoning_ctx}</think>"})
                        llm_messages.append({"role": "user", "content": "请基于以上思考直接给出你的文字回答，不要重复思考过程。"})
                        continue
                    elif reasoning_content.strip():
                        # Re-prompt also produced no text — surface the reasoning as the response
                        log.warning("[%s] 第%d轮 — 补充提示后文本仍为空，将思考内容作为回答",
                                    sid, iteration)
                        current_content = re.sub(r'</?think(?:ing)?>', '', reasoning_content, flags=re.IGNORECASE).strip()
                        push_event(session_id, SSEEventType.text_delta, {
                            "message_id": assistant_id, "delta": current_content,
                        })
                    else:
                        log.warning("[%s] 第%d轮 — 最终内容为空（无思考内容），注入兜底回复",
                                    sid, iteration)
                        current_content = "（未生成文字回复，请重试或换个问法。）"
                        push_event(session_id, SSEEventType.text_delta, {
                            "message_id": assistant_id, "delta": current_content,
                        })

                final_msg = await msg_dao.create(
                    session_id=session_id,
                    role="assistant",
                    content=current_content.strip(),
                    reasoning_content=reasoning_content.strip() or None,
                    token_count=total_tokens,
                )
                elapsed = time.perf_counter() - loop_start
                log.info("[%s] 最终回答已保存 — msg_id=%s 第%d轮 token数=%d 文本长度=%d 思考长度=%d 耗时=%.2fs",
                         sid, final_msg.id, iteration, total_tokens, len(current_content), len(reasoning_content), elapsed)
                push_event(session_id, SSEEventType.message_done, {
                    "message_id": final_msg.id,
                    "streaming_message_id": assistant_id,
                    "content": current_content,
                    "role": "assistant",
                    "token_count": total_tokens,
                    "stop_reason": "end_turn",
                })
                log.info("[%s] message_done事件已推送 — msg_id=%s streaming_id=%s", sid, final_msg.id, assistant_id)

                # Fire-and-forget: per-turn incremental distillation → short_term
                # Ensures short sessions that never trigger compression still get
                # their memories extracted (matching Claude Code's extractMemories).
                if settings.memory_distill_enabled:
                    try:
                        from app.agent.memory_distiller import (
                            get_last_distilled_message_id, run_distillation_task,
                        )
                        last_distilled = get_last_distilled_message_id(session_id)
                        new_msgs: list[dict] = []
                        found_last = last_distilled is None
                        for m in history:
                            if m.role not in ("user", "assistant"):
                                continue
                            if not found_last:
                                if m.id == last_distilled:
                                    found_last = True
                                continue
                            new_msgs.append({"role": m.role, "content": m.content or ""})

                        if new_msgs and len(new_msgs) >= settings.memory_distill_min_messages:
                            last_msg_id = history[-1].id if history else None
                            if last_msg_id:
                                asyncio.create_task(
                                    run_distillation_task(
                                        self._employee_id, session_id, new_msgs,
                                        self._session_factory, last_msg_id,
                                    )
                                )
                    except Exception as e:
                        log.warning("[%s] Per-turn distillation launch failed: %s", sid, e)

                # context compression: triggers pre-compress memory flush + distillation if session token_count > max_tokens
                try:
                    compressed = await compress_if_needed(self._employee_id, session_id)
                    if compressed:
                        log.info("[%s] 对话结束后上下文已压缩", sid)
                except Exception as e:
                    log.warning("[%s] 上下文压缩失败: %s", sid, e)

                # L3 cleanup: remove per-session skill/subagent temp assets
                try:
                    from app.agent.skill_asset_loader import cleanup_session_assets
                    cleanup_session_assets(session_id)
                except Exception as e:
                    log.warning("[%s] L3 临时资产清理失败: %s", sid, e)
                break

            else:
                # Max iterations reached without a final text response
                fallback = current_content or "[已达最大执行步骤限制，请简化任务后重试]"
                log.warning("[%s] 已达最大执行次数 (%d) — 耗时=%.2fs",
                            sid, max_iterations, time.perf_counter() - loop_start)
                if force_complete_todos(session_id):
                    log.info("[%s] 达到最大轮次 — 自动完成剩余待办任务", sid)
                final_msg = await msg_dao.create(
                    session_id=session_id,
                    role="assistant",
                    content=fallback,
                    token_count=total_tokens,
                )
                log.info("[%s] 兜底消息已保存 — msg_id=%s", sid, final_msg.id)
                push_event(session_id, SSEEventType.message_done, {
                    "message_id": final_msg.id,
                    "streaming_message_id": assistant_id,
                    "content": fallback,
                    "role": "assistant",
                    "token_count": total_tokens,
                    "stop_reason": "max_iterations",
                })
                log.info("[%s] message_done事件已推送（最大轮次）— msg_id=%s", sid, final_msg.id)

            # ── Post-run: drain queued tasks ──
            # Unregister THIS run before draining so the recursive
            # process_message call in the drain doesn't trip the active-run
            # guard (line ~145) and re-enqueue the task — that would loop
            # forever, flooding the frontend with task_queued events.
            # The finally block below is a no-op pop when this ran first.
            unregister_run(session_id, assistant_id)
            await self._drain_queued_tasks(session_id, session, msg_dao, session_dao)

        except Exception as exc:
            log.error("[%s] Agent循环异常: %s", sid, exc, exc_info=True)
            push_event(session_id, SSEEventType.error, {
                "error_code": "BX_AGENT_7001",
                "message": str(exc),
                "recoverable": False,
            })
            _is_content_blocked = isinstance(exc, openai.APIError)
            _err_text = (
                "（模型内容被安全策略拦截，请换个问法后重试。）"
                if _is_content_blocked
                else "（服务处理异常，请稍后重试。）"
            )
            try:
                _err_msg = await msg_dao.create(
                    session_id=session_id,
                    role="assistant",
                    content=_err_text,
                    token_count=0,
                )
                push_event(session_id, SSEEventType.text_delta, {
                    "message_id": assistant_id, "delta": _err_text,
                })
                push_event(session_id, SSEEventType.message_done, {
                    "message_id": _err_msg.id,
                    "streaming_message_id": assistant_id,
                    "content": _err_text,
                    "role": "assistant",
                    "token_count": 0,
                    "stop_reason": "api_error" if _is_content_blocked else "internal_error",
                })
            except Exception as _save_exc:
                log.error("[%s] 兜底错误消息保存失败: %s", sid, _save_exc)

        finally:
            # Always unregister the run, even on errors
            unregister_run(session_id, assistant_id)

        return user_msg_id

    async def _handle_compact_command(
        self, session_id: str, session, content: str, user_msg_id: str,
        sid: str, msg_dao, session_dao,
    ) -> str:
        """Handle /compact [custom instructions] — manual context compression.

        Triggers compression immediately without going through the agent loop.
        Returns token counts before/after so the user can see the result.
        """
        # Extract optional custom instructions
        custom_instructions = content[len("/compact"):].strip()

        # Get pre-compression token state
        session_before = await session_dao.get_by_id(session_id)
        tokens_before = session_before.token_count if session_before else 0
        max_tokens = session_before.max_tokens if session_before else 0
        tokens_after = tokens_before

        assistant_id = str(time.time_ns())
        push_event(session_id, SSEEventType.stream_start, {"message_id": assistant_id})

        if tokens_before <= 0:
            result_text = "（当前会话没有需要压缩的上下文。）"
        else:
            try:
                compressed = await compress_if_needed(self._employee_id, session_id, force=True)
            except Exception as e:
                log.error("[%s] /compact 压缩失败: %s", sid, e)
                compressed = False

            if compressed:
                session_after = await session_dao.get_by_id(session_id)
                tokens_after = session_after.token_count if session_after else 0
                freed = tokens_before - tokens_after
                result_text = (
                    f"上下文已压缩。\n\n"
                    f"- 压缩前：{tokens_before:,} tokens / {max_tokens:,} tokens\n"
                    f"- 压缩后：{tokens_after:,} tokens\n"
                    f"- 释放：{freed:,} tokens ({freed * 100 // max(tokens_before, 1)}%)"
                )
                if custom_instructions:
                    result_text += f"\n- 自定义指令：'{custom_instructions}'"
            else:
                result_text = (
                    f"压缩未触发。当前 {tokens_before:,} tokens / {max_tokens:,} tokens，"
                    f"可能消息数不足（需至少 5 条）或已是最新状态。"
                )

        push_event(session_id, SSEEventType.text_delta, {
            "message_id": assistant_id, "delta": result_text,
        })

        final_msg = await msg_dao.create(
            session_id=session_id,
            role="assistant",
            content=result_text,
            token_count=0,
        )
        push_event(session_id, SSEEventType.message_done, {
            "message_id": final_msg.id,
            "streaming_message_id": assistant_id,
            "content": result_text,
            "role": "assistant",
            "token_count": 0,
            "stop_reason": "end_turn",
        })
        log.info("[%s] /compact 完成 — tokens_before=%d tokens_after=%d",
                 sid, tokens_before, tokens_after)
        return user_msg_id

    async def _drain_queued_tasks(
        self, session_id: str, session, msg_dao, session_dao,
    ) -> None:
        """Drain queued followup tasks after the current run completes.

        Processes tasks in FIFO order. Each followup task triggers a full
        agent loop (recursive call to process_message). Collect-mode tasks
        are skipped during auto-drain; they must be explicitly consumed.
        """
        from app.agent.task_manager import dequeue_task, has_queued_tasks

        while has_queued_tasks(session_id):
            entry = dequeue_task(session_id)
            if entry is None:
                break
            if entry.mode == "collect":
                # Don't auto-drain collect-mode tasks
                continue
            log.info(
                "[%s] 处理队列任务 — mode=%s 预览=%r",
                session_id[:8], entry.mode, entry.content[:80],
            )
            try:
                await self.process_message(
                    session_id=session_id,
                    content=entry.content,
                    role=entry.role,
                )
            except Exception as e:
                log.error(
                    "[%s] 队列任务处理失败: %s", session_id[:8], e,
                )

    # Tools whose results are safe to clear in microcompact (read/search/fetch tools)
    _MICROCOMPACTABLE_TOOLS = frozenset({
        "web_search", "web_fetch", "file_read", "file_search",
        "bash", "grep", "glob",
    })

    def _microcompact_tool_results(self, sid: str, llm_messages: list[dict]) -> None:
        """Clear old tool results from compactable tools before each API call.

        Keeps the most recent N tool results at full length, replaces older ones
        with a placeholder. This matches Claude Code's microcompact approach:
        cheap, non-destructive, and effective at reducing token usage.

        Only clears results from read/search/fetch tools — never touches
        write tools (file_write, TodoWrite, etc.) whose results carry state.
        """
        keep_recent = settings.microcompact_keep_recent
        # Find all tool result indices for compactable tools
        compactable_indices = []
        for i, m in enumerate(llm_messages):
            if m.get("role") != "tool":
                continue
            tc_id = m.get("tool_call_id", "")
            if not tc_id:
                continue
            # Find the corresponding assistant message with tool_calls to get the tool name
            for j in range(i - 1, -1, -1):
                prev = llm_messages[j]
                if prev.get("role") == "assistant" and prev.get("tool_calls"):
                    for tc in prev["tool_calls"]:
                        if tc.get("id") == tc_id:
                            if tc.get("function", {}).get("name") in self._MICROCOMPACTABLE_TOOLS:
                                compactable_indices.append(i)
                            break
                    break

        if len(compactable_indices) <= keep_recent:
            return

        # Clear older tool results, keep most recent N
        to_clear = compactable_indices[:-keep_recent]
        cleared = 0
        for i in to_clear:
            content = llm_messages[i].get("content") or ""
            if content and content != _MICROCOMPACT_PLACEHOLDER:
                llm_messages[i] = {
                    **llm_messages[i],
                    "content": _MICROCOMPACT_PLACEHOLDER,
                }
                cleared += 1

        if cleared:
            log.debug("[%s] microcompact: cleared %d old tool results (kept %d recent)",
                      sid, cleared, keep_recent)

    def _trim_context_if_needed(self, sid: str, llm_messages: list[dict]) -> None:
        """Two-level trim: soft (early) and hard (near-limit).

        Soft: keep last 2 tool results full, truncate rest to 400 chars.
        Hard: keep last 1 tool result full, truncate rest to 100 chars.
        """
        total_chars = sum(len(str(m.get("content") or "")) for m in llm_messages)
        if total_chars <= _CONTEXT_TRIM_CHARS:
            return

        hard = total_chars > _CONTEXT_HARD_LIMIT_CHARS
        keep_recent = _TOOL_RESULT_HARD_RECENT if hard else _TOOL_RESULT_KEEP_RECENT
        keep_chars = _TOOL_RESULT_HARD_CHARS if hard else _TOOL_RESULT_KEEP_CHARS

        tool_indices = [i for i, m in enumerate(llm_messages) if m.get("role") == "tool"]
        trim_indices = tool_indices[:-keep_recent] if keep_recent else tool_indices
        if not trim_indices:
            return

        trimmed = 0
        for i in trim_indices:
            content = llm_messages[i].get("content") or ""
            if len(content) > keep_chars:
                llm_messages[i] = {
                    **llm_messages[i],
                    "content": content[:keep_chars] + "\n…[结果已截断]",
                }
                trimmed += 1

        if trimmed:
            new_total = sum(len(str(m.get("content") or "")) for m in llm_messages)
            log.info("[%s] 上下文裁剪(%s): 截断了 %d 条工具结果, %d → %d 字符",
                     sid, "hard" if hard else "soft", trimmed, total_chars, new_total)

    async def _run_single_tool(self, session_id: str, tc: dict) -> str:
        """Execute one tool call, emit SSE result event, and return the result string."""
        t_start = time.perf_counter()
        result = await self._execute_tool(session_id, tc["name"], tc["arguments"], tc["id"])
        elapsed = time.perf_counter() - t_start
        is_error = result.strip().startswith('{"error"')
        result_preview = result[:_LOG_RESULT_MAX] + ("…" if len(result) > _LOG_RESULT_MAX else "")
        log.info("[%s] 工具 [%s] %s — 完成 (%.2fs) 出错=%s | 结果: %s",
                 session_id[:8], tc["id"][:8], tc["name"], elapsed, is_error, result_preview)
        push_event(session_id, SSEEventType.tool_result, {
            "tool_call_id": tc["id"],
            "tool_name": tc["name"],
            "result": "error" if is_error else "completed",
            "is_error": is_error,
        })
        return result

    async def _execute_tools_batch(self, session_id: str, tool_calls: list[dict]) -> None:
        """Execute a batch of tool calls, storing results in self._tool_results.

        Read-only tools run concurrently; write tools run serially after.
        """
        read_only = [tc for tc in tool_calls if tc["name"] in _CONCURRENT_TOOLS]
        write_ops = [tc for tc in tool_calls if tc["name"] not in _CONCURRENT_TOOLS]

        if read_only:
            results = await asyncio.gather(
                *[self._run_single_tool(session_id, tc) for tc in read_only],
                return_exceptions=True,
            )
            for tc, result in zip(read_only, results):
                if isinstance(result, Exception):
                    result = json.dumps({"error": str(result)}, ensure_ascii=False)
                self._tool_results[tc["id"]] = result

        for tc in write_ops:
            self._tool_results[tc["id"]] = await self._run_single_tool(session_id, tc)

    async def _build_llm_messages(self, session, history) -> list[dict]:
        messages = []
        session_type = "child" if session.parent_session_id else "full"

        # 1. Current timestamp (realtime, no cache)
        time_header = _build_time_header()

        # 2. Delegation goal (child session only)
        delegation_section = ""
        if session.parent_session_id and session.delegation_goal:
            delegation_section = f"[委派目标]\n{session.delegation_goal}"

        # 3. Parallel IO: user profile, memory, skills index, todo+cron
        profile_section, memory_summary, skills_index, todo_cron = await asyncio.gather(
            self._context_loader.load_user_profile(),
            self._context_loader.load_memory_summary(history=history),
            self._context_loader.load_skills_index(),
            self._context_loader.load_todo_cron_summary(),
            return_exceptions=True,
        )
        if isinstance(profile_section, Exception):
            log.warning("加载用户Profile失败: %s", profile_section)
            profile_section = ""
        if isinstance(memory_summary, Exception):
            log.error("加载记忆摘要失败: %s", memory_summary)
            memory_summary = "[记忆加载失败]\n本轮无法获取用户记忆，建议根据当前对话内容作答。"
        if isinstance(skills_index, Exception):
            log.warning("加载技能索引失败: %s", skills_index)
            skills_index = ""
        if isinstance(todo_cron, Exception):
            log.warning("加载Todo/Cron摘要失败: %s", todo_cron)
            todo_cron = ""

        # 4. Tool list (name: first-line description)
        tools_section = _build_tools_section(session_type)

        # 5. Compression break annotation
        compression_note = ""
        has_compressed = any(getattr(m, "is_compressed", 0) == 1 for m in history)
        if has_compressed:
            compression_note = (
                "[上下文说明]\n"
                "本对话含有压缩摘要（role=system、内容带\"[压缩摘要]\"字样的消息），"
                "这些是对早期对话的浓缩，不是原始消息。请将其作为背景参考。"
            )

        # 6. Runtime mode rule (SaaS or server)
        if settings.saas_mode:
            runtime_rule = (
                "IMPORTANT: This agent runs in SaaS mode on a remote server. "
                "You MUST NOT read, write, search, or edit any files on the server filesystem. "
                "All user task results should be returned directly as chat messages. "
                "The terminal tool is restricted to non-file-operation commands only."
            )
        else:
            runtime_rule = (
                "NOTE: You are a server-side agent. File paths and directories refer to the SERVER, "
                "not the user's local computer. If a task involves the user's local files (e.g. their Desktop), "
                "clarify that you can only access server-side paths and suggest alternatives."
            )

        # 6.3. Workdir rule — file output handling for skills
        workdir_rule = (
            "[文件产物处理 — Skills 文件输出规范]\n"
            "当使用 skill 产生中间文件或结果文件时，必须遵守以下规范：\n\n"
            "**1. 创建工作目录**\n"
            "python3 scripts/workdir.py create\n"
            "返回 JSON: {\"work_dir\": \"tmp-doc/{employee_id}_{uuid}/\"}\n\n"
            "**2. 在工作目录内生成文件**\n"
            "- 所有中间过程和结果文件都写入 work_dir 内\n"
            "- 不要写入 /tmp、/var/tmp 或项目源码目录\n\n"
            "**3. 上传结果文件到 MinIO**\n"
            "方式 A（推荐，一步完成上传+清理）：\n"
            "python3 scripts/workdir.py upload-result <work_dir/result_file> --source <skill-name>\n"
            "方式 B（分步，需要多个文件上传时）：\n"
            "python3 scripts/upload_artifact.py <work_dir/result_file> --user-id $SA_EMPLOYEE_ID --source <skill-name>\n"
            "python3 scripts/workdir.py cleanup --path <work_dir>\n\n"
            "**4. 异常处理**\n"
            "- upload-result 命令会在 finally 块中自动清理 work_dir\n"
            "- 即使上传失败，work_dir 也会被清理，不会残留临时文件\n"
            "- 如果任务失败，确保在最后调用 cleanup 清理 work_dir"
        )

        # 6.5. Task tracking methodology — progressive reveal with TodoWrite
        plan_methodology = (
            "[任务追踪 — 强制规则]\n"
            "**只要需要调用任何工具，你的第一个动作必须是调用 TodoWrite 创建计划。**\n"
            "无论任务看起来多简单，只要涉及工具调用，都必须先建计划，再执行。\n"
            "直接调用 web_search、web_fetch 等工具而不先建计划，是违规行为。\n\n"
            "**正确执行节奏（严格遵守）：**\n\n"
            "第1个调用：TodoWrite — 写出 3-6 个主步骤（level=1），全部 pending\n"
            "第2个调用：TodoWrite — 将第1步标为 in_progress\n"
            "第3个调用：实际工具（web_search 等）\n"
            "第4个调用：TodoWrite — 将第1步标为 completed，将第2步标为 in_progress\n"
            "第5个调用：实际工具\n"
            "……以此类推，直到所有步骤完成\n\n"
            "**步骤执行规则：**\n"
            "- 同一时刻只允许一个步骤处于 in_progress\n"
            "- 完成后立即标为 completed，不要拖延\n"
            "- 每步完成后观察结果，如后续步骤需要调整，重新调用 TodoWrite 替换整个列表\n"
            "- 未完成的步骤绝对不能标为 completed\n"
            "- **在给出最终回答前，必须调用 TodoWrite 将所有步骤标为 completed**\n\n"
            "**TodoWrite 参数格式：**\n"
            "- content: 动词开头，如「搜索天气数据」\n"
            "- activeForm: 进行时，如「正在搜索天气数据」\n"
            "- status: pending | in_progress | completed\n"
            "- level: 1=主步骤，2=子步骤，3=细节（可选）\n\n"
            "**上下文压缩时：**\n"
            "- 压缩摘要只是背景，不代表任务完成\n"
            "- 以「当前任务进度」为准，有 pending/in_progress 就继续执行"
        )

        # 7. User's custom system prompt (highest user-intent priority, placed last)
        user_prompt = session.system_prompt or ""

        # Assemble in priority order (most contextually grounding → most user-specific)
        sections = [
            time_header,
            delegation_section,
            profile_section,
            memory_summary,
            skills_index,
            todo_cron,
            tools_section,
            compression_note,
            runtime_rule,
            workdir_rule,
            plan_methodology,
            user_prompt,
        ]
        system_prompt = "\n\n".join(s for s in sections if s)

        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        # Only load user + final assistant messages from history.
        # Intermediate assistant(tool_calls) + tool result pairs are execution
        # artifacts — the final assistant message already synthesises their content,
        # so carrying them forward wastes tokens without adding context value.
        # system messages (compressed summaries) are kept as-is.
        skipped = 0
        for msg in history:
            if msg.role == "tool":
                skipped += 1
                continue
            if msg.role == "assistant" and msg.tool_calls:
                skipped += 1
                continue
            entry = {"role": msg.role, "content": msg.content or ""}
            messages.append(entry)

        if skipped:
            log.debug("_build_llm_messages: skipped %d intermediate tool/assistant messages from history", skipped)

        messages = await self._inject_slash_skill_if_needed(messages)

        return messages

    async def _inject_slash_skill_if_needed(self, messages: list[dict]) -> list[dict]:
        """If the last user message starts with /skill-name, inject skill content
        as a hidden user message immediately before it.

        The original user message is kept unchanged (stored in DB, shown in UI).
        The injected message exists only in the LLM API payload for this turn.
        """
        last_user_idx = None
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].get("role") == "user":
                last_user_idx = i
                break

        if last_user_idx is None:
            return messages

        content = messages[last_user_idx].get("content", "")
        if not isinstance(content, str) or not content.startswith("/"):
            return messages

        resolved = await self._resolve_slash_skill(content)
        if resolved is None:
            return messages

        skill_name, skill_content_md = resolved
        log.debug("Slash skill injection: '%s' (%d chars)", skill_name, len(skill_content_md))

        result = list(messages)
        result.insert(last_user_idx, {
            "role": "user",
            "content": f"[Skill: {skill_name}]\n\n{skill_content_md}",
        })
        return result

    async def _resolve_slash_skill(self, content: str) -> tuple[str, str] | None:
        """Parse /skill-name from message content and return (skill_name, content_md).

        Matching strategy: longest-prefix match against all known skill display names
        (case-insensitive). Tries sys-infra first, then DB.
        Returns None if no skill matched or content is empty.
        """
        if not content.startswith("/"):
            return None

        after_slash = content[1:]

        from app.storage.sys_infra import get_system_skill_name_map, get_system_skill_md
        from app.dao.skill_dao import SkillDAO
        from app.db.database import get_session_factory

        sys_name_map = get_system_skill_name_map()  # {display_name: dir_name}

        dao = SkillDAO(get_session_factory(), self._employee_id)
        try:
            db_index = await dao.get_index()
            db_names = [s["name"] for s in db_index]
        except Exception:
            db_names = []

        all_names = list(sys_name_map.keys()) + db_names

        # Longest-prefix match (handles skill names with spaces)
        matched_name: str | None = None
        for name in sorted(all_names, key=len, reverse=True):
            if after_slash.lower().startswith(name.lower()):
                rest = after_slash[len(name):]
                if rest == "" or rest.startswith(" "):
                    matched_name = name
                    break

        if matched_name is None:
            return None

        # sys-infra first (by display name)
        if matched_name in sys_name_map:
            dir_name = sys_name_map[matched_name]
            md = get_system_skill_md(dir_name)
            if md:
                return matched_name, md

        # DB fallback (case-insensitive search already done above)
        try:
            skill = await dao.get_by_name(matched_name)
            if skill:
                md = await dao.get_skill_md(matched_name)
                return matched_name, md or skill.content_md or ""
        except Exception as e:
            log.warning("Failed to load DB skill '%s' for slash injection: %s", matched_name, e)

        return None

    async def _execute_tool(self, session_id: str, tool_name: str, args_str: str, tool_call_id: str) -> str:
        executor = get_tool_executor(tool_name)
        if not executor:
            log.warning("[%s] 工具 '%s' 未找到 — 无对应执行器", session_id[:8], tool_name)
            return json.dumps({"error": f"Tool '{tool_name}' not found"}, ensure_ascii=False)

        if tool_name == "spawn_subagent":
            from app.agent.tools.spawn_subagent import execute_with_session
            return await execute_with_session(args_str, self._employee_id, session_id)

        if tool_name == "TodoWrite":
            from app.agent.tools.todo_write import execute_with_session as todo_execute
            return await todo_execute(args_str, self._employee_id, session_id)

        if tool_name == "create_artifact":
            from app.agent.tools.create_artifact import execute_with_session as ca_execute
            return await ca_execute(args_str, self._employee_id, session_id)

        if tool_name == "skill_asset_pull":
            from app.agent.tools.skill_asset_pull import execute_with_session
            return await execute_with_session(args_str, self._employee_id, session_id)

        result = await executor(args_str, self._employee_id)

        return result
