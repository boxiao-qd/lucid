from contextlib import asynccontextmanager
import asyncio
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.v1.router import api_router
from app.api.auth import router as auth_router
from app.middleware.auth import AuthMiddleware
from app.middleware.error_handler import register_error_handlers
from app.responses import UnicodeJSONResponse
from app.config import settings
from app.db.database import init_db, close_db
from app.db.elasticsearch import init_es, close_es
from app.agent.docker_sandbox import get_sandbox_manager

log = logging.getLogger(__name__)


async def _sandbox_cleanup_loop():
    """Background task: clean up idle Docker containers every 5 minutes."""
    while True:
        await asyncio.sleep(300)
        try:
            manager = get_sandbox_manager()
            manager.cleanup_idle()
            log.info("Sandbox cleanup cycle completed")
        except Exception as exc:
            log.warning(f"Sandbox cleanup failed: {exc}")


async def _daily_memory_consolidation():
    """Consolidate short_term memories → long_term for all users via LLM review.

    Instead of mechanically promoting by importance threshold, each user's
    short-term memories are sent to an LLM that:
    - Merges duplicate/overlapping memories
    - Re-scores importance with global perspective
    - Decides promote (→long_term), keep (→short_term), or discard (soft-delete)

    Falls back to rule-based consolidation (>=0.7 promote, <0.5 discard) if the
    LLM call fails.
    """
    from sqlalchemy import select, distinct
    from app.db.database import get_session_factory
    from app.dao.memory_dao import MemoryDAO
    from app.agent.memory_distiller import MemoryDistiller
    from app.models.models import Memory as MemoryModel

    sf = get_session_factory()
    try:
        async with sf() as session:
            result = await session.scalars(
                select(distinct(MemoryModel.employee_id)).where(
                    MemoryModel.is_deleted == 0,
                    MemoryModel.memory_type == "short_term",
                )
            )
            employee_ids = list(result.all())
    except Exception as exc:
        log.error("Daily consolidation: failed to query employee list: %s", exc)
        return

    if not employee_ids:
        log.debug("Daily consolidation: no users with short_term memories, skipping")
        return

    total_promoted = 0
    total_discarded = 0
    total_merged = 0
    total_kept = 0
    for eid in employee_ids:
        try:
            distiller = MemoryDistiller(eid, sf)
            result = await distiller.consolidate_with_llm(eid)
            if any(result.values()):
                log.info(
                    "Daily STM→LTM (LLM): user=%d promoted=%d discarded=%d merged=%d kept=%d",
                    eid, result["promoted"], result["discarded"], result["merged"], result["kept"],
                )
            total_promoted += result["promoted"]
            total_discarded += result["discarded"]
            total_merged += result["merged"]
            total_kept += result["kept"]
        except Exception as exc:
            log.error("Daily STM→LTM failed for user %d: %s", eid, exc)

    log.info(
        "Daily consolidation complete: %d users processed, %d promoted, %d discarded, %d merged, %d kept",
        len(employee_ids), total_promoted, total_discarded, total_merged, total_kept,
    )


async def _daily_consolidation_loop():
    """Sleep until next 3 AM Asia/Shanghai, then consolidate STM→LTM for all users.

    This task is invisible to users — it runs server-side on a fixed schedule.
    Each user's short-term memories are independently evaluated:
    high-importance (>= 0.7) facts are promoted to long-term memory,
    low-importance (< 0.5) noise is discarded.
    """
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo

    tz = ZoneInfo("Asia/Shanghai")
    while True:
        now = datetime.now(tz)
        # Next 3:00 AM in Asia/Shanghai
        next_run = now.replace(hour=3, minute=0, second=0, microsecond=0)
        if now >= next_run:
            next_run += timedelta(days=1)
        wait_seconds = (next_run - now).total_seconds()
        log.info(
            "Daily consolidation: next run at %s (in %.1f hours)",
            next_run.isoformat(), wait_seconds / 3600,
        )
        await asyncio.sleep(wait_seconds)
        try:
            await _daily_memory_consolidation()
        except Exception as exc:
            log.error("Daily consolidation loop error: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not settings.jwt_secret:
        log.warning("JWT_SECRET is not set — tokens will be invalid. Set JWT_SECRET in .env before production use.")
    await init_db()
    await init_es()

    # Clean up stale L3 skill assets from previous abnormal exits
    from app.agent.skill_asset_loader import cleanup_stale_sessions
    cleanup_stale_sessions()

    # Start background sandbox cleanup if Docker is available
    cleanup_task = asyncio.create_task(_sandbox_cleanup_loop())
    # Daily STM→LTM memory consolidation (runs at 3 AM Asia/Shanghai)
    consolidation_task = asyncio.create_task(_daily_consolidation_loop())

    # Initialize MCP connection manager and auto-connect enabled servers
    from app.agent.mcp.connection_manager import MCPConnectionManager
    mcp_cm = MCPConnectionManager.get_instance()
    try:
        await mcp_cm.startup_from_config()
        log.info("MCP connection manager initialized from config file")
    except Exception as exc:
        log.warning("MCP connection manager startup failed: %s", exc)

    yield

    # Shutdown MCP connections
    try:
        await mcp_cm.shutdown_all()
    except Exception as exc:
        log.warning("MCP connection manager shutdown failed: %s", exc)
    MCPConnectionManager.reset_instance()

    for task in (cleanup_task, consolidation_task):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    await close_db()
    await close_es()


app = FastAPI(
    title="BX Super Agent",
    description="企业级 SaaS 化超级智能体 API",
    version="0.1.0",
    root_path=settings.root_path,
    lifespan=lifespan,
    default_response_class=UnicodeJSONResponse,
)

register_error_handlers(app)
# Middleware runs in reverse registration order: AuthMiddleware first, then CORSMiddleware.
# AuthMiddleware explicitly skips OPTIONS (CORS preflight) so CORSMiddleware can handle them.
# Do NOT reorder these two without updating auth.py's OPTIONS exemption logic.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(AuthMiddleware)

app.include_router(auth_router)
app.include_router(api_router, prefix="/v1")


def main():
    import uvicorn
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s  %(message)s",
        datefmt="%H:%M:%S",
    )
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=settings.debug,
        log_level="info" if not settings.debug else "debug",
    )


if __name__ == "__main__":
    main()