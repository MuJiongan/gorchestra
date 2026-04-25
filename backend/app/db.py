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


def init_db() -> None:
    from app import models  # noqa: F401  -- ensure models are registered

    Base.metadata.create_all(bind=engine)
    _ensure_columns()
