from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from app.dependencies import get_employee_id, get_db_session
from app.db.database import get_session_factory
from app.dao.message_dao import MessageDAO
from app.agent.agent_service import AgentService
from app.schemas.messages import SendMessageRequest, SendMessageResponse, MessageHistoryResponse, MessageItem
from app.schemas.common import SuccessResponse
import asyncio
import json
import logging

log = logging.getLogger(__name__)

router = APIRouter()


@router.post("/messages", response_model=SendMessageResponse)
async def send_message(
    req: SendMessageRequest,
    employee_id: int = Depends(get_employee_id),
):
    # Save message and trigger agent conversation loop in background
    dao = MessageDAO(get_session_factory(), employee_id)
    attachments_json = json.dumps([a.model_dump() for a in req.attachments]) if req.attachments else None
    msg = await dao.create(
        session_id=req.session_id,
        role=req.role.value,
        content=req.content,
        attachments=attachments_json,
    )

    # Kick off agent processing in background — SSE will stream events
    agent = AgentService(employee_id)
    task = asyncio.create_task(
        agent.process_message(
            req.session_id, req.content, req.role.value,
            user_msg_id=msg.id,
            attachments=[a.model_dump() for a in req.attachments] if req.attachments else None,
        )
    )

    def _on_agent_done(t: asyncio.Task):
        exc = t.exception() if not t.cancelled() else None
        if exc:
            log.error("agent task failed for session %s", req.session_id, exc_info=exc)

    task.add_done_callback(_on_agent_done)

    return SendMessageResponse(message_id=msg.id, created_at=msg.created_at)


@router.get("/messages/{session_id}", response_model=MessageHistoryResponse)
async def get_message_history(
    session_id: str,
    before: str | None = Query(None, description="Load messages older than this message ID (scroll-up pagination)"),
    limit: int = Query(50, ge=1, le=200),
    employee_id: int = Depends(get_employee_id),
):
    dao = MessageDAO(get_session_factory(), employee_id)
    messages, has_more = await dao.get_history(session_id, before=before, limit=limit)
    return MessageHistoryResponse(
        messages=[
            MessageItem(
                id=m.id, session_id=m.session_id, role=m.role, content=m.content,
                tool_calls=json.loads(m.tool_calls) if m.tool_calls else None,
                tool_name=m.tool_name, tool_call_id=m.tool_call_id,
                reasoning_content=m.reasoning_content, token_count=m.token_count,
                is_compressed=bool(m.is_compressed),
                attachments=json.loads(m.attachments) if m.attachments else None,
                created_at=m.created_at,
            )
            for m in messages
        ],
        has_more=has_more,
    )
