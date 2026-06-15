import uuid
from sqlalchemy import select, update
from app.dao.base import BaseDAO
from app.models.models import Todo as TodoModel


class TodoDAO(BaseDAO):
    async def list_todos(
        self,
        status: str | None = None,
        session_id: str | None = None,
    ) -> list[TodoModel]:
        session = self._session()
        stmt = select(TodoModel).where(
            self._filter_by_user(TodoModel),
            TodoModel.is_deleted == 0,
        )
        if status:
            stmt = stmt.where(TodoModel.status == status)
        if session_id:
            stmt = stmt.where(TodoModel.session_id == session_id)
        stmt = stmt.order_by(TodoModel.sort_order.asc(), TodoModel.priority.desc())
        result = await session.scalars(stmt)
        items = result.all()
        await session.close()
        return items

    async def create(
        self,
        title: str,
        description: str | None = None,
        priority: int = 0,
        session_id: str | None = None,
        parent_id: str | None = None,
        tags: list[str] | None = None,
        todo_id: str | None = None,
        status: str | None = None,
        sort_order: int | None = None,
    ) -> TodoModel:
        session = self._session()
        import json
        obj_id = todo_id or str(uuid.uuid4())

        # If the ID already exists (e.g. soft-deleted), reactivate and update it
        existing = await session.get(TodoModel, obj_id)
        if existing is not None:
            existing.is_deleted = 0
            existing.title = title
            existing.description = description
            existing.priority = priority
            existing.session_id = session_id
            existing.parent_id = parent_id
            existing.tags = json.dumps(tags) if tags else None
            if status is not None:
                existing.status = status
            if sort_order is not None:
                existing.sort_order = sort_order
            await session.commit()
            await session.refresh(existing)
            await session.close()
            return existing

        obj = TodoModel(
            id=obj_id,
            employee_id=self._employee_id,
            session_id=session_id,
            title=title,
            description=description,
            priority=priority,
            status=status or "pending",
            sort_order=sort_order or 0,
            tags=json.dumps(tags) if tags else None,
            parent_id=parent_id,
        )
        session.add(obj)
        await session.commit()
        await session.refresh(obj)
        await session.close()
        return obj

    async def get_by_id(self, todo_id: str) -> TodoModel | None:
        session = self._session()
        result = await session.scalars(
            select(TodoModel).where(
                self._filter_by_user(TodoModel),
                TodoModel.id == todo_id,
                TodoModel.is_deleted == 0,
            )
        )
        item = result.first()
        await session.close()
        return item

    async def update_status(self, todo_id: str, status: str) -> TodoModel | None:
        session = self._session()
        result = await session.scalars(
            select(TodoModel).where(
                self._filter_by_user(TodoModel),
                TodoModel.id == todo_id,
                TodoModel.is_deleted == 0,
            )
        )
        item = result.first()
        if item:
            item.status = status
            if status == "completed":
                from datetime import datetime
                item.completed_at = datetime.utcnow().isoformat()
            await session.commit()
            await session.refresh(item)
        await session.close()
        return item

    async def update(self, todo_id: str, **kwargs) -> TodoModel | None:
        session = self._session()
        result = await session.scalars(
            select(TodoModel).where(
                self._filter_by_user(TodoModel),
                TodoModel.id == todo_id,
                TodoModel.is_deleted == 0,
            )
        )
        item = result.first()
        if item:
            for k, v in kwargs.items():
                if hasattr(item, k):
                    setattr(item, k, v)
            await session.commit()
            await session.refresh(item)
        await session.close()
        return item

    async def get_pending(self, limit: int = 5) -> list[TodoModel]:
        """Return pending/in_progress todos ordered by priority desc, created_at desc."""
        session = self._session()
        stmt = (
            select(TodoModel)
            .where(
                self._filter_by_user(TodoModel),
                TodoModel.is_deleted == 0,
                TodoModel.status.in_(["pending", "in_progress"]),
            )
            .order_by(TodoModel.priority.desc(), TodoModel.created_at.desc())
            .limit(limit)
        )
        result = await session.scalars(stmt)
        items = result.all()
        await session.close()
        return items

    async def soft_delete(self, todo_id: str) -> bool:
        session = self._session()
        result = await session.scalars(
            select(TodoModel).where(
                self._filter_by_user(TodoModel),
                TodoModel.id == todo_id,
                TodoModel.is_deleted == 0,
            )
        )
        item = result.first()
        if item:
            item.is_deleted = 1
            await session.commit()
        await session.close()
        return item is not None