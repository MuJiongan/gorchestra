from __future__ import annotations
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app import models, schemas
from app.api.workflows import to_node_out

router = APIRouter(prefix="/api", tags=["nodes"])


@router.post("/workflows/{wid}/nodes", response_model=schemas.NodeOut)
def create_node(wid: str, body: schemas.NodeIn, db: Session = Depends(get_db)):
    if not db.get(models.Workflow, wid):
        raise HTTPException(404)
    n = models.Node(
        workflow_id=wid,
        name=body.name,
        description=body.description,
        code=body.code,
        inputs=[p.model_dump() for p in body.inputs],
        outputs=[p.model_dump() for p in body.outputs],
        config=body.config.model_dump(),
        position=body.position.model_dump(),
    )
    db.add(n)
    db.commit()
    db.refresh(n)
    return to_node_out(n)


@router.patch("/nodes/{nid}", response_model=schemas.NodeOut)
def patch_node(nid: str, body: schemas.NodePatch, db: Session = Depends(get_db)):
    n = db.get(models.Node, nid)
    if not n:
        raise HTTPException(404)
    if body.name is not None:
        n.name = body.name
    if body.description is not None:
        n.description = body.description
    if body.code is not None:
        n.code = body.code
    if body.inputs is not None:
        n.inputs = [p.model_dump() for p in body.inputs]
    if body.outputs is not None:
        n.outputs = [p.model_dump() for p in body.outputs]
    if body.config is not None:
        n.config = body.config.model_dump()
    if body.position is not None:
        n.position = body.position.model_dump()
    if body.mark_user_edited:
        n.user_edited_at = datetime.utcnow()
    db.commit()
    db.refresh(n)
    return to_node_out(n)


@router.delete("/nodes/{nid}")
def delete_node(nid: str, db: Session = Depends(get_db)):
    n = db.get(models.Node, nid)
    if not n:
        raise HTTPException(404)
    db.query(models.Edge).filter(
        (models.Edge.from_node_id == nid) | (models.Edge.to_node_id == nid)
    ).delete(synchronize_session=False)
    # Clear input/output pointers if they referenced this node.
    w = db.get(models.Workflow, n.workflow_id)
    if w:
        if w.input_node_id == nid:
            w.input_node_id = None
        if w.output_node_id == nid:
            w.output_node_id = None
    db.delete(n)
    db.commit()
    return {"ok": True}
