"""Native-window launcher for gorchestra.

Spins up the FastAPI backend in a daemon thread on a free localhost port,
serves the built frontend (`frontend/dist/`) from the same origin, and opens
a pywebview window pointed at it. Closing the window kills any in-flight
runs (process groups) and exits.

Usage:
    cd frontend && npm run build           # one-time
    backend/.venv/bin/pip install pywebview
    backend/.venv/bin/python launcher.py
"""
from __future__ import annotations

import atexit
import os
import signal
import socket
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
DIST = ROOT / "frontend" / "dist"

# Pin the SQLite path so we don't depend on cwd (mirrors `make backend`,
# which runs from backend/ and produces backend/workflow_builder.db).
os.environ.setdefault("DATABASE_URL", f"sqlite:///{BACKEND / 'workflow_builder.db'}")

sys.path.insert(0, str(BACKEND))

if not DIST.exists():
    sys.stderr.write(
        f"Frontend not built: {DIST} missing.\n"
        "Run: cd frontend && npm run build\n"
    )
    sys.exit(1)

try:
    import webview  # type: ignore
except ImportError:
    sys.stderr.write(
        "pywebview not installed.\n"
        "Run: backend/.venv/bin/pip install pywebview\n"
    )
    sys.exit(1)

import uvicorn
from fastapi.responses import FileResponse

from app.main import app
from app.runner import events as ev_mod


# SPA mount: serve dist files when they exist, fall back to index.html for
# any other path so client-side state-driven routing keeps working.
# Registered AFTER app.main has already included all /api/* routers, so
# those still match first.
@app.get("/{full_path:path}", include_in_schema=False)
def _spa(full_path: str):
    target = DIST / full_path
    if full_path and target.is_file():
        return FileResponse(target)
    return FileResponse(DIST / "index.html")


# Pinned port keeps localStorage stable across launches (origin = scheme+host+port,
# so a shifting port would orphan saved API keys / settings every relaunch).
# Falls back to an ephemeral port only if 8765 is in use.
PREFERRED_PORT = 8765


def _pick_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", PREFERRED_PORT))
        return PREFERRED_PORT
    except OSError:
        s.close()
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        sys.stderr.write(
            f"port {PREFERRED_PORT} in use, using {port} "
            "(saved settings won't carry over from previous launches)\n"
        )
        return port
    finally:
        s.close()


PORT = _pick_port()
_server = uvicorn.Server(
    uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning")
)


def _serve() -> None:
    _server.run()


def _wait_until_up(timeout_s: float = 5.0) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=0.1):
                return
        except OSError:
            time.sleep(0.05)


def _kill_active_runs() -> None:
    for st in list(ev_mod._RUNS.values()):
        proc = st.proc
        if not proc or proc.poll() is not None:
            continue
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.terminate()
            except Exception:
                pass


def _shutdown() -> None:
    _kill_active_runs()
    _server.should_exit = True


atexit.register(_shutdown)

threading.Thread(target=_serve, daemon=True).start()
_wait_until_up()

window = webview.create_window(
    "gorchestra",
    f"http://127.0.0.1:{PORT}",
    width=1400,
    height=900,
    min_size=(900, 600),
)
window.events.closing += _shutdown
# private_mode=False makes pywebview keep WKWebView's default data store
# instead of wiping it on startup, so localStorage (API keys, default
# models) survives across launches.
#
# On macOS, `storage_path` is silently ignored — Cocoa always uses
# WKWebsiteDataStore.defaultDataStore(), which lives under
# ~/Library/WebKit/<host-bundle-id>/. The bundle ID differs depending on
# how you launch us:
#   - via gorchestra.app  → local.gorchestra        (Info.plist)
#   - via `python launcher.py` → org.python.python  (Homebrew Python.app)
# So pick one launch method and stick with it; settings won't carry across.
webview.start(private_mode=False)
