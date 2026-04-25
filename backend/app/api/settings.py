from __future__ import annotations
import os
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app import models

router = APIRouter(prefix="/api/settings", tags=["settings"])

SECRET_KEYS = {"openrouter_api_key", "parallel_api_key"}
MODEL_KEYS = {"default_orchestrator_model", "default_node_model"}
ALL_KEYS = SECRET_KEYS | MODEL_KEYS


class SettingsBody(BaseModel):
    openrouter_api_key: str = ""
    parallel_api_key: str = ""
    default_orchestrator_model: str = ""
    default_node_model: str = ""


def _mask(v: str) -> str:
    if not v:
        return ""
    if len(v) < 8:
        return "***"
    return v[:4] + "..." + v[-4:]


def _read_settings(db: Session) -> dict:
    out = {k: "" for k in ALL_KEYS}
    for s in db.query(models.Setting).all():
        if s.key in ALL_KEYS:
            out[s.key] = s.value or ""
    return out


def apply_settings_to_env(db: Session) -> None:
    raw = _read_settings(db)
    if raw["openrouter_api_key"]:
        os.environ["OPENROUTER_API_KEY"] = raw["openrouter_api_key"]
    if raw["parallel_api_key"]:
        os.environ["PARALLEL_API_KEY"] = raw["parallel_api_key"]


@router.get("", response_model=SettingsBody)
def get_settings(db: Session = Depends(get_db)) -> SettingsBody:
    raw = _read_settings(db)
    return SettingsBody(
        openrouter_api_key=_mask(raw["openrouter_api_key"]),
        parallel_api_key=_mask(raw["parallel_api_key"]),
        default_orchestrator_model=raw["default_orchestrator_model"],
        default_node_model=raw["default_node_model"],
    )


@router.put("", response_model=SettingsBody)
def put_settings(body: SettingsBody, db: Session = Depends(get_db)) -> SettingsBody:
    data = body.model_dump()
    for k in ALL_KEYS:
        v = data.get(k, "") or ""
        # Preserve existing secret if the value looks like a mask.
        if k in SECRET_KEYS and v.startswith("***"):
            continue
        s = db.query(models.Setting).filter_by(key=k).first()
        if s:
            s.value = v
        else:
            db.add(models.Setting(key=k, value=v))
    db.commit()
    apply_settings_to_env(db)
    return get_settings(db)
