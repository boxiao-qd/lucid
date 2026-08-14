import uuid
from sqlalchemy import select, func, update, delete
from sqlalchemy.ext.asyncio import AsyncSession
from app.dao.base import BaseDAO
from app.db.database import get_session_factory
from app.models.models import Session as SessionModel
from app.middleware.error_handler import AppError


class SessionDAO(BaseDAO):
    async def create(self, title: str | None, model: str | None, system_prompt: str | None, parent_session_id: str | None = None) -> SessionModel:
        session = self._session()
        obj = SessionModel(
            id=str(uuid.uuid4()),
            employee_id=self._employee_id,
            title=title,
            model=model,
            system_prompt=system_prompt,
            parent_session_id=parent_session_id,
        )
        session.add(obj)
        await session.commit()
        await session.refresh(obj)
        await session.close()
        return obj

    async def list_sessions(self, page: int = 1, page_size: int = 20) -> tuple[list[SessionModel], int]:
        session = self._session()
        total = await session.scalar(
            select(func.count(SessionModel.id)).where(
                self._filter_by_user(SessionModel), SessionModel.is_deleted == 0
            )
        )
        result = await session.scalars(
            select(SessionModel)
            .where(self._filter_by_user(SessionModel), SessionModel.is_deleted == 0)
            .order_by(SessionModel.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        items = result.all()
        await session.close()
        return items, total

    async def get_by_id(self, session_id: str) -> SessionModel:
        session = self._session()
        obj = await session.scalar(
            select(SessionModel).where(
                SessionModel.id == session_id,
                self._filter_by_user(SessionModel),
                SessionModel.is_deleted == 0,
            )
        )
        await session.close()
        if not obj:
            raise AppError("BX_SESSION_2001", "Session not found", 404)
        return obj

    async def soft_delete(self, session_id: str) -> None:
        session = self._session()
        await session.execute(
            update(SessionModel)
            .where(SessionModel.id == session_id, self._filter_by_user(SessionModel))
            .values(is_deleted=1)
        )
        await session.commit()
        await session.close()

    async def mark_ended(self, session_id: str) -> None:
        """Mark session as ended (for distillation trigger)."""
        session = self._session()
        await session.execute(
            update(SessionModel)
            .where(SessionModel.id == session_id, self._filter_by_user(SessionModel))
            .values(status="ended")
        )
        await session.commit()
        await session.close()

    async def find_previous_active_session(self, exclude_session_id: str) -> SessionModel | None:
        """Find the user's most recent session that is not the current one,
        not deleted, not ended, and is a top-level session (no parent).

        Used to trigger cross-session distillation when a new session starts.
        Ordered by updated_at desc as a proxy for last activity.
        """
        from sqlalchemy import or_
        session = self._session()
        result = await session.scalar(
            select(SessionModel)
            .where(
                self._filter_by_user(SessionModel),
                SessionModel.is_deleted == 0,
                SessionModel.id != exclude_session_id,
                SessionModel.parent_session_id.is_(None),
                or_(SessionModel.status.is_(None), SessionModel.status != "ended"),
            )
            .order_by(SessionModel.updated_at.desc())
            .limit(1)
        )
        await session.close()
        return result

    async def add_token_count(self, session_id: str, delta: int) -> None:
        """Accumulate token usage into session.token_count for compressor threshold tracking."""
        if delta <= 0:
            return
        session = self._session()
        await session.execute(
            update(SessionModel)
            .where(SessionModel.id == session_id, self._filter_by_user(SessionModel))
            .values(token_count=SessionModel.token_count + delta)
        )
        await session.commit()
        await session.close()

    async def set_token_count(self, session_id: str, value: int) -> None:
        """Overwrite session.token_count (used after compression to reflect actual remaining tokens)."""
        session = self._session()
        await session.execute(
            update(SessionModel)
            .where(SessionModel.id == session_id, self._filter_by_user(SessionModel))
            .values(token_count=max(0, value))
        )
        await session.commit()
        await session.close()