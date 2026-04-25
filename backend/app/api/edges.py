from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app import models, schemas
from app.api.workflows import to_edge_out

router = APIRouter(prefix="/api", tags=["edges"])


@router.post("/workflows/{wid}/edges", response_model=schemas.EdgeOut)
def create_edge(wid: str, body: schemas.EdgeIn, db: Session = Depends(get_db)):
    if not db.get(models.Workflow, wid):
        raise HTTPException(404)
    e = models.Edge(
        workflow_id=wid,
        from_node_id=body.from_node_id,
        from_output=body.from_output,
        to_node_id=body.to_node_id,
        to_input=body.to_input,
    )
    db.add(e)
    db.commit()
    db.refresh(e)
    return to_edge_out(e)


@router.delete("/edges/{eid}")
def delete_edge(eid: str, db: Session = Depends(get_db)):
    e = db.get(models.Edge, eid)
    if not e:
        raise HTTPException(404)
    db.delete(e)
    db.commit()
    return {"ok": True}
