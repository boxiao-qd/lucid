"""Cron scheduler — tick-based scheduler with isolated session execution, memory injection, and error backoff."""

import asyncio
import logging
from datetime import datetime

from app.config import settings
from app.db.database import get_session_factory
from app.dao.cron_dao import CronDAO
from app.dao.cron_run_dao import CronRunDAO
from app.dao.notification_dao import NotificationDAO
from app.dao.memory_dao import MemoryDAO
from app.agent.agent_service import AgentService
from app.api.v1.stream import push_user_event
from app.sse.event_types import SSEEventType

log = logging.getLogger(__name__)

ERROR_BACKOFF_SECONDS = [30, 60, 300, 900, 3600]


async def execute_job(job) -> None:
    """Execute a single cron job in an isolated session with memory injection."""
    sf = get_session_factory()
    employee_id = job.employee_id
    cron_run_dao = CronRunDAO(sf, employee_id)
    notif_dao = NotificationDAO(sf, employee_id)
    started_at = datetime.utcnow().isoformat()

    # Create CronRun record
    run = await cron_run_dao.create(cron_job_id=job.id)

    try:
        # Inject user memory into system prompt
        memory_dao = MemoryDAO(sf, employee_id)
        memory_summary = await memory_dao.get_top_summary(max_chars=500)

        system_prompt = f"This is an automated cron task execution. Task name: {job.name}."
        if memory_summary:
            system_prompt += f"\n\n{memory_summary}"

        # Create isolated session
        from app.dao.session_dao import SessionDAO
        session_dao = SessionDAO(sf, employee_id)
        cron_session = await session_dao.create(
            title=f"Cron: {job.name}",
            model=settings.default_model,
            system_prompt=system_prompt,
        )

        # Update run with session_id
        run = await cron_run_dao.create(cron_job_id=job.id, session_id=cron_session.id)

        # Execute the prompt
        agent = AgentService(employee_id)
        await agent.process_message(
            session_id=cron_session.id,
            content=job.prompt,
            role="user",
            is_cron=True,
        )

        # Get the last assistant message as result
        from app.dao.message_dao import MessageDAO
        msg_dao = MessageDAO(sf, employee_id)
        history, _ = await msg_dao.get_history(cron_session.id)
        result_content = ""
        for msg in reversed(history):
            if msg.role == "assistant" and msg.content:
                result_content = msg.content
                break

        # Check for file artifacts in the session (support multiple files)
        from app.models.models import ArtifactFile
        from sqlalchemy import select
        artifact_files = []
        async with sf() as session:
            file_result = await session.execute(
                select(ArtifactFile).where(
                    ArtifactFile.session_id == cron_session.id,
                    ArtifactFile.employee_id == employee_id,
                    ArtifactFile.source_type == "cron_job",
                )
            )
            artifact_files = list(file_result.scalars().all())

        first_file_id = artifact_files[0].id if artifact_files else None

        # Build notification content with file download links
        notif_content = result_content or "(no output)"
        if artifact_files:
            links = "\n".join(
                f"- [{f.file_name}](/bx/api/v1/files/{f.id}/download)"
                for f in artifact_files
            )
            notif_content += f"\n\n---\n### Generated Files\n{links}"

        # Create notification
        title = f"Cron: {job.name}"
        notif = await notif_dao.create(
            title=title,
            content=notif_content,
            source="cron",
            cron_job_id=job.id,
            file_id=first_file_id,
        )

        # Mark run as success
        summary = result_content[:2000] if result_content else None
        await cron_run_dao.mark_success(run.id, result_summary=summary, file_id=first_file_id)

        # Push SSE notification
        push_user_event(employee_id, SSEEventType.notification_new, {
            "notification_id": notif.id,
            "title": title,
            "source": "cron",
            "cron_job_id": job.id,
            "file_id": first_file_id,
        })

        # Mark job as run successfully
        dao = CronDAO(sf, employee_id)
        await dao.mark_run(job.id, success=True)

        log.info("Cron job '%s' (%s) executed for user %d", job.name, job.id, employee_id)

    except Exception as e:
        log.error("Cron job '%s' (%s) failed for user %d: %s", job.name, job.id, employee_id, e)

        # Mark run as failed
        try:
            await cron_run_dao.mark_failed(run.id, error_message=str(e)[:4000])
        except Exception:
            log.error("Failed to record cron run failure for %s", run.id)

        # Notify user of failure
        try:
            notif = await notif_dao.create(
                title=f"Cron Failed: {job.name}",
                content=f"Error: {str(e)[:2000]}",
                source="cron",
                cron_job_id=job.id,
            )
            push_user_event(employee_id, SSEEventType.notification_new, {
                "notification_id": notif.id,
                "title": f"Cron Failed: {job.name}",
                "source": "cron",
                "cron_job_id": job.id,
            })
        except Exception:
            log.error("Failed to send failure notification for job %s", job.id)

        # Mark job as run failed (with backoff)
        dao = CronDAO(sf, employee_id)
        await dao.mark_run(job.id, success=False, error=str(e)[:4000])


async def tick():
    """Check due cron jobs across all users, execute them, create notifications."""
    sf = get_session_factory()
    admin_dao = CronDAO(sf, 0)
    due_jobs = await admin_dao.get_due_jobs()

    if not due_jobs:
        return

    log.info("Cron tick: %d due jobs", len(due_jobs))

    # Execute all due jobs concurrently (different users, no interference)
    tasks = [execute_job(job) for job in due_jobs]
    await asyncio.gather(*tasks, return_exceptions=True)


_running = False


async def start_scheduler(interval_seconds: int = 60):
    """Start the cron scheduler loop. Runs tick() every interval_seconds."""
    global _running
    if _running:
        return
    _running = True
    log.info("Cron scheduler started (interval=%ds)", interval_seconds)

    while _running:
        try:
            await tick()
        except Exception as e:
            log.error("Cron tick error: %s", e)
        await asyncio.sleep(interval_seconds)


def stop_scheduler():
    """Stop the cron scheduler loop."""
    global _running
    _running = False
    log.info("Cron scheduler stopped")