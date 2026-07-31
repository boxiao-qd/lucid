import asyncio
import uuid
import logging
from sqlalchemy import select, or_
from app.dao.base import BaseDAO
from app.models.models import Memory as MemoryModel
from datetime import datetime

log = logging.getLogger(__name__)


class MemoryDAO(BaseDAO):
    async def list_memories(self, memory_type: str | None = None) -> list[MemoryModel]:
        session = self._session()
        stmt = select(MemoryModel).where(
            self._filter_by_user(MemoryModel), MemoryModel.is_deleted == 0
        )
        if memory_type:
            stmt = stmt.where(MemoryModel.memory_type == memory_type)
        result = await session.scalars(stmt)
        items = result.all()
        await session.close()
        return items

    async def get_by_key(self, key: str, memory_type: str | None = None) -> MemoryModel | None:
        session = self._session()
        stmt = select(MemoryModel).where(
            self._filter_by_user(MemoryModel),
            MemoryModel.is_deleted == 0,
            MemoryModel.key == key,
        )
        if memory_type:
            stmt = stmt.where(MemoryModel.memory_type == memory_type)
        result = await session.scalars(stmt)
        item = result.first()
        await session.close()
        return item

    async def create(self, key: str, value: str, source: str = "agent", session_id: str | None = None,
                     category: str = "fact", importance: float = 0.5,
                     memory_type: str = "long_term") -> MemoryModel:
        session = self._session()
        obj = MemoryModel(
            id=str(uuid.uuid4()),
            employee_id=self._employee_id,
            session_id=session_id,
            memory_type=memory_type,
            category=category,
            key=key,
            value=value,
            importance=importance,
            source=source,
        )
        session.add(obj)
        await session.commit()
        await session.refresh(obj)
        await session.close()
        return obj

    async def update(self, key: str, value: str, source: str = "agent",
                     importance: float | None = None) -> MemoryModel | None:
        session = self._session()
        result = await session.scalars(
            select(MemoryModel).where(
                self._filter_by_user(MemoryModel),
                MemoryModel.is_deleted == 0,
                MemoryModel.key == key,
            )
        )
        item = result.first()
        if item:
            item.value = value
            item.source = source
            if importance is not None:
                item.importance = importance
            await session.commit()
            await session.refresh(item)
        await session.close()
        return item

    async def set_memory_type(self, key: str, memory_type: str) -> bool:
        """Change the memory_type of a memory entry (e.g. short_term → long_term)."""
        session = self._session()
        result = await session.scalars(
            select(MemoryModel).where(
                self._filter_by_user(MemoryModel),
                MemoryModel.is_deleted == 0,
                MemoryModel.key == key,
            )
        )
        item = result.first()
        if item:
            item.memory_type = memory_type
            await session.commit()
        await session.close()
        return item is not None

    async def soft_delete(self, key: str) -> bool:
        session = self._session()
        result = await session.scalars(
            select(MemoryModel).where(
                self._filter_by_user(MemoryModel),
                MemoryModel.is_deleted == 0,
                MemoryModel.key == key,
            )
        )
        item = result.first()
        if item:
            item.is_deleted = 1
            await session.commit()
        await session.close()
        return item is not None

    async def rank_and_query(
        self,
        top_k: int = 10,
        keywords: list[str] | None = None,
        category_filter: list[str] | None = None,
        memory_type: str | None = None,
    ) -> list[MemoryModel]:
        """Three-tier ranking: importance DESC → last_accessed_at DESC → keyword ILIKE."""
        session = self._session()
        stmt = select(MemoryModel).where(
            self._filter_by_user(MemoryModel),
            MemoryModel.is_deleted == 0,
        )
        if memory_type:
            stmt = stmt.where(MemoryModel.memory_type == memory_type)
        if category_filter:
            stmt = stmt.where(MemoryModel.category.in_(category_filter))
        if keywords:
            keyword_clauses = []
            for kw in keywords:
                keyword_clauses.append(or_(
                    MemoryModel.key.ilike(f"%{kw}%"),
                    MemoryModel.value.ilike(f"%{kw}%"),
                ))
            stmt = stmt.where(or_(*keyword_clauses))
        stmt = stmt.order_by(MemoryModel.importance.desc(), MemoryModel.last_accessed_at.desc())
        stmt = stmt.limit(top_k)
        result = await session.scalars(stmt)
        items = result.all()
        await session.close()
        return items

    async def get_top_summary(
        self,
        max_chars: int = 500,
        keywords: list[str] | None = None,
    ) -> str:
        """Assemble user long-term memory summary ≤ max_chars for system prompt injection.
        Only uses long_term memories (not short_term)."""
        memories = await self.rank_and_query(top_k=15, keywords=keywords, memory_type="long_term")
        if not memories:
            return ""

        category_labels = {
            "preference": "偏好",
            "decision": "决策",
            "fact": "事实",
            "constraint": "约束",
            "goal": "目标",
        }

        lines = []
        total_chars = 0
        for mem in memories:
            label = category_labels.get(mem.category, mem.category)
            line = f"- {label}: {mem.value}"
            if total_chars + len(line) > max_chars:
                break
            lines.append(line)
            total_chars += len(line)

        # mark accessed
        accessed_ids = [m.id for m in memories[:len(lines)]]
        await self.mark_accessed(accessed_ids)

        header = "[用户长期记忆]"
        return header + "\n" + "\n".join(lines)

    async def upsert_from_distillation(
        self,
        facts: list[dict],
        session_id: str,
        memory_type: str = "short_term",
    ) -> tuple[int, int]:
        """Batch upsert distillation results with memory_type.
        Per-turn distillation → short_term; periodic consolidation → long_term."""
        session = self._session()
        inserted = 0
        updated = 0

        for fact in facts:
            key = fact["key"]
            result = await session.scalars(
                select(MemoryModel).where(
                    self._filter_by_user(MemoryModel),
                    MemoryModel.is_deleted == 0,
                    MemoryModel.key == key,
                )
            )
            existing = result.first()
            if existing:
                if fact["importance"] >= existing.importance:
                    existing.value = fact["value"]
                    existing.importance = fact["importance"]
                    existing.category = fact["category"]
                    existing.session_id = session_id
                    existing.source = "distillation"
                    existing.memory_type = memory_type
                    updated += 1
            else:
                obj = MemoryModel(
                    id=str(uuid.uuid4()),
                    employee_id=self._employee_id,
                    session_id=session_id,
                    memory_type=memory_type,
                    category=fact["category"],
                    key=key,
                    value=fact["value"],
                    importance=fact["importance"],
                    source="distillation",
                )
                session.add(obj)
                inserted += 1

        await session.commit()

        # Collect written items for ES sync (need to refresh to get final state)
        written_keys = [f["key"] for f in facts]
        es_items_result = await session.scalars(
            select(MemoryModel).where(
                self._filter_by_user(MemoryModel),
                MemoryModel.is_deleted == 0,
                MemoryModel.key.in_(written_keys),
            )
        )
        es_items = list(es_items_result.all())
        await session.close()

        self._fire_es_sync(es_items)
        return inserted, updated

    async def consolidate_to_long_term(self) -> tuple[int, int]:
        """Consolidate short_term memories into long_term.
        Promotes high-importance short_term items to long_term;
        soft-deletes low-importance short_term items."""
        session = self._session()
        short_terms = await session.scalars(
            select(MemoryModel).where(
                self._filter_by_user(MemoryModel),
                MemoryModel.is_deleted == 0,
                MemoryModel.memory_type == "short_term",
                MemoryModel.importance >= 0.7,
            )
        )
        promoted = 0
        for item in short_terms.all():
            item.memory_type = "long_term"
            item.source = "consolidation"
            promoted += 1

        # soft-delete low importance short_term
        low_importance = await session.scalars(
            select(MemoryModel).where(
                self._filter_by_user(MemoryModel),
                MemoryModel.is_deleted == 0,
                MemoryModel.memory_type == "short_term",
                MemoryModel.importance < 0.5,
            )
        )
        discarded = 0
        for item in low_importance.all():
            item.is_deleted = 1
            discarded += 1

        await session.commit()

        # Sync promoted items to ES (they now have memory_type=long_term)
        if promoted > 0:
            promoted_result = await session.scalars(
                select(MemoryModel).where(
                    self._filter_by_user(MemoryModel),
                    MemoryModel.is_deleted == 0,
                    MemoryModel.memory_type == "long_term",
                    MemoryModel.source == "consolidation",
                )
            )
            self._fire_es_sync(list(promoted_result.all()))

        await session.close()
        return promoted, discarded

    def _fire_es_sync(self, items: list[MemoryModel]) -> None:
        """Schedule ES sync as a background task; does not block or raise."""
        if not items:
            return
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._sync_items_to_es(items))
        except RuntimeError:
            pass  # no running loop — skip ES sync

    async def _sync_items_to_es(self, items: list[MemoryModel]) -> None:
        try:
            from app.db.elasticsearch import index_memory_doc
            from app.storage.embedding import get_embedding
            for item in items:
                embedding = await get_embedding(item.value)
                await index_memory_doc(
                    employee_id=self._employee_id,
                    doc_id=item.id,
                    key=item.key,
                    value=item.value,
                    category=item.category,
                    memory_type=item.memory_type,
                    importance=item.importance,
                    is_deleted=bool(item.is_deleted),
                    embedding=embedding,
                    created_at=item.created_at,
                )
        except Exception as e:
            log.warning("ES sync failed: %s", e)

    async def get_high_importance(
        self,
        min_importance: float = 0.8,
        memory_type: str = "long_term",
        limit: int = 50,
    ) -> list[MemoryModel]:
        """Return memories with importance >= min_importance, ordered by importance desc."""
        session = self._session()
        stmt = (
            select(MemoryModel)
            .where(
                self._filter_by_user(MemoryModel),
                MemoryModel.is_deleted == 0,
                MemoryModel.memory_type == memory_type,
                MemoryModel.importance >= min_importance,
            )
            .order_by(MemoryModel.importance.desc(), MemoryModel.updated_at.desc())
            .limit(limit)
        )
        result = await session.scalars(stmt)
        items = result.all()
        await session.close()
        return items

    async def mark_accessed(self, memory_ids: list[str]) -> None:
        """Mark memories as injected into system prompt, update access_count and last_accessed_at.
        Only marks memories belonging to the current user."""
        session = self._session()
        now = datetime.utcnow().isoformat()
        for mid in memory_ids:
            result = await session.scalars(
                select(MemoryModel).where(
                    self._filter_by_user(MemoryModel),
                    MemoryModel.id == mid,
                    MemoryModel.is_deleted == 0,
                )
            )
            item = result.first()
            if item:
                item.access_count += 1
                item.last_accessed_at = now
        await session.commit()
        await session.close()