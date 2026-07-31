"""Memory distiller — three-layer distillation for SaaS stateful memory.

Layer 1: Per-turn distillation → short_term memory (from conversation extraction)
Layer 2: Pre-compress distillation → short_term memory (flush before compression)
Layer 3: Daily LLM consolidation → review, merge, re-score, promote to long_term

Triggers:
- Per-turn (fire-and-forget): after each assistant response, extract key facts → short_term
  (incremental — only new messages since last checkpoint; ensures short sessions don't lose memories)
- Pre-compress: when context is about to be compressed, distill remaining un-distilled messages
  → short_term before the original messages are summarised and their content is lost.
- Daily cron (3 AM): LLM reviews all short_term memories per user, merges duplicates,
  re-scores importance, promotes valuable ones → long_term, discards noise.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Protocol

from app.dao.memory_dao import MemoryDAO
from app.dao.message_dao import MessageDAO
from app.agent.llm_router import LLMRouter
from app.agent.context_loader import ContextLoader
from app.config import settings

log = logging.getLogger(__name__)

# ── Shared state for distillation coordination ───────────────────────────────
# Per-session lock prevents per-turn fire-and-forget and pre-compress distillation
# from running concurrently on the same session.
_distillation_locks: dict[str, asyncio.Lock] = {}

# Track last distilled message ID per session for incremental distillation.
_last_distilled_message_id: dict[str, str] = {}


def _get_lock(session_id: str) -> asyncio.Lock:
    if session_id not in _distillation_locks:
        _distillation_locks[session_id] = asyncio.Lock()
    return _distillation_locks[session_id]


async def wait_for_distillation(session_id: str) -> None:
    """Wait for any in-flight per-turn distillation to complete.

    Used by pre-compress hook to ensure all memories are extracted before
    context is compressed and old messages are summarised.
    """
    lock = _distillation_locks.get(session_id)
    if lock and lock.locked():
        log.debug("Waiting for in-flight distillation on session %s", session_id[:8])
        async with lock:
            pass


def get_last_distilled_message_id(session_id: str) -> str | None:
    return _last_distilled_message_id.get(session_id)


def set_last_distilled_message_id(session_id: str, message_id: str) -> None:
    _last_distilled_message_id[session_id] = message_id


async def run_distillation_task(
    employee_id: int,
    session_id: str,
    messages: list[dict],
    session_factory,
    last_msg_id: str,
) -> None:
    """Background task: distill new messages → short_term memory.

    Acquires the per-session lock to prevent overlapping with pre-compress distillation.
    Runs fire-and-forget after each turn so short sessions that never trigger
    compression still get their memories extracted.
    """
    lock = _get_lock(session_id)
    async with lock:
        try:
            distiller = MemoryDistiller(employee_id, session_factory)
            result = await distiller.distill(
                employee_id, session_id, messages, memory_type="short_term",
            )
            if result.distilled_count > 0:
                log.info(
                    "Per-turn distillation: %d facts for session %s",
                    result.distilled_count, session_id[:8],
                )
            set_last_distilled_message_id(session_id, last_msg_id)
        except Exception as e:
            log.warning(
                "Per-turn distillation failed for session %s: %s",
                session_id[:8], e,
            )

DISTILL_PROMPT = """你是一个记忆蒸馏器。从以下对话片段中提取需要长期记住的关键信息。

提取规则：
1. 只提取有长期价值的信息，忽略临时闲聊和中间步骤
2. 每条事实归类为：preference（偏好）、decision（决策）、fact（事实）、constraint（约束）、goal（目标）
3. 为每条事实打分 importance：0.0-1.0，越高越重要
4. key 使用英文 snake_case 唯一标识，如 "preferred_programming_language"
5. value 用中文简洁描述事实内容

=== 对话片段开始 ===
{messages_text}
=== 对话片段结束 ===

请输出 JSON 数组，格式如下：
[
  {{"category": "preference", "key": "xxx", "value": "xxx", "importance": 0.9}},
  {{"category": "fact", "key": "xxx", "value": "xxx", "importance": 0.7}}
]

如果没有值得长期记住的信息，输出空数组 []。"""

CONSOLIDATE_PROMPT = """你是一个记忆整合器。审查以下短期记忆，做出整合决策。

规则：
1. **合并重复**：识别高度相似或重复的记忆，合并为一条更完整的版本
2. **重新评分**：在全局视角下重新评估每条记忆的重要性（0.0-1.0）
3. **决策动作**：
   - "promote"：晋升为长期记忆（高价值、跨会话有用）
   - "keep"：保留为短期记忆（中等价值，需要更多证据）
   - "discard"：丢弃（临时信息、噪音、已过时）
   - "merge"：合并多条为一条新记忆，新记忆自动晋升为长期记忆

=== 短期记忆列表 ===
{memories_text}
=== 结束 ===

请输出 JSON 数组，格式如下：
[
  {{"action": "promote", "key": "existing_key", "importance": 0.9}},
  {{"action": "keep", "key": "existing_key"}},
  {{"action": "discard", "key": "existing_key"}},
  {{"action": "merge", "keys": ["key_a", "key_b"], "new_key": "merged_key", "new_value": "合并后的完整内容", "category": "fact", "importance": 0.85}}
]

注意：
- 每个现有记忆的 key 必须出现在输出中（promote/keep/discard 之一）
- merge 的 keys 中的原有记忆会被软删除，新记忆自动设为 long_term
- 如果没有短期记忆，输出空数组 []"""


@dataclass
class DistillationResult:
    session_id: str
    facts: list[dict]
    total_messages_processed: int
    distilled_count: int
    skipped_count: int


class MemoryDistillerProtocol(Protocol):
    async def distill(self, employee_id: int, session_id: str,
                      messages: list[dict]) -> DistillationResult: ...
    async def pre_compress_distill(self, employee_id: int,
                                   session_id: str) -> DistillationResult: ...


class MemoryDistiller:
    def __init__(self, employee_id: int, session_factory):
        self._employee_id = employee_id
        self._session_factory = session_factory
        self._llm_router = LLMRouter()
        self._context_loader = ContextLoader(employee_id, session_factory)

    async def distill(
        self,
        employee_id: int,
        session_id: str,
        messages: list[dict],
        memory_type: str = "short_term",
    ) -> DistillationResult:
        """Distill key facts from conversation messages into memory.
        memory_type: "short_term" for per-turn extraction, "long_term" for session-end consolidation."""
        if not settings.memory_distill_enabled:
            return DistillationResult(session_id=session_id, facts=[], total_messages_processed=0,
                                      distilled_count=0, skipped_count=0)

        if len(messages) < settings.memory_distill_min_messages:
            log.debug(f"跳过蒸馏：仅有 {len(messages)} 条消息（最少需要 {settings.memory_distill_min_messages} 条）")
            return DistillationResult(session_id=session_id, facts=[], total_messages_processed=len(messages),
                                      distilled_count=0, skipped_count=0)

        # build distillation input
        messages_text = self._format_messages(messages)
        if len(messages_text) > settings.memory_distill_max_input_chars:
            messages_text = messages_text[:settings.memory_distill_max_input_chars]

        prompt = DISTILL_PROMPT.format(messages_text=messages_text)

        # call LLM
        try:
            response = await self._llm_router.chat(
                model=settings.compress_model,
                messages=[{"role": "user", "content": prompt}],
                stream=False,
            )
            raw = response.choices[0].message.content.strip()
        except Exception as e:
            log.warning(f"记忆蒸馏LLM调用失败: {e}")
            return DistillationResult(session_id=session_id, facts=[], total_messages_processed=len(messages),
                                      distilled_count=0, skipped_count=0)

        # parse response
        facts = self._parse_facts(raw)

        # filter low importance
        filtered = [f for f in facts if f.get("importance", 0) >= 0.5]
        skipped = len(facts) - len(filtered)

        if not filtered:
            return DistillationResult(session_id=session_id, facts=filtered,
                                      total_messages_processed=len(messages),
                                      distilled_count=0, skipped_count=skipped)

        # upsert into memory with specified type
        dao = MemoryDAO(self._session_factory, self._employee_id)
        inserted, updated = await dao.upsert_from_distillation(filtered, session_id, memory_type=memory_type)

        # clear memory cache so next session sees updated facts
        await self._context_loader.clear_memory_cache()

        log.info(f"Session {session_id[:8]} 蒸馏完成: 新增 {inserted} 条，更新 {updated} 条，跳过 {skipped} 条")

        return DistillationResult(
            session_id=session_id,
            facts=filtered,
            total_messages_processed=len(messages),
            distilled_count=inserted + updated,
            skipped_count=skipped,
        )

    async def pre_compress_distill(
        self,
        employee_id: int,
        session_id: str,
    ) -> DistillationResult:
        """Distill only un-distilled messages before context compression."""
        msg_dao = MessageDAO(self._session_factory, self._employee_id)
        history, _ = await msg_dao.get_history(session_id, limit=10000)

        # filter to only un-distilled user/assistant messages
        un_distilled = [
            {"role": m.role, "content": m.content or ""}
            for m in history
            if m.role in ("user", "assistant") and m.is_distilled == 0 and m.is_compressed == 0
        ]

        if not un_distilled:
            return DistillationResult(session_id=session_id, facts=[], total_messages_processed=0,
                                      distilled_count=0, skipped_count=0)

        result = await self.distill(employee_id, session_id, un_distilled)

        # mark messages as distilled
        distilled_ids = [m.id for m in history
                         if m.role in ("user", "assistant") and m.is_distilled == 0 and m.is_compressed == 0]
        for mid in distilled_ids:
            await msg_dao.update(mid, is_distilled=1)

        return result

    def _format_messages(self, messages: list[dict]) -> str:
        lines = []
        for msg in messages:
            role = msg.get("role", "?")
            content = msg.get("content", "")
            if content:
                lines.append(f"[{role}]: {content[:300]}")
        return "\n".join(lines)

    def _parse_facts(self, raw: str) -> list[dict]:
        """Parse LLM response into fact dicts."""
        import re as _re
        raw = raw.strip()
        # strip <think>...</think> blocks (chain-of-thought from reasoning models)
        raw = _re.sub(r'<think(?:ing)?>.*?</think(?:ing)?>', '', raw, flags=_re.DOTALL | _re.IGNORECASE).strip()
        # strip markdown code blocks if present
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
            if raw.endswith("```"):
                raw = raw[:-3]
            raw = raw.strip()

        try:
            facts = json.loads(raw)
            if not isinstance(facts, list):
                return []
            valid = []
            for f in facts:
                if isinstance(f, dict) and "key" in f and "value" in f:
                    f.setdefault("category", "fact")
                    f.setdefault("importance", 0.5)
                    f["importance"] = max(0.0, min(1.0, float(f.get("importance", 0.5))))
                    valid.append(f)
            return valid
        except json.JSONDecodeError:
            log.warning(f"蒸馏响应解析失败: {raw[:200]}")
            return []

    async def consolidate(self, employee_id: int) -> tuple[int, int]:
        """Consolidate short_term memories into long_term.
        Promotes importance >= 0.7 to long_term, soft-deletes importance < 0.5."""
        dao = MemoryDAO(self._session_factory, self._employee_id)
        promoted, discarded = await dao.consolidate_to_long_term()

        # clear memory cache so next session sees updated facts
        await self._context_loader.clear_memory_cache()

        log.info(f"记忆整合: {promoted} 条晋升为长期记忆，{discarded} 条已丢弃")
        return promoted, discarded

    async def consolidate_with_llm(self, employee_id: int) -> dict:
        """LLM-driven consolidation: review all short_term memories, merge duplicates,
        re-score importance, and decide promote/keep/discard per memory.

        Returns {"promoted": N, "discarded": N, "merged": N, "kept": N}.
        """
        dao = MemoryDAO(self._session_factory, self._employee_id)
        memories = await dao.list_memories(memory_type="short_term")
        if not memories:
            return {"promoted": 0, "discarded": 0, "merged": 0, "kept": 0}

        # Format memories for the LLM
        memory_lines = []
        for mem in memories:
            memory_lines.append(
                f'  {{"key": "{mem.key}", "value": "{mem.value}", '
                f'"category": "{mem.category}", "importance": {mem.importance}}}'
            )
        memories_text = "\n".join(memory_lines)

        prompt = CONSOLIDATE_PROMPT.format(memories_text=memories_text)

        # Call LLM
        try:
            response = await self._llm_router.chat(
                model=settings.compress_model,
                messages=[{"role": "user", "content": prompt}],
                stream=False,
            )
            raw = response.choices[0].message.content.strip()
        except Exception as e:
            log.warning("LLM consolidation call failed: %s — falling back to rule-based", e)
            return await self._fallback_consolidate(dao)

        # Parse response
        decisions = self._parse_consolidation(raw)
        if not decisions:
            log.warning("LLM consolidation returned no valid decisions — falling back to rule-based")
            return await self._fallback_consolidate(dao)

        # Apply decisions
        result = await self._apply_consolidation(dao, decisions)
        await self._context_loader.clear_memory_cache()
        log.info(
            "LLM consolidation: %d promoted, %d discarded, %d merged, %d kept",
            result["promoted"], result["discarded"], result["merged"], result["kept"],
        )
        return result

    async def _fallback_consolidate(self, dao: MemoryDAO) -> dict:
        """Fallback to rule-based consolidation when LLM fails."""
        promoted, discarded = await dao.consolidate_to_long_term()
        await self._context_loader.clear_memory_cache()
        return {"promoted": promoted, "discarded": discarded, "merged": 0, "kept": 0}

    def _parse_consolidation(self, raw: str) -> list[dict]:
        """Parse LLM consolidation response."""
        import re as _re
        raw = raw.strip()
        # strip thinking blocks
        raw = _re.sub(r'<think(?:ing)?>.*?</think(?:ing)?>', '', raw, flags=_re.DOTALL | _re.IGNORECASE).strip()
        # strip markdown code blocks
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
            if raw.endswith("```"):
                raw = raw[:-3]
            raw = raw.strip()

        try:
            decisions = json.loads(raw)
            if not isinstance(decisions, list):
                return []
            valid = []
            for d in decisions:
                if not isinstance(d, dict) or "action" not in d:
                    continue
                if d["action"] in ("promote", "keep", "discard") and "key" in d:
                    valid.append(d)
                elif d["action"] == "merge" and "keys" in d and "new_key" in d and "new_value" in d:
                    valid.append(d)
            return valid
        except json.JSONDecodeError:
            log.warning("Consolidation response parse failed: %s", raw[:200])
            return []

    async def _apply_consolidation(self, dao: MemoryDAO, decisions: list[dict]) -> dict:
        """Apply LLM consolidation decisions to the database."""
        promoted = 0
        discarded = 0
        merged = 0
        kept = 0

        for d in decisions:
            action = d["action"]
            if action == "promote":
                await dao.update(
                    key=d["key"],
                    value="",  # keep existing value
                    importance=d.get("importance"),
                )
                # Actually promote: set memory_type to long_term
                await dao.set_memory_type(d["key"], "long_term")
                promoted += 1
            elif action == "keep":
                kept += 1
            elif action == "discard":
                await dao.soft_delete(d["key"])
                discarded += 1
            elif action == "merge":
                # Soft-delete source memories
                for key in d["keys"]:
                    await dao.soft_delete(key)
                # Create new merged memory as long_term
                await dao.create(
                    key=d["new_key"],
                    value=d["new_value"],
                    category=d.get("category", "fact"),
                    importance=d.get("importance", 0.7),
                    memory_type="long_term",
                    source="consolidation",
                )
                merged += 1

        return {"promoted": promoted, "discarded": discarded, "merged": merged, "kept": kept}