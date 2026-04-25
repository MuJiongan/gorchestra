from __future__ import annotations
import threading
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from app.db import get_db, SessionLocal
from app import models, schemas
from app.runner import events as ev_mod
from app.runner.runner import run_workflow_streaming, materialize_run_result

router = APIRouter(prefix="/api", tags=["runs"])


def _serialize_workflow(w: models.Workflow) -> dict:
    return {
        "id": w.id,
        "input_node_id": w.input_node_id,
        "output_node_id": w.output_node_id,
        "nodes": [
            {
                "id": n.id,
                "name": n.name,
                "code": n.code,
                "inputs": n.inputs or [],
                "outputs": n.outputs or [],
                "config": n.config or {},
            }
            for n in w.nodes
        ],
        "edges": [
            {
                "id": e.id,
                "from_node_id": e.from_node_id,
                "from_output": e.from_output,
                "to_node_id": e.to_node_id,
                "to_input": e.to_input,
            }
            for e in w.edges
        ],
    }


def _execute_run(run_id: str, wf_data: dict, inputs: dict, default_model: str) -> None:
    """Run streaming, then persist the materialized result + node runs to the DB."""
    run_workflow_streaming(run_id, wf_data, inputs, default_model)
    result = materialize_run_result(run_id)
    db = SessionLocal()
    try:
        run = db.get(models.Run, run_id)
        if not run:
            return
        run.status = result.get("status", "error")
        run.outputs = result.get("outputs") or {}
        run.error = result.get("error")
        run.total_cost = result.get("total_cost", 0.0) or 0.0
        run.ended_at = datetime.utcnow()
        for nr in result.get("node_runs") or []:
            db.add(
                models.NodeRun(
                    run_id=run_id,
                    node_id=nr["node_id"],
                    status=nr.get("status") or "error",
                    inputs=nr.get("inputs") or {},
                    outputs=nr.get("outputs") or {},
                    logs=nr.get("logs") or [],
                    llm_calls=nr.get("llm_calls") or [],
                    tool_calls=nr.get("tool_calls") or [],
                    error=nr.get("error"),
                    duration_ms=int(nr.get("duration_ms") or 0),
                    cost=float(nr.get("cost") or 0.0),
                )
            )
        db.commit()
    finally:
        db.close()


def _run_to_out(run: models.Run, node_runs) -> schemas.RunOut:
    return schemas.RunOut(
        id=run.id,
        workflow_id=run.workflow_id,
        kind=run.kind,
        status=run.status,
        inputs=run.inputs or {},
        outputs=run.outputs or {},
        error=run.error,
        total_cost=run.total_cost or 0.0,
        node_runs=[
            schemas.NodeRunOut(
                id=nr.id,
                node_id=nr.node_id,
                status=nr.status,
                inputs=nr.inputs or {},
                outputs=nr.outputs or {},
                logs=nr.logs or [],
                llm_calls=nr.llm_calls or [],
                tool_calls=nr.tool_calls or [],
                error=nr.error,
                duration_ms=nr.duration_ms or 0,
                cost=nr.cost or 0.0,
            )
            for nr in node_runs
        ],
    )


@router.post("/workflows/{wid}/runs", response_model=schemas.RunOut)
def start_run(wid: str, body: schemas.RunStartIn, db: Session = Depends(get_db)):
    w = db.get(models.Workflow, wid)
    if not w:
        raise HTTPException(404)

    run = models.Run(
        workflow_id=wid,
        kind=body.kind,
        status="running",
        inputs=body.inputs,
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    import os as _os
    wf_data = _serialize_workflow(w)
    # localStorage (forwarded via header → env by middleware) wins; DB row is
    # the backwards-compat fallback.
    default_model = _os.getenv("DEFAULT_NODE_MODEL", "")
    if not default_model:
        setting = db.query(models.Setting).filter_by(key="default_node_model").first()
        default_model = setting.value if setting and setting.value else ""

    # Pre-create the run state so a WS client subscribing immediately doesn't race.
    ev_mod.get_or_create(run.id)

    threading.Thread(
        target=_execute_run,
        args=(run.id, wf_data, body.inputs, default_model),
        daemon=True,
    ).start()

    return _run_to_out(run, [])


@router.post("/runs/{rid}/cancel")
def cancel_run(rid: str):
    """SIGTERM the run's subprocess, if any. Idempotent."""
    ok = ev_mod.cancel(rid)
    return {"cancelled": ok}


@router.get("/runs/{rid}", response_model=schemas.RunOut)
def get_run(rid: str, db: Session = Depends(get_db)):
    run = db.get(models.Run, rid)
    if not run:
        raise HTTPException(404)
    return _run_to_out(run, run.node_runs)


@router.get("/workflows/{wid}/runs", response_model=list[schemas.RunOut])
def list_runs(wid: str, db: Session = Depends(get_db)):
    rows = (
        db.query(models.Run)
        .filter_by(workflow_id=wid)
        .order_by(models.Run.started_at.desc())
        .limit(20)
        .all()
    )
    return [_run_to_out(r, r.node_runs) for r in rows]


@router.websocket("/runs/{rid}/events")
async def ws_run_events(websocket: WebSocket, rid: str):
    """Stream per-run events (backlog + live tail) until the run finishes."""
    await websocket.accept()
    try:
        async for event in ev_mod.subscribe(rid):
            await websocket.send_json(event)
    except WebSocketDisconnect:
        return
    except Exception:
        return
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
