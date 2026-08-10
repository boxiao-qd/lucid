from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import event, text
from app.config import settings
import logging

log = logging.getLogger(__name__)

_engine = None
_session_factory = None


async def init_db():
    global _engine, _session_factory

    is_sqlite = settings.db_url.startswith("sqlite")
    is_mysql = "mysql" in settings.db_url

    engine_kwargs = {"echo": settings.debug}
    if is_mysql:
        # Recycle connections every hour to avoid "server has gone away" errors;
        # pre-ping validates the connection before each use.
        # pool_pre_ping=False: aiomysql's async ping() requires a 'reconnect' arg
        # that SQLAlchemy's dialect doesn't pass — causes TypeError on first use.
        # pool_recycle handles stale connections instead.
        engine_kwargs.update({
            "pool_recycle": 3600,
            "pool_pre_ping": False,
            "pool_size": 10,
            "max_overflow": 20,
        })

    _engine = create_async_engine(settings.db_url, **engine_kwargs)

    if is_sqlite:
        @event.listens_for(_engine.sync_engine, "connect")
        def _set_sqlite_pragma(dbapi_conn, connection_record):
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    _session_factory = async_sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)

    # Auto-create tables on startup
    from app.models.base import Base
    from app.models.models import (  # noqa: F401 — all must be imported so create_all sees them
        Session, Message, Memory, UserProfile, Skill, Subagent,
        CronJob, CronRun, Notification, Todo, ArtifactFile,
    )
    from app.models.user import User  # noqa: F401
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Column-level migrations for tables that already existed before new columns were added.
    await _run_column_migrations()


async def _run_column_migrations():
    """Add columns that were introduced after the initial table creation.

    Uses IF NOT EXISTS / information_schema checks so this is safe to run on
    every startup against both SQLite and MySQL.
    """
    sf = get_session_factory()
    async with sf() as session:
        is_mysql = "mysql" in settings.db_url
        is_sqlite = settings.db_url.startswith("sqlite")

        if is_mysql:
            # Add file_id to notifications if missing
            result = await session.execute(text(
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS "
                "WHERE TABLE_SCHEMA = DATABASE() "
                "  AND TABLE_NAME = 'notifications' "
                "  AND COLUMN_NAME = 'file_id'"
            ))
            if result.scalar() == 0:
                await session.execute(text(
                    "ALTER TABLE notifications "
                    "ADD COLUMN file_id VARCHAR(36) NULL, "
                    "ADD CONSTRAINT fk_notif_file "
                    "  FOREIGN KEY (file_id) REFERENCES artifact_files(id) ON DELETE SET NULL"
                ))
                await session.commit()

            # Add is_running and consecutive_errors to cron_jobs if missing
            result = await session.execute(text(
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS "
                "WHERE TABLE_SCHEMA = DATABASE() "
                "  AND TABLE_NAME = 'cron_jobs' "
                "  AND COLUMN_NAME = 'is_running'"
            ))
            if result.scalar() == 0:
                await session.execute(text(
                    "ALTER TABLE cron_jobs "
                    "ADD COLUMN is_running SMALLINT DEFAULT 0, "
                    "ADD COLUMN consecutive_errors INT DEFAULT 0"
                ))
                await session.commit()

            # Add attachments column to messages if missing (multimodal support)
            result = await session.execute(text(
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS "
                "WHERE TABLE_SCHEMA = DATABASE() "
                "  AND TABLE_NAME = 'messages' "
                "  AND COLUMN_NAME = 'attachments'"
            ))
            if result.scalar() == 0:
                await session.execute(text(
                    "ALTER TABLE messages ADD COLUMN attachments TEXT NULL"
                ))
                await session.commit()

        elif is_sqlite:
            result = await session.execute(text("PRAGMA table_info(notifications)"))
            cols = {row[1] for row in result.fetchall()}
            if "file_id" not in cols:
                await session.execute(text(
                    "ALTER TABLE notifications ADD COLUMN file_id VARCHAR(36) NULL "
                    "REFERENCES artifact_files(id) ON DELETE SET NULL"
                ))
                await session.commit()

            result = await session.execute(text("PRAGMA table_info(cron_jobs)"))
            cols = {row[1] for row in result.fetchall()}
            if "is_running" not in cols:
                await session.execute(text(
                    "ALTER TABLE cron_jobs ADD COLUMN is_running SMALLINT DEFAULT 0"
                ))
                await session.commit()
            if "consecutive_errors" not in cols:
                await session.execute(text(
                    "ALTER TABLE cron_jobs ADD COLUMN consecutive_errors INT DEFAULT 0"
                ))
                await session.commit()

            # Add attachments column to messages if missing (multimodal support)
            result = await session.execute(text("PRAGMA table_info(messages)"))
            cols = {row[1] for row in result.fetchall()}
            if "attachments" not in cols:
                await session.execute(text(
                    "ALTER TABLE messages ADD COLUMN attachments TEXT NULL"
                ))
                await session.commit()

            # W0: user-custom-skill — skills table enhancements (top-level, both MySQL and SQLite)
        if is_mysql:
            # Ensure frontmatter column exists as TEXT (not JSON)
            result = await session.execute(text(
                "SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS "
                "WHERE TABLE_SCHEMA = DATABASE() "
                "  AND TABLE_NAME = 'skills' "
                "  AND COLUMN_NAME = 'frontmatter'"
            ))
            col_type = result.scalar()
            if col_type is None:
                await session.execute(text(
                    "ALTER TABLE skills ADD COLUMN frontmatter TEXT NULL"
                ))
                await session.commit()
            elif "json" in col_type.lower():
                # Migrate from JSON to TEXT (raw YAML text)
                await session.execute(text(
                    "ALTER TABLE skills MODIFY COLUMN frontmatter TEXT NULL"
                ))
                await session.commit()

            # Modify content_md from TEXT to MEDIUMTEXT if not already MEDIUMTEXT
            result = await session.execute(text(
                "SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS "
                "WHERE TABLE_SCHEMA = DATABASE() "
                "  AND TABLE_NAME = 'skills' "
                "  AND COLUMN_NAME = 'content_md'"
            ))
            content_md_type = result.scalar()
            if content_md_type and "mediumtext" not in content_md_type.lower():
                await session.execute(text(
                    "ALTER TABLE skills MODIFY COLUMN content_md MEDIUMTEXT NOT NULL"
                ))
                await session.commit()

            # Add unique index uk_skill_name if missing
            result = await session.execute(text(
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS "
                "WHERE TABLE_SCHEMA = DATABASE() "
                "  AND TABLE_NAME = 'skills' "
                "  AND INDEX_NAME = 'uk_skill_name'"
            ))
            if result.scalar() == 0:
                await session.execute(text(
                    "CREATE UNIQUE INDEX uk_skill_name ON skills(name, employee_id, is_deleted)"
                ))
                await session.commit()

            # Backfill frontmatter for existing skills where it is NULL
            import yaml
            result = await session.execute(text(
                "SELECT id, content_md FROM skills WHERE frontmatter IS NULL AND is_deleted = 0"
            ))
            rows = result.fetchall()
            for row in rows:
                skill_id, content_md = row
                fm_text = None
                stripped = content_md.strip()
                if stripped.startswith("---"):
                    parts = stripped.split("---", 2)
                    if len(parts) >= 3:
                        raw = parts[1].strip()
                        if raw:
                            fm_text = raw
                if fm_text is not None:
                    await session.execute(text(
                        "UPDATE skills SET frontmatter = :fm WHERE id = :id"
                    ), {"fm": fm_text, "id": skill_id})
            if rows:
                await session.commit()
                log.info("Backfilled frontmatter for %d existing skills", len(rows))

            # Backfill header_description for existing skills where it is NULL
            result = await session.execute(text(
                "SELECT id, content_md FROM skills WHERE header_description IS NULL AND is_deleted = 0"
            ))
            hd_rows = result.fetchall()
            for row in hd_rows:
                skill_id, content_md = row
                header = None
                stripped = (content_md or "").strip()
                if stripped.startswith("---"):
                    parts = stripped.split("---", 2)
                    if len(parts) >= 3:
                        try:
                            fm = yaml.safe_load(parts[1])
                            if isinstance(fm, dict):
                                desc = fm.get("description")
                                if isinstance(desc, str) and desc.strip():
                                    header = " ".join(desc.split())[:500]
                        except Exception:
                            pass
                if not header:
                    for line in stripped.splitlines():
                        line = line.strip().lstrip("#").strip()
                        if line and line != "---":
                            header = line[:500]
                            break
                if header:
                    await session.execute(text(
                        "UPDATE skills SET header_description = :hd WHERE id = :id"
                    ), {"hd": header, "id": skill_id})
            if hd_rows:
                await session.commit()
                log.info("Backfilled header_description for %d existing skills", len(hd_rows))
        elif is_sqlite:
            result = await session.execute(text("PRAGMA table_info(skills)"))
            cols = {row[1] for row in result.fetchall()}
            if "frontmatter" not in cols:
                await session.execute(text(
                    "ALTER TABLE skills ADD COLUMN frontmatter TEXT NULL"
                ))
                await session.commit()


async def close_db():
    global _engine
    if _engine:
        await _engine.dispose()


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    if _session_factory is None:
        raise RuntimeError("Database not initialized. Call init_db() first.")
    return _session_factory
