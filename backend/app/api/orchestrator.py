"""Orchestrator chat sessions — REST + SSE endpoints.

POST   /api/workflows/{wid}/sessions       create a session for a workflow
GET    /api/workflows/{wid}/sessions       list sessions on a workflow
GET    /api/sessions/{sid}/messages        chat history rendered for the panel
POST   /api/sessions/{sid}/messages        SSE stream of orchestrator events
                                            for one user-message turn
"""
from __future__ import annotations
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session as DbSession

from app.db import get_db, SessionLocal
from app import models, schemas
from app.orchestrator import agent


router = APIRouter(prefix="/api", tags=["orchestrator"])


@router.post("/workflows/{wid}/sessions", response_model=schemas.SessionOut)
def create_session(wid: str, db: DbSession = Depends(get_db)) -> schemas.SessionOut:
    if not db.get(models.Workflow, wid):
        raise HTTPException(404, f"workflow {wid} not found")
    s = models.Session(workflow_id=wid)
    db.add(s)
    db.commit()
    db.refresh(s)
    return schemas.SessionOut(id=s.id, workflow_id=s.workflow_id)


@router.get("/workflows/{wid}/sessions", response_model=list[schemas.SessionOut])
def list_sessions(wid: str, db: DbSession = Depends(get_db)) -> list[schemas.SessionOut]:
    if not db.get(models.Workflow, wid):
        raise HTTPException(404, f"workflow {wid} not found")
    rows = (
        db.query(models.Session)
        .filter_by(workflow_id=wid)
        .order_by(models.Session.created_at.asc())
        .all()
    )
    return [schemas.SessionOut(id=r.id, workflow_id=r.workflow_id) for r in rows]


@router.get("/sessions/{sid}/messages", response_model=schemas.SessionMessagesOut)
def get_messages(sid: str, db: DbSession = Depends(get_db)) -> schemas.SessionMessagesOut:
    if not db.get(models.Session, sid):
        raise HTTPException(404, f"session {sid} not found")
    bubbles = agent.render_history(db, sid)
    return schemas.SessionMessagesOut(messages=bubbles)  # type: ignore[arg-type]


@router.post("/sessions/{sid}/cancel")
def cancel_session_turn(sid: str, db: DbSession = Depends(get_db)) -> dict:
    """Signal the in-flight orchestrator turn for this session to stop.

    Idempotent: returns ``{cancelled: false}`` if no turn is currently running.
    The running ``run_turn`` generator detects the signal at its next checkpoint
    (between LLM rounds, mid-SSE-stream, or between tool calls) and exits.
    """
    if not db.get(models.Session, sid):
        raise HTTPException(404, f"session {sid} not found")
    ok = agent._signal_cancel(sid)
    return {"cancelled": ok}


@router.post("/sessions/{sid}/messages")
def post_message(sid: str, body: schemas.UserMessageIn) -> StreamingResponse:
    """Stream orchestrator events as Server-Sent Events.

    Each event is a single line `data: {json}\\n\\n`. Event kinds match
    ``app.orchestrator.agent.run_turn``: user_message, assistant_text,
    tool_call_start, tool_call_end, error, done.
    """
    # We use our own DB session here (not Depends) because the generator runs
    # outside the FastAPI request handler's lifecycle.
    db = SessionLocal()
    if not db.get(models.Session, sid):
        db.close()
        raise HTTPException(404, f"session {sid} not found")

    def gen():
        try:
            for event in agent.run_turn(db, sid, body.text):
                yield f"data: {json.dumps(event, default=str)}\n\n"
        finally:
            db.close()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable proxy buffering on dev
            "Connection": "keep-alive",
        },
    )
