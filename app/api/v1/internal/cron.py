"""定时任务内部 API — 调度器 → super-agent 通信，X-Internal-Token 鉴权。"""

import logging
import time

from fastapi import APIRouter, Header, HTTPException

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

router = APIRouter(prefix="/internal/cron", tags=["internal-cron"])


async def _verify_token(x_internal_token: str | None = Header(None)) -> None:
    expected = settings.internal_api_token
    if not expected:
        log.warning("INTERNAL_API_TOKEN 未配置，内部 API 处于开放状态")
        return
    if not x_internal_token or x_internal_token != expected:
        raise HTTPException(status_code=403, detail="Invalid or missing internal token")


async def _extract_keywords(prompt: str) -> list[str]:
    """从 prompt 中提取关键词用于记忆搜索。"""
    words = [w.strip().strip(",.，。\"'\"''\"\"'") for w in prompt.split() if len(w.strip()) > 1]
    return list({w for w in words if not w.isdigit()})[:10]


@router.post("/execute")
async def execute_cron_job(
    job_id: str,
    employee_id: int,
    x_internal_token: str | None = Header(None),
):
    """执行单个定时任务，由 Celery 调度器通过 HTTP 调用。"""
    await _verify_token(x_internal_token)

    t_start = time.time()

    sf = get_session_factory()
    actor_dao = CronDAO(sf, employee_id)
    cron_run_dao = CronRunDAO(sf, employee_id)
    notif_dao = NotificationDAO(sf, employee_id)

    job = await actor_dao.get_by_id(job_id)
    if not job or not job.is_active or job.is_deleted:
        log.warning("[cron] 任务已失效，跳过: job_id=%s", job_id)
        return {"status": "skipped", "reason": "job not valid"}

    # Prevent duplicate execution: refuse if this job already has a running CronRun
    existing_runs = await cron_run_dao.list_runs(job.id, limit=5)
    for r in existing_runs:
        if r.status == "running":
            log.warning("[cron] 任务已有运行中的执行记录，跳过: job_id=%s run_id=%s", job_id, r.id)
            return {"status": "skipped", "reason": "job already running", "run_id": r.id}

    log.info(
        "[cron] 接收任务: job_id=%s employee_id=%s 名称='%s' cron='%s' prompt长度=%d",
        job_id, employee_id, job.name, job.cron_expr, len(job.prompt),
    )

    run = await cron_run_dao.create(cron_job_id=job.id)
    log.info("[cron] 执行记录已创建: run_id=%s job_id=%s", run.id, job_id)

    try:
        # 加载用户记忆（关键词匹配）
        keywords = await _extract_keywords(job.prompt)
        memory_dao = MemoryDAO(sf, employee_id)
        memory_text = await memory_dao.get_top_summary(max_chars=2000, keywords=keywords)
        log.info(
            "[cron] 记忆加载完成: 关键词=%s 记忆长度=%d",
            keywords, len(memory_text or ""),
        )

        # 创建隔离会话
        from app.dao.session_dao import SessionDAO
        session_dao = SessionDAO(sf, employee_id)
        cron_session = await session_dao.create(
            title=f"Cron: {job.name}",
            model=settings.default_model,
            system_prompt=None,
        )
        log.info("[cron] 会话已创建: session_id=%s 模型=%s", cron_session.id, settings.default_model)

        # 将记忆注入到用户消息之后
        full_prompt = job.prompt
        if memory_text:
            full_prompt += f"\n\n---\n{memory_text}"

        # 执行 Agent 循环
        log.info("[cron] Agent 开始执行: session_id=%s prompt长度=%d", cron_session.id, len(full_prompt))
        agent = AgentService(employee_id)
        await agent.process_message(
            session_id=cron_session.id,
            content=full_prompt,
            role="user",
            is_cron=True,
        )
        log.info("[cron] Agent 执行完成: session_id=%s 耗时=%.1fs", cron_session.id, time.time() - t_start)

        # 提取结果：取最后一条有实质内容的 assistant 消息（跳过简短结尾）
        from app.dao.message_dao import MessageDAO
        msg_dao = MessageDAO(sf, employee_id)
        history, _ = await msg_dao.get_history(cron_session.id)
        result_content = ""
        for msg in reversed(history):
            if msg.role == "assistant" and msg.content and len(msg.content) > 200:
                result_content = msg.content
                break
        log.info("[cron] 结果提取完成: 长度=%d", len(result_content))

        # 检查文件产物（支持多文件）
        from app.models.models import ArtifactFile
        from sqlalchemy import select
        artifact_files: list = []
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
        if artifact_files:
            log.info(
                "[cron] 文件产物: %d 个文件: %s",
                len(artifact_files),
                ", ".join(f.file_name for f in artifact_files),
            )

        # 构造通知内容（追加文件下载链接）
        notification_content = result_content or "(无输出)"
        if artifact_files:
            links = "\n".join(
                f"- [{f.file_name}](/bx/api/v1/files/{f.id}/download)"
                for f in artifact_files
            )
            notification_content += f"\n\n---\n### 生成的文件\n{links}"

        # 创建通知 + 推送 SSE
        title = f"Cron: {job.name}"
        notif = await notif_dao.create(
            title=title,
            content=notification_content,
            source="cron",
            cron_job_id=job.id,
            file_id=first_file_id,
        )
        log.info("[cron] 通知已创建: notif_id=%s 标题='%s'", notif.id, title)

        push_user_event(employee_id, SSEEventType.notification_new, {
            "notification_id": notif.id,
            "title": title,
            "source": "cron",
            "cron_job_id": job.id,
            "file_id": first_file_id,
        })
        log.info("[cron] SSE 已推送: employee_id=%d", employee_id)

        summary = result_content[:2000] if result_content else None
        await cron_run_dao.mark_success(run.id, result_summary=summary, file_id=first_file_id)
        await actor_dao.mark_run(job.id, success=True)

        log.info(
            "[cron] 执行成功: job_id=%s 名称='%s' employee_id=%d run_id=%s 总耗时=%.1fs",
            job_id, job.name, employee_id, run.id, time.time() - t_start,
        )
        return {"status": "success", "run_id": run.id}

    except Exception as e:
        elapsed = time.time() - t_start
        log.error(
            "[cron] 执行失败: job_id=%s 名称='%s' employee_id=%d run_id=%s 耗时=%.1fs 错误=%s",
            job_id, job.name, employee_id, run.id, elapsed, e, exc_info=True,
        )

        try:
            await cron_run_dao.mark_failed(run.id, error_message=str(e)[:4000])
        except Exception:
            log.error("[cron] 记录执行失败状态失败: run_id=%s", run.id, exc_info=True)

        try:
            notif = await notif_dao.create(
                title=f"Cron 失败: {job.name}",
                content=str(e)[:2000],
                source="cron",
                cron_job_id=job.id,
            )
            push_user_event(employee_id, SSEEventType.notification_new, {
                "notification_id": notif.id,
                "title": f"Cron 失败: {job.name}",
                "source": "cron",
                "cron_job_id": job.id,
            })
            log.info("[cron] 失败通知已发送: notif_id=%s", notif.id)
        except Exception:
            log.error("[cron] 发送失败通知失败: job_id=%s", job.id, exc_info=True)

        await actor_dao.mark_run(job.id, success=False, error=str(e)[:4000])

        return {"status": "failed", "run_id": run.id, "error": str(e)[:2000]}