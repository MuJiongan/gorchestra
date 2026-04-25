"""In-memory pub/sub for run events.

The runner thread writes events; WebSocket handlers (and the sync `run_workflow_sync`
compat shim) read them. Subscribers get the existing backlog plus a live tail.
"""
from __future__ import annotations
import asyncio
import subprocess
import threading
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class RunState:
    run_id: str
    events: list[dict] = field(default_factory=list)
    subscribers: list = field(default_factory=list)  # list[(loop, asyncio.Queue)]
    proc: Optional[subprocess.Popen] = None
    finished: bool = False
    cancelled: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)
    finished_event: threading.Event = field(default_factory=threading.Event)


_RUNS: dict[str, RunState] = {}
_REGISTRY_LOCK = threading.Lock()


def get_or_create(run_id: str) -> RunState:
    with _REGISTRY_LOCK:
        st = _RUNS.get(run_id)
        if st is None:
            st = RunState(run_id=run_id)
            _RUNS[run_id] = st
        return st


def get(run_id: str) -> Optional[RunState]:
    return _RUNS.get(run_id)


def append_event(run_id: str, event: dict) -> None:
    """Thread-safe: append to the run's event list and notify any live subscribers."""
    st = get_or_create(run_id)
    with st.lock:
        st.events.append(event)
        if event.get("type") == "run_finished":
            st.finished = True
        subs = list(st.subscribers)
    for loop, q in subs:
        try:
            loop.call_soon_threadsafe(q.put_nowait, event)
        except Exception:
            pass
    if st.finished:
        st.finished_event.set()


def set_proc(run_id: str, proc: subprocess.Popen) -> None:
    st = get_or_create(run_id)
    with st.lock:
        st.proc = proc


def cancel(run_id: str) -> bool:
    """Best-effort: SIGTERM the run's subprocess. Returns True if a signal was sent."""
    st = _RUNS.get(run_id)
    if not st or st.finished:
        return False
    proc = st.proc
    if not proc or proc.poll() is not None:
        return False
    with st.lock:
        st.cancelled = True
    try:
        proc.terminate()
        return True
    except Exception:
        return False


async def subscribe(run_id: str):
    """Async generator yielding events for a run.

    Yields the existing backlog first, then live events. Returns when the run
    finishes (i.e. a `run_finished` event has been observed).
    """
    st = get_or_create(run_id)
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue()
    with st.lock:
        backlog = list(st.events)
        already_finished = st.finished
        st.subscribers.append((loop, q))
    try:
        for ev in backlog:
            yield ev
        if already_finished:
            return
        while True:
            ev = await q.get()
            yield ev
            if ev.get("type") == "run_finished":
                return
    finally:
        with st.lock:
            try:
                st.subscribers.remove((loop, q))
            except ValueError:
                pass
