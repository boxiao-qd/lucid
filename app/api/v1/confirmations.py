"""Tool confirmation API — user approves/rejects terminal/code_execute execution."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.dependencies import get_employee_id
from app.agent.tools.tool_confirmation import resolve_confirmation
from app.middleware.error_handler import AppError

router = APIRouter()


class ToolConfirmRequest(BaseModel):
    confirmation_id: str
    action: str  # approve_once | approve_session | reject | custom
    text: str = ""


class ToolConfirmResponse(BaseModel):
    ok: bool


@router.post("/sessions/{session_id}/tool-confirm", response_model=ToolConfirmResponse)
async def confirm_tool(
    session_id: str,
    body: ToolConfirmRequest,
    employee_id: int = Depends(get_employee_id),
):
    ok = resolve_confirmation(body.confirmation_id, body.action, body.text)
    if not ok:
        raise AppError("BX_CONFIRM_001", "确认已过期或无效", 404)
    return {"ok": True}
