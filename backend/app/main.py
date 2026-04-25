from __future__ import annotations
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.db import init_db, SessionLocal
from app.api import workflows, nodes, edges, runs, orchestrator
from app.api import settings as settings_api


# Map of inbound request header → process env var. Settings live client-side
# in localStorage; the frontend forwards them on every request and we apply
# them to the process env so existing call_llm / runner code keeps working.
_HEADER_TO_ENV = {
    "x-openrouter-key": "OPENROUTER_API_KEY",
    "x-parallel-key": "PARALLEL_API_KEY",
    "x-orchestrator-model": "DEFAULT_ORCHESTRATOR_MODEL",
    "x-node-model": "DEFAULT_NODE_MODEL",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    db = SessionLocal()
    try:
        # Backwards compat: if any settings happen to be in the DB from a
        # prior version, hydrate the env once at boot. The new frontend
        # source-of-truth is localStorage (sent as headers per-request).
        settings_api.apply_settings_to_env(db)
    finally:
        db.close()
    yield


app = FastAPI(title="Workflow Builder", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def apply_settings_headers(request: Request, call_next):
    """Copy localStorage-sourced settings headers into process env for the
    duration of this request. Single-user local app — no concurrent-user
    cross-contamination concerns."""
    for header, env in _HEADER_TO_ENV.items():
        value = request.headers.get(header)
        if value:
            os.environ[env] = value
    return await call_next(request)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


app.include_router(workflows.router)
app.include_router(nodes.router)
app.include_router(edges.router)
app.include_router(runs.router)
app.include_router(orchestrator.router)
app.include_router(settings_api.router)
