"""Context compressor — summarizes middle messages when token count exceeds session limit.

Enhanced: uses absolute-token-offset thresholds (matching Claude Code & OpenClaw),
structured summary prompt with key sections, and circuit-breaker tracking.
"""

from app.dao.message_dao import MessageDAO
from app.dao.session_dao import SessionDAO
from app.db.database import get_session_factory
from app.agent.llm_router import LLMRouter
from app.agent.memory_distiller import MemoryDistiller
from app.config import settings
import asyncio
import logging

log = logging.getLogger(__name__)

# Circuit breaker: max consecutive compression failures before stopping retries
_MAX_CONSECUTIVE_FAILURES = 3
# Per-session failure tracking (in-process, not persisted)
_failure_counts: dict[str, int] = {}

# Structured summary prompt — extracts key sections for better post-compression context
_COMPRESS_SYSTEM_PROMPT = (
    "You are a context summarizer. Summarize the conversation segment below concisely. "
    "Your summary MUST include these sections:\n\n"
    "1. **Key Decisions & Facts**: What was decided, what facts were established.\n"
    "2. **Actions Taken**: What tools were called and what they returned (key results only).\n"
    "3. **Files & Code**: File paths read or modified, key code snippets.\n"
    "4. **Errors & Fixes**: Any errors encountered and how they were resolved.\n"
    "5. **Current Task**: What is the user currently working on, what is the next step.\n\n"
    "Keep the summary concise. Preserve exact file paths, command outputs, and error messages "
    "where relevant. Do NOT re-execute or continue any task — just summarize."
)


def _should_compress(session_token_count: int, session_max_tokens: int) -> bool:
    """Check if compression should trigger using absolute-offset threshold.

    Trigger when: token_count >= contextWindow - maxOutputTokens - buffer
    This matches Claude Code's approach and is more predictable than a percentage.
    """
    if session_max_tokens <= 0:
        return False
    effective_window = min(settings.context_window_tokens, session_max_tokens)
    threshold = effective_window - settings.max_output_tokens - settings.auto_compact_buffer_tokens
    if threshold <= 0:
        threshold = int(effective_window * 0.8)  # fallback to 80% if window is very small
    return session_token_count >= threshold


def _check_circuit_breaker(session_id: str) -> bool:
    """Return True if the circuit breaker is open (too many consecutive failures)."""
    return _failure_counts.get(session_id, 0) >= _MAX_CONSECUTIVE_FAILURES


def _record_compression_result(session_id: str, success: bool) -> None:
    """Update the circuit breaker state."""
    if success:
        _failure_counts.pop(session_id, None)
    else:
        _failure_counts[session_id] = _failure_counts.get(session_id, 0) + 1


async def compress_if_needed(employee_id: int, session_id: str, force: bool = False) -> bool:
    """Check if session token count exceeds limit, compress middle messages if so.

    When force=True, bypass the threshold check and compress unconditionally.
    Used by the pre-flight guard and reactive overflow recovery.

    Returns True if compression was performed successfully.
    """
    # Circuit breaker: don't keep retrying if compression keeps failing
    if not force and _check_circuit_breaker(session_id):
        log.debug("Circuit breaker open for %s, skipping compression", session_id[:8])
        return False

    session_dao = SessionDAO(get_session_factory(), employee_id)
    msg_dao = MessageDAO(get_session_factory(), employee_id)

    session = await session_dao.get_by_id(session_id)
    if not force:
        if not _should_compress(session.token_count, session.max_tokens):
            return False
    tokens_before = session.token_count

    # Pre-compress hook: wait for any in-flight per-turn distillation,
    # then distill remaining un-distilled messages before compression.
    if settings.memory_distill_enabled:
        try:
            from app.agent.memory_distiller import wait_for_distillation
            await wait_for_distillation(session_id)
        except Exception as e:
            log.warning("Pre-compress wait for distillation failed: %s", e)
        try:
            distiller = MemoryDistiller(employee_id, get_session_factory())
            result = await distiller.pre_compress_distill(employee_id, session_id)
            log.info("Pre-compress distillation: %d facts extracted", result.distilled_count)
        except Exception as e:
            log.warning("Pre-compress distillation failed: %s", e)

    # Load all messages for the session
    history, _ = await msg_dao.get_history(session_id, limit=10000)

    if len(history) < 5:
        _record_compression_result(session_id, False)
        return False

    # Keep first 2 and last 2 messages, compress the middle
    to_compress = history[2:-2]
    if not to_compress:
        _record_compression_result(session_id, False)
        return False

    # Build summary of middle messages (truncate each to 800 chars for richer context)
    middle_text = "\n".join(
        [f"[{m.role}]: {(m.content or '')[:800]}" for m in to_compress]
    )

    router = LLMRouter()
    try:
        response = await router.chat(
            model=settings.compress_model,
            messages=[
                {"role": "system", "content": _COMPRESS_SYSTEM_PROMPT},
                {"role": "user", "content": middle_text},
            ],
            stream=False,
        )
        summary = response.choices[0].message.content
    except Exception as exc:
        log.warning("Context compression failed: %s", exc)
        _record_compression_result(session_id, False)
        return False

    # Mark compressed messages as is_compressed=1 and zero their token count
    for msg in to_compress:
        await msg_dao.update(msg.id, token_count=0, is_compressed=1)

    # Insert compressed summary as a system message
    summary_tokens = len(summary) // 4
    await msg_dao.create(
        session_id=session_id,
        role="system",
        content=f"[Compressed context]:\n{summary}",
        token_count=summary_tokens,
    )

    # Calculate base kept_tokens before restoration adds more
    kept = [m for m in history if m not in to_compress]
    kept_tokens = sum(m.token_count or 0 for m in kept) + summary_tokens

    # ── Post-compression context restoration ──
    # Rebuild critical context from DB so the LLM doesn't lose awareness of
    # what it was doing. Extracts file paths / errors from compressed messages,
    # then reloads memory summary, todo/cron status, and skills index.
    import re as _re
    file_paths: set[str] = set()
    error_count = 0
    for msg in to_compress:
        content = msg.content or ""
        file_paths.update(_re.findall(r'/[^\s,;:\[\](){}"\']{2,}', content))
        file_paths.update(_re.findall(r'\b[\w.-]+(?:/[\w.-]+)+\.[a-zA-Z]{1,6}\b', content))
        if msg.role == "tool" and len(content) < 2000:
            lowered = content.lower()
            if any(kw in lowered for kw in ("error", "failed", "exception", "traceback", "denied")):
                error_count += 1

    # Load live context from DB in parallel
    from app.agent.context_loader import ContextLoader
    context_loader = ContextLoader(employee_id, get_session_factory())
    memory_summary, todo_cron, skills_index = await asyncio.gather(
        context_loader.load_memory_summary(),
        context_loader.load_todo_cron_summary(),
        context_loader.load_skills_index(),
        return_exceptions=True,
    )
    if isinstance(memory_summary, Exception):
        memory_summary = ""
    if isinstance(todo_cron, Exception):
        todo_cron = ""
    if isinstance(skills_index, Exception):
        skills_index = ""

    restore_parts: list[str] = []
    restore_parts.append(
        "以下内容在上下文压缩后重新加载，确保你掌握当前状态："
    )
    if memory_summary:
        restore_parts.append(memory_summary)
    if todo_cron:
        restore_parts.append(todo_cron)
    if skills_index:
        restore_parts.append(skills_index)
    if file_paths:
        sorted_paths = sorted(file_paths)[:15]
        restore_parts.append(f"[压缩前涉及的文件]\n{', '.join(sorted_paths)}")
    if error_count:
        restore_parts.append(f"[压缩前遇到的错误]\n共 {error_count} 条错误（详见上下文摘要）")

    restore_content = "\n\n".join(restore_parts)
    await msg_dao.create(
        session_id=session_id,
        role="system",
        content=restore_content,
        token_count=len(restore_content) // 4,
    )
    kept_tokens += len(restore_content) // 4

    # Reset session token_count to reflect only surviving messages
    await session_dao.set_token_count(session_id, kept_tokens)

    _record_compression_result(session_id, True)

    try:
        from app.api.v1.stream import push_event
        from app.sse.event_types import SSEEventType
        push_event(session_id, SSEEventType.context_compression, {
            "tokens_before": tokens_before,
            "tokens_after": kept_tokens,
            "compressed_count": len(to_compress),
            "summary_preview": summary[:100],
        })
    except Exception as e:
        log.warning("Failed to push context_compression SSE event: %s", e)

    return True


def reset_circuit_breaker(session_id: str) -> None:
    """Reset the circuit breaker for a session (e.g., on new conversation)."""
    _failure_counts.pop(session_id, None)