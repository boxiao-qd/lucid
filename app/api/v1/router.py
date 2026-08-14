from fastapi import APIRouter
from app.api.v1.sessions import router as sessions_router
from app.api.v1.messages import router as messages_router
from app.api.v1.stream import router as stream_router
from app.api.v1.search import router as search_router
from app.api.v1.settings import router as settings_router
from app.api.v1.subagents import router as subagents_router
from app.api.v1.memory import router as memory_router
from app.api.v1.skills import router as skills_router
from app.api.v1.cron import router as cron_router
from app.api.v1.notifications import router as notifications_router
from app.api.v1.files import router as files_router
from app.api.v1.mcp import router as mcp_router
from app.api.v1.internal.cron import router as internal_cron_router
from app.api.v1.tasks import router as tasks_router
from app.api.v1.confirmations import router as confirmations_router

api_router = APIRouter()

api_router.include_router(sessions_router, tags=["sessions"])
api_router.include_router(messages_router, tags=["messages"])
api_router.include_router(stream_router, tags=["stream"])
api_router.include_router(search_router, tags=["search"])
api_router.include_router(settings_router, tags=["settings"])
api_router.include_router(subagents_router, tags=["subagents"])
api_router.include_router(memory_router, tags=["memory"])
api_router.include_router(skills_router, tags=["skills"])
api_router.include_router(cron_router, tags=["cron"])
api_router.include_router(notifications_router, tags=["notifications"])
api_router.include_router(files_router, tags=["files"])
api_router.include_router(mcp_router, tags=["mcp"])
api_router.include_router(internal_cron_router)
api_router.include_router(tasks_router, tags=["tasks"])
api_router.include_router(confirmations_router, tags=["confirmations"])