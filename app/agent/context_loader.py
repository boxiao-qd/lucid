"""Context loader -- assemble system prompt with memory + skills at session startup."""

from __future__ import annotations

import asyncio
import logging

from app.dao.memory_dao import MemoryDAO
from app.dao.skill_dao import SkillDAO
from app.dao.subagent_dao import SubagentDAO
from app.cache.cache_provider import CacheProvider, create_cache_provider
from app.config import settings
from app.storage.sys_infra import list_system_skills, list_system_subagents

log = logging.getLogger(__name__)

_CATEGORY_LABELS = {
    "preference": "偏好",
    "decision": "决策",
    "fact": "事实",
    "constraint": "约束",
    "goal": "目标",
}

_QUERY_REWRITE_PROMPT = """\
你是一个记忆检索助手。根据以下对话上下文，生成一个用于语义搜索的精炼查询词，\
用于从用户长期记忆库中检索最相关的信息。

对话上下文：
{context}

请输出一个简洁的检索查询（不超过100字），只输出查询文本，不要任何解释。"""


class ContextLoader:
    """Loads long-term memory summary + skill/subagent compact index for system prompt assembly."""

    def __init__(self, employee_id: int, session_factory):
        self._employee_id = employee_id
        self._session_factory = session_factory
        self._cache = create_cache_provider(session_factory, employee_id)

    async def load_memory_summary(self, history=None) -> str:
        """Load LTM + STM combined summary for system prompt injection.

        - Query is rewritten ONCE from conversation context, then reused for both LTM and STM.
        - LTM (long_term): dual-track (ES hybrid + high-importance SQL)
        - STM (short_term): cross-session, recent 3 days, ES hybrid with date_from filter
        Each half gets up to max_chars/2 budget; combined total ≤ max_chars.
        """
        # Build search query from recent context — no extra LLM call needed.
        search_query: str | None = None
        if history and settings.embedding_model:
            recent = _extract_recent_context(history)
            if recent:
                search_query = " ".join(
                    m["content"][:200] for m in recent if m.get("content")
                )[:400]

        ltm, stm = await asyncio.gather(
            self._load_ltm_summary(history, search_query),
            self._load_stm_summary(history, search_query),
            return_exceptions=True,
        )
        if isinstance(ltm, Exception):
            log.warning("LTM summary failed: %s", ltm)
            ltm = ""
        if isinstance(stm, Exception):
            log.warning("STM summary failed: %s", stm)
            stm = ""

        parts = [p for p in [ltm, stm] if p]
        return "\n\n".join(parts)

    async def _load_ltm_summary(self, history=None, search_query: str | None = None) -> str:
        """Dual-track LTM injection.

        Track A: ES hybrid search (query-rewrite based, relevance-driven).
        Track B: SQL query for importance >= 0.8 (always injected, ES-independent).
        Merged by key (A wins), sorted by importance*0.4 + relevance*0.6.
        """
        max_chars = settings.memory_injection_max_chars // 2

        # Track A: ES hybrid (uses pre-computed search_query)
        a_hits: list[dict] = []
        if search_query and settings.embedding_model:
            try:
                a_hits = await self._es_hybrid_hits(search_query, memory_type="long_term")
            except Exception as e:
                log.warning("LTM Track A ES failed: %s", e)

        # Track B: high-importance SQL (always runs, independent of ES)
        b_mems: list = []
        try:
            dao = MemoryDAO(self._session_factory, self._employee_id)
            b_mems = await dao.get_high_importance(min_importance=0.8, memory_type="long_term", limit=50)
        except Exception as e:
            log.warning("LTM Track B SQL failed: %s", e)

        # If both tracks empty, fall back to cached SQL summary
        if not a_hits and not b_mems:
            cached = await self._cache.get(f"memory_summary:{self._employee_id}")
            if cached:
                return cached
            dao = MemoryDAO(self._session_factory, self._employee_id)
            summary = await dao.get_top_summary(max_chars=max_chars)
            if summary:
                await self._cache.set(f"memory_summary:{self._employee_id}", summary, ttl=300)
            return summary or ""

        # Merge: B first (lower priority), then A overrides on same key
        merged: dict[str, dict] = {}
        for mem in b_mems:
            merged[mem.key] = {
                "value": mem.value,
                "category": mem.category or "fact",
                "importance": mem.importance or 0.5,
                "relevance": 0.5,
            }
        for hit in a_hits:
            key = hit.get("key") or hit.get("value", "")[:50]
            merged[key] = {
                "value": hit.get("value", ""),
                "category": hit.get("category", "fact"),
                "importance": hit.get("importance", 0.5),
                "relevance": hit.get("_score", 0.0),
            }

        sorted_items = sorted(
            merged.values(),
            key=lambda x: x["importance"] * 0.4 + x["relevance"] * 0.6,
            reverse=True,
        )

        lines = []
        total_chars = 0
        for item in sorted_items:
            label = _CATEGORY_LABELS.get(item["category"], item["category"])
            line = f"- {label}: {item['value']}"
            if total_chars + len(line) > max_chars:
                break
            lines.append(line)
            total_chars += len(line)

        return ("[用户长期记忆]\n" + "\n".join(lines)) if lines else ""

    async def _load_stm_summary(self, history=None, search_query: str | None = None) -> str:
        """Load short-term memory (cross-session, recent 3 days) via ES hybrid search.

        STM is indexed by employee_id (not session_id). The date_from filter limits
        retrieval to recent N days, making it effectively cross-session recent context.
        Falls back to SQL top-K on ES/embedding failure.
        """
        from datetime import datetime, timedelta, timezone
        max_chars = settings.memory_injection_max_chars // 2
        date_from = (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%d")

        if search_query and settings.embedding_model:
            try:
                return await self._es_hybrid_summary(
                    search_query, max_chars,
                    memory_type="short_term",
                    date_from=date_from,
                )
            except Exception as e:
                log.warning("STM ES hybrid failed, falling back to SQL: %s", e)

        # SQL fallback: recent STM by importance
        dao = MemoryDAO(self._session_factory, self._employee_id)
        memories = await dao.rank_and_query(top_k=5, memory_type="short_term")
        if not memories:
            return ""

        lines = []
        total_chars = 0
        for mem in memories:
            label = _CATEGORY_LABELS.get(mem.category, mem.category)
            line = f"- {label}: {mem.value}"
            if total_chars + len(line) > max_chars:
                break
            lines.append(line)
            total_chars += len(line)

        return ("[近期记忆]\n" + "\n".join(lines)) if lines else ""

    async def _es_hybrid_hits(
        self,
        search_query: str,
        memory_type: str = "long_term",
        date_from: str | None = None,
    ) -> list[dict]:
        """Return raw ES hybrid search hits (list of dicts with key/value/category/importance/_score)."""
        from app.storage.embedding import get_embedding
        embedding = await get_embedding(search_query)
        if not embedding:
            return []

        from app.db.elasticsearch import hybrid_search_memories
        hits = await hybrid_search_memories(
            employee_id=self._employee_id,
            query_embedding=embedding,
            query_text=search_query,
            top_k=settings.memory_injection_top_k,
            memory_type=memory_type,
            date_from=date_from,
        )
        return hits or []

    async def _es_hybrid_summary(
        self,
        search_query: str,
        max_chars: int,
        memory_type: str = "long_term",
        date_from: str | None = None,
    ) -> str:
        """Embed query, run ES RRF hybrid search, format as compact summary."""
        hits = await self._es_hybrid_hits(search_query, memory_type=memory_type, date_from=date_from)
        if not hits:
            return ""

        header = "[近期记忆]" if memory_type == "short_term" else "[用户长期记忆]"
        lines = []
        total_chars = 0
        for hit in hits:
            label = _CATEGORY_LABELS.get(hit.get("category", "fact"), hit.get("category", "fact"))
            line = f"- {label}: {hit.get('value', '')}"
            if total_chars + len(line) > max_chars:
                break
            lines.append(line)
            total_chars += len(line)

        return (header + "\n" + "\n".join(lines)) if lines else ""

    async def _rewrite_search_query(self, recent_context: list[dict]) -> str:
        """Use LLM to rewrite recent conversation context into a single semantic search query."""
        from app.agent.llm_router import LLMRouter
        context_text = "\n".join(
            f"[{m['role']}]: {m['content'][:300]}" for m in recent_context
        )
        prompt = _QUERY_REWRITE_PROMPT.format(context=context_text)
        try:
            router = LLMRouter()
            response = await router.chat(
                model=settings.compress_model,
                messages=[{"role": "user", "content": prompt}],
                stream=False,
                use_compress=True,
            )
            query = response.choices[0].message.content.strip()
            return query[:200] or context_text[:200]
        except Exception as e:
            log.warning("Query rewriting failed: %s — using raw context", e)
            return context_text[:200]

    async def load_user_profile(self) -> str:
        """Load display_name + profile_data preferences from UserProfile.
        Cached at TTL=300s — profile rarely changes.
        """
        cache_key = f"user_profile:{self._employee_id}"
        cached = await self._cache.get(cache_key)
        if cached:
            return cached
        try:
            from app.dao.profile_dao import ProfileDAO
            dao = ProfileDAO(self._session_factory, self._employee_id)
            profile = await dao.get_settings()
            if not profile:
                return ""

            parts = []
            if profile.display_name:
                parts.append(f"姓名：{profile.display_name}")
            if profile.profile_data:
                import json
                try:
                    prefs = json.loads(profile.profile_data)
                    if isinstance(prefs, dict) and prefs:
                        pref_lines = [f"{k}: {v}" for k, v in list(prefs.items())[:10]]
                        parts.append("偏好：" + "、".join(pref_lines))
                except Exception:
                    if profile.profile_data.strip():
                        parts.append(f"偏好：{profile.profile_data[:200]}")

            result = ("[用户信息]\n" + "\n".join(parts)) if parts else ""
            await self._cache.set(cache_key, result, ttl=300)
            return result
        except Exception as e:
            log.warning("load_user_profile failed: %s", e)
            return ""

    async def load_todo_cron_summary(self) -> str:
        """Load pending todos and active cron jobs for system prompt injection.
        Cached at TTL=60s — operational data that changes occasionally.
        """
        cache_key = f"todo_cron:{self._employee_id}"
        cached = await self._cache.get(cache_key)
        if cached:
            return cached

        from app.dao.todo_dao import TodoDAO
        from app.dao.cron_dao import CronDAO

        todos, crons = await asyncio.gather(
            TodoDAO(self._session_factory, self._employee_id).get_pending(limit=5),
            CronDAO(self._session_factory, self._employee_id).get_active(limit=5),
            return_exceptions=True,
        )

        parts = []
        if isinstance(todos, list) and todos:
            lines = [f"  - [{t.status}] {t.title}" for t in todos]
            parts.append("[当前待办]\n" + "\n".join(lines))
        if isinstance(crons, list) and crons:
            lines = [
                f"  - {c.name or '未命名'}（{c.cron_expr}）: {(c.prompt or '')[:60]}"
                for c in crons
            ]
            parts.append("[已有定时任务]\n" + "\n".join(lines))

        result = "\n\n".join(parts)
        await self._cache.set(cache_key, result, ttl=60)
        return result

    async def load_skills_index(self) -> str:
        """Load compact skills/subagents index (L1) for system prompt.

        System skills/subagents come from sys-infra filesystem (baked into image).
        User custom skills/subagents come from DB (employee_id-specific entries).
        Cached at TTL=300s.
        """
        cached = await self._cache.get(f"skills_index:{self._employee_id}")
        if cached:
            return cached

        # System skills/subagents from container filesystem
        sys_skills = list_system_skills()
        sys_subagents = list_system_subagents()
        sys_skill_names = {s["name"] for s in sys_skills}
        sys_subagent_names = {sa["name"] for sa in sys_subagents}

        # User custom skills/subagents from DB (exclude any name already in sys-infra)
        skill_dao = SkillDAO(self._session_factory, self._employee_id)
        subagent_dao = SubagentDAO(self._session_factory, self._employee_id)
        db_skills = await skill_dao.get_index()
        db_subagents = await subagent_dao.get_index()

        user_skills = [s for s in db_skills if s["name"] not in sys_skill_names]
        user_subagents = [sa for sa in db_subagents if sa["name"] not in sys_subagent_names]

        # Tag source so the agent can distinguish skill origin
        for s in sys_skills:
            s["_source"] = "sys_infra"
        for s in user_skills:
            s["_source"] = "user"

        all_skills = sys_skills + user_skills
        all_subagents = sys_subagents + user_subagents

        lines = []
        if all_skills:
            lines.append("[可用技能]")
            for s in all_skills:
                source = s.get("_source", "sys_infra")
                is_global = s.get("is_global", False)
                label = "系统" if source == "sys_infra" else ("全局" if is_global else "个人")
                lines.append(f"  - {s['name']}（{label}）: {s['description']}")

        if all_subagents:
            lines.append("[可用子代理]")
            for sa in all_subagents:
                lines.append(f"  - {sa['name']}: {sa['description']}")

        index_text = "\n".join(lines)
        if index_text:
            await self._cache.set(f"skills_index:{self._employee_id}", index_text, ttl=300)

        return index_text

    async def clear_memory_cache(self) -> None:
        """Clear memory summary cache after distillation writes new facts."""
        await self._cache.delete(f"memory_summary:{self._employee_id}")


def _extract_recent_context(history) -> list[dict]:
    """Extract last 2 user messages + last 1 assistant message from history."""
    user_msgs = [
        {"role": m.role, "content": m.content or ""}
        for m in history
        if m.role == "user" and m.content
    ]
    asst_msgs = [
        {"role": m.role, "content": m.content or ""}
        for m in history
        if m.role == "assistant" and m.content
    ]
    recent = user_msgs[-2:]
    if asst_msgs:
        recent.append(asst_msgs[-1])
    return recent
