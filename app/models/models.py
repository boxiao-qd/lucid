from __future__ import annotations

from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy import String, Text, Integer, SmallInteger, Float, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.mysql import MEDIUMTEXT
from app.models.base import Base, TimestampMixin, UserAccountMixin, GLOBAL_EMPLOYEE_ID


class Session(Base, TimestampMixin, UserAccountMixin):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str | None] = mapped_column(String(256))
    model: Mapped[str | None] = mapped_column(String(128))
    system_prompt: Mapped[str | None] = mapped_column(Text)
    parent_session_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("sessions.id", ondelete="SET NULL"))
    delegation_goal: Mapped[str | None] = mapped_column(Text)
    token_count: Mapped[int] = mapped_column(Integer, default=0)
    max_tokens: Mapped[int] = mapped_column(Integer, default=128000)
    is_deleted: Mapped[int] = mapped_column(SmallInteger, default=0)
    status: Mapped[str | None] = mapped_column(String(16))  # active | ended | archived


class Message(Base, UserAccountMixin):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(36), ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str | None] = mapped_column(MEDIUMTEXT)
    tool_calls: Mapped[str | None] = mapped_column(Text)  # JSON stored as text
    tool_call_id: Mapped[str | None] = mapped_column(String(128))
    tool_name: Mapped[str | None] = mapped_column(String(64))
    tool_result: Mapped[str | None] = mapped_column(MEDIUMTEXT)
    reasoning_content: Mapped[str | None] = mapped_column(MEDIUMTEXT)
    token_count: Mapped[int] = mapped_column(Integer, default=0)
    is_compressed: Mapped[int] = mapped_column(SmallInteger, default=0)
    is_distilled: Mapped[int] = mapped_column(SmallInteger, default=0)  # marked after distillation
    attachments: Mapped[str | None] = mapped_column(Text)  # JSON stored as text, e.g. [{"type":"image","url":"...","name":"..."}]
    created_at: Mapped[str] = mapped_column(String(36), default=lambda: __import__("datetime").datetime.utcnow().isoformat())


class Memory(Base, TimestampMixin, UserAccountMixin):
    __tablename__ = "memory"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str | None] = mapped_column(String(36))

    # memory layer: short_term (cross-session, from session distillation) vs long_term (from short-term distillation)
    memory_type: Mapped[str] = mapped_column(String(16), default="long_term")  # short_term | long_term

    # structured memory fields (replaces flat key-value)
    category: Mapped[str] = mapped_column(String(32), default="fact")  # preference | decision | fact | constraint | goal
    key: Mapped[str] = mapped_column(String(256), nullable=False)
    value: Mapped[str] = mapped_column(Text, nullable=False)

    # ranking and retrieval fields
    importance: Mapped[float] = mapped_column(Float, default=0.5)  # 0.0-1.0, LLM distillation score
    access_count: Mapped[int] = mapped_column(Integer, default=0)  # injected into system prompt count
    last_accessed_at: Mapped[str | None] = mapped_column(String(36))  # last injection timestamp

    # lifecycle
    source: Mapped[str] = mapped_column(String(32), default="agent")  # agent | distillation | user | system
    is_deleted: Mapped[int] = mapped_column(SmallInteger, default=0)


class UserProfile(Base, TimestampMixin):
    __tablename__ = "user_profiles"

    employee_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    display_name: Mapped[str | None] = mapped_column(String(128))
    profile_data: Mapped[str | None] = mapped_column(Text)  # JSON stored as text
    settings: Mapped[str | None] = mapped_column(Text)  # JSON stored as text


class Skill(Base, TimestampMixin):
    __tablename__ = "skills"
    __table_args__ = (
        UniqueConstraint("name", "employee_id", "is_deleted", name="uk_skill_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    employee_id: Mapped[int] = mapped_column(Integer, default=GLOBAL_EMPLOYEE_ID)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    content_md: Mapped[str] = mapped_column(MEDIUMTEXT, nullable=False)  # SKILL.md full text (up to 16MB)
    is_global: Mapped[int] = mapped_column(SmallInteger, default=0)
    usage_count: Mapped[int] = mapped_column(Integer, default=0)
    is_deleted: Mapped[int] = mapped_column(SmallInteger, default=0)

    # object storage fields
    header_description: Mapped[str | None] = mapped_column(String(500))  # skill header for compact index
    object_key: Mapped[str | None] = mapped_column(String(512))  # object storage path to skill directory root
    content_hash: Mapped[str | None] = mapped_column(String(64))  # MD5/SHA256 for cache invalidation
    child_dir_id: Mapped[str | None] = mapped_column(String(36))  # directory structure for progressive loading

    # frontmatter (raw YAML text from SKILL.md, parsed on read)
    frontmatter: Mapped[str | None] = mapped_column(Text, nullable=True)


class Subagent(Base, TimestampMixin):
    __tablename__ = "subagents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    employee_id: Mapped[int] = mapped_column(Integer, default=GLOBAL_EMPLOYEE_ID)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    definition_md: Mapped[str] = mapped_column(Text, nullable=False)  # retained as fallback
    tools: Mapped[str] = mapped_column(Text, nullable=False)  # JSON stored as text
    constraints: Mapped[str | None] = mapped_column(Text)  # JSON stored as text
    is_global: Mapped[int] = mapped_column(SmallInteger, default=0)
    is_deleted: Mapped[int] = mapped_column(SmallInteger, default=0)

    # object storage fields (new)
    header_description: Mapped[str | None] = mapped_column(String(500))
    object_key: Mapped[str | None] = mapped_column(String(512))


class Todo(Base, TimestampMixin, UserAccountMixin):
    __tablename__ = "todos"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str | None] = mapped_column(String(36))  # originating session
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending | in_progress | completed | cancelled
    priority: Mapped[int] = mapped_column(Integer, default=0)  # 0=normal, 1=high, 2=urgent
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    due_date: Mapped[str | None] = mapped_column(String(36))  # ISO 8601
    completed_at: Mapped[str | None] = mapped_column(String(36))
    tags: Mapped[str | None] = mapped_column(Text)  # JSON ["tag1","tag2"]
    parent_id: Mapped[str | None] = mapped_column(String(36))  # parent todo for subtasks
    is_deleted: Mapped[int] = mapped_column(SmallInteger, default=0)


class CronJob(Base, TimestampMixin, UserAccountMixin):
    __tablename__ = "cron_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str | None] = mapped_column(String(128))
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    cron_expr: Mapped[str] = mapped_column(String(128), nullable=False)
    is_active: Mapped[int] = mapped_column(SmallInteger, default=1)
    is_running: Mapped[int] = mapped_column(SmallInteger, default=0)
    last_run_at: Mapped[str | None] = mapped_column(String(36))
    next_run_at: Mapped[str | None] = mapped_column(String(36))
    last_error: Mapped[str | None] = mapped_column(Text)
    run_count: Mapped[int] = mapped_column(Integer, default=0)
    consecutive_errors: Mapped[int] = mapped_column(Integer, default=0)
    is_deleted: Mapped[int] = mapped_column(SmallInteger, default=0)


class CronRun(Base, TimestampMixin, UserAccountMixin):
    __tablename__ = "cron_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    cron_job_id: Mapped[str] = mapped_column(String(36), ForeignKey("cron_jobs.id", ondelete="CASCADE"), nullable=False)
    session_id: Mapped[str | None] = mapped_column(String(36))
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending | running | success | failed | timeout
    result_summary: Mapped[str | None] = mapped_column(Text)
    error_message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[str | None] = mapped_column(String(36))
    finished_at: Mapped[str | None] = mapped_column(String(36))
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    file_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("artifact_files.id", ondelete="SET NULL"))


class Notification(Base, TimestampMixin, UserAccountMixin):
    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(String(32), default="cron")
    cron_job_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("cron_jobs.id", ondelete="SET NULL"))
    file_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("artifact_files.id", ondelete="SET NULL"))
    is_read: Mapped[int] = mapped_column(SmallInteger, default=0)
    is_deleted: Mapped[int] = mapped_column(SmallInteger, default=0)


class ArtifactFile(Base, TimestampMixin, UserAccountMixin):
    __tablename__ = "artifact_files"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str | None] = mapped_column(String(36))
    file_name: Mapped[str] = mapped_column(String(512), nullable=False)
    minio_key: Mapped[str] = mapped_column(String(1024), nullable=False)
    file_size: Mapped[int | None] = mapped_column(Integer)
    source_type: Mapped[str] = mapped_column(String(32), nullable=False)  # skill|subagent|task|cron_job
    source_name: Mapped[str | None] = mapped_column(String(256))