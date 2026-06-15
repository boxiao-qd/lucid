import uuid
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from app.dao.base import BaseDAO
from app.models.models import Skill as SkillModel
from app.models.base import GLOBAL_EMPLOYEE_ID
from app.middleware.error_handler import AppError


class SkillDAO(BaseDAO):
    async def list_skills(self) -> list[SkillModel]:
        session = self._session()
        result = await session.scalars(
            select(SkillModel).where(
                self._filter_user_or_global(SkillModel), SkillModel.is_deleted == 0
            ).order_by(SkillModel.is_global.desc(), SkillModel.created_at.asc())
        )
        items = result.all()
        await session.close()
        return items

    async def get_by_id(self, skill_id: str) -> SkillModel:
        session = self._session()
        obj = await session.scalar(
            select(SkillModel).where(
                SkillModel.id == skill_id,
                self._filter_user_or_global(SkillModel),
                SkillModel.is_deleted == 0,
            )
        )
        await session.close()
        if not obj:
            raise AppError("BX_SKILL_1001", "Skill not found", 404)
        return obj

    async def get_by_name(self, name: str) -> SkillModel | None:
        session = self._session()
        obj = await session.scalar(
            select(SkillModel).where(
                SkillModel.name == name,
                self._filter_user_or_global(SkillModel),
                SkillModel.is_deleted == 0,
            )
        )
        await session.close()
        return obj

    async def create(self, name: str, content_md: str, is_global: bool = False,
                     frontmatter: str | None = None) -> SkillModel:
        if is_global and self._employee_id != GLOBAL_EMPLOYEE_ID:
            raise AppError("BX_SKILL_1003", "Non-admin users cannot create global skills", 403)
        session = self._session()
        eid = GLOBAL_EMPLOYEE_ID if is_global else self._employee_id
        obj = SkillModel(
            id=str(uuid.uuid4()),
            employee_id=eid,
            name=name,
            content_md=content_md,
            is_global=int(is_global),
            frontmatter=frontmatter,
        )
        session.add(obj)
        try:
            await session.commit()
            await session.refresh(obj)
        except IntegrityError:
            await session.rollback()
            raise AppError("BX_SKILL_1002", f"Skill '{name}' already exists", 409)
        finally:
            await session.close()
        return obj

    async def update(self, skill_id: str, name: str | None = None, content_md: str | None = None,
                     header_description: str | None = None,
                     frontmatter: str | None = None) -> SkillModel:
        obj = await self.get_by_id(skill_id)
        if obj.employee_id == GLOBAL_EMPLOYEE_ID and self._employee_id != GLOBAL_EMPLOYEE_ID:
            raise AppError("BX_SKILL_1003", "Cannot modify global skill", 403)
        session = self._session()
        values = {}
        if name is not None:
            values["name"] = name
        if content_md is not None:
            values["content_md"] = content_md
        if header_description is not None:
            values["header_description"] = header_description
        if frontmatter is not None:
            values["frontmatter"] = frontmatter
        if values:
            try:
                await session.execute(
                    update(SkillModel).where(SkillModel.id == skill_id).values(**values)
                )
                await session.commit()
            except IntegrityError:
                await session.rollback()
                raise AppError("BX_SKILL_1002", f"Skill name conflict", 409)
        await session.close()
        updated = await self.get_by_id(skill_id)
        await self._invalidate_cache(updated.name)
        return updated

    async def soft_delete(self, skill_id: str) -> None:
        obj = await self.get_by_id(skill_id)
        if obj.employee_id == GLOBAL_EMPLOYEE_ID and self._employee_id != GLOBAL_EMPLOYEE_ID:
            raise AppError("BX_SKILL_1003", "Cannot delete global skill", 403)
        skill_name = obj.name
        session = self._session()
        await session.execute(
            update(SkillModel).where(SkillModel.id == skill_id).values(is_deleted=1)
        )
        await session.commit()
        await session.close()
        await self._invalidate_cache(skill_name)

    async def _invalidate_cache(self, skill_name: str) -> None:
        from app.cache.cache_provider import create_cache_provider
        cache = create_cache_provider(self._session_factory, self._employee_id)
        await cache.delete(f"skill_content:{self._employee_id}:{skill_name}")
        await cache.delete(f"skills_index:{self._employee_id}")

    async def increment_usage(self, skill_id: str) -> None:
        session = self._session()
        await session.execute(
            update(SkillModel).where(SkillModel.id == skill_id).values(
                usage_count=SkillModel.usage_count + 1
            )
        )
        await session.commit()
        await session.close()

    async def get_index(self) -> list[dict]:
        """Return compact skill index (name + header_description + frontmatter) for system prompt.
        Progressive loading Tier 1: metadata only, no full content."""
        import yaml as _yaml
        session = self._session()
        result = await session.execute(
            select(SkillModel.name, SkillModel.header_description, SkillModel.is_global,
                   SkillModel.object_key, SkillModel.frontmatter)
            .where(self._filter_user_or_global(SkillModel), SkillModel.is_deleted == 0)
            .order_by(SkillModel.is_global.desc(), SkillModel.name.asc())
        )
        items = []
        for r in result.fetchall():
            fm_text = r[4] or ""
            fm: dict = {}
            if fm_text.strip():
                try:
                    parsed = _yaml.safe_load(fm_text)
                    if isinstance(parsed, dict):
                        fm = parsed
                except _yaml.YAMLError:
                    pass
            desc = r[1] or fm.get("description") or r[0]
            items.append({
                "name": r[0], "description": desc, "is_global": r[2],
                "object_key": r[3], "frontmatter": fm,
                "has_assets": bool(r[3]),
            })
        await session.close()
        return items

    async def get_skill_md(self, name: str) -> str | None:
        """Get SKILL.md content for a specific skill.
        Progressive loading Tier 2: load SKILL.md after agent selects a skill.
        Priority: cache → MySQL content_md → object storage (legacy fallback)."""
        from app.cache.cache_provider import create_cache_provider
        from app.storage.object_storage import create_object_storage

        skill = await self.get_by_name(name)
        if not skill:
            return None

        cache = create_cache_provider(self._session_factory, self._employee_id)

        # try cache
        cached = await cache.get(f"skill_content:{self._employee_id}:{name}")
        if cached:
            return cached

        # try MySQL content_md (primary L2 source)
        if skill.content_md:
            await cache.set(f"skill_content:{self._employee_id}:{name}", skill.content_md, ttl=600)
            return skill.content_md

        # legacy fallback: object storage
        if skill.object_key:
            obj_storage = create_object_storage()
            content = await obj_storage.get(self._employee_id, f"{skill.object_key}/SKILL.md")
            if content:
                text = content.decode("utf-8") if isinstance(content, bytes) else content
                await cache.set(f"skill_content:{self._employee_id}:{name}", text, ttl=600)
                return text

        return None

    async def get_skill_directory(self, name: str, sub_path: str = "") -> dict[str, bytes] | None:
        """Get files from a skill directory (scripts/, references/, assets/).
        Progressive loading Tier 3: load sub-directory on demand.
        Returns {relative_path: content}."""
        from app.storage.object_storage import create_object_storage

        skill = await self.get_by_name(name)
        if not skill or not skill.object_key:
            return None

        obj_storage = create_object_storage()
        dir_key = f"{skill.object_key}/{sub_path}" if sub_path else skill.object_key
        return await obj_storage.get_directory(self._employee_id, dir_key)

    async def update_object_key(self, skill_id: str, object_key: str | None, content_hash: str,
                                header_description: str | None = None) -> None:
        """Update object storage association for a skill.
        object_key=None means skill has no MinIO files (SKILL.md only)."""
        session = self._session()
        values: dict = {"content_hash": content_hash}
        if object_key is not None:
            values["object_key"] = object_key
        if header_description is not None:
            values["header_description"] = header_description
        await session.execute(
            update(SkillModel).where(SkillModel.id == skill_id).values(**values)
        )
        await session.commit()
        await session.close()
        obj = await self.get_by_id(skill_id)
        await self._invalidate_cache(obj.name)