import uuid
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.dao.base import BaseDAO
from app.models.models import Message as MessageModel
from app.middleware.error_handler import AppError


class MessageDAO(BaseDAO):
    async def create(
        self,
        session_id: str,
        role: str,
        content: str | None,
        tool_calls: str | None = None,
        tool_call_id: str | None = None,
        tool_name: str | None = None,
        tool_result: str | None = None,
        reasoning_content: str | None = None,
        token_count: int = 0,
        attachments: str | None = None,
    ) -> MessageModel:
        session = self._session()
        obj = MessageModel(
            id=str(uuid.uuid4()),
            session_id=session_id,
            employee_id=self._employee_id,
            role=role,
            content=content,
            tool_calls=tool_calls,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            tool_result=tool_result,
            reasoning_content=reasoning_content,
            token_count=token_count,
            attachments=attachments,
        )
        session.add(obj)
        await session.commit()
        await session.refresh(obj)
        await session.close()
        return obj

    async def get_history(self, session_id: str, before: str | None = None, limit: int = 50) -> tuple[list[MessageModel], bool]:
        """Return the latest `limit` messages in chronological order (ASC).

        Uses DESC ordering internally so we always get the most recent messages,
        then reverses the result for display. Pass `before` (message ID) to load
        messages older than that cursor — used for scroll-up pagination.
        """
        session = self._session()
        stmt = (
            select(MessageModel)
            .where(MessageModel.session_id == session_id, self._filter_by_user(MessageModel))
            .order_by(MessageModel.created_at.desc())
        )
        if before:
            before_msg = await session.scalar(
                select(MessageModel).where(MessageModel.id == before)
            )
            if before_msg:
                stmt = stmt.where(MessageModel.created_at < before_msg.created_at)
        result = await session.scalars(stmt.limit(limit + 1))
        items = list(result.all())
        has_more = len(items) > limit
        messages = items[:limit] if has_more else items
        messages.reverse()  # Return in chronological ASC order for display/LLM context
        await session.close()
        return messages, has_more

    async def update_token_count(self, message_id: str, token_count: int) -> None:
        session = self._session()
        await session.execute(
            MessageModel.__table__.update()
            .where(MessageModel.id == message_id, self._filter_by_user(MessageModel))
            .values(token_count=token_count)
        )
        await session.commit()
        await session.close()

    async def update(self, message_id: str, **kwargs) -> None:
        """Update message fields (is_distilled, is_compressed, etc.)."""
        session = self._session()
        await session.execute(
            MessageModel.__table__.update()
            .where(MessageModel.id == message_id, self._filter_by_user(MessageModel))
            .values(**kwargs)
        )
        await session.commit()
        await session.close()