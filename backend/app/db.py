from __future__ import annotations
import os
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, declarative_base

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./workflow_builder.db")

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Tiny ad-hoc migrations: SQLAlchemy's create_all only adds *tables*, not new
# columns. For the small number of column additions we've made post-v0 we do
# `ALTER TABLE ADD COLUMN` directly. Idempotent — checked against PRAGMA.
_PENDING_COLUMNS: list[tuple[str, str, str]] = [
    # (table, column, type with default)
    ("messages", "reasoning_details", "JSON DEFAULT '[]'"),
]


def _ensure_columns() -> None:
    if not engine.url.drivername.startswith("sqlite"):
        return  # other backends would need a real migration tool
    with engine.connect() as conn:
        for table, column, type_def in _PENDING_COLUMNS:
            existing = {
                row[1]
                for row in conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
            }
            if column not in existing:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {type_def}"))
                conn.commit()


def _strip_legacy_node_config_keys() -> None:
    """One-shot cleanup: remove obsolete keys from `node.config` on every row.

    `tools_enabled` was an LLM tool allow-list that's been removed in favour
    of trusting whatever the node's Python code passes to `ctx.call_llm`.
    Old rows can still carry it; strip it on startup so the orchestrator
    and frontend never see stale data.
    """
    from app import models

    LEGACY_KEYS = ("tools_enabled",)
    with SessionLocal() as session:
        rows = session.query(models.Node).all()
        changed = False
        for n in rows:
            cfg = n.config or {}
            if any(k in cfg for k in LEGACY_KEYS):
                new_cfg = {k: v for k, v in cfg.items() if k not in LEGACY_KEYS}
                n.config = new_cfg
                changed = True
        if changed:
            session.commit()


def init_db() -> None:
    from app import models  # noqa: F401  -- ensure models are registered

    Base.metadata.create_all(bind=engine)
    _ensure_columns()
    _strip_legacy_node_config_keys()
