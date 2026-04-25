"""Workflow runner.

`run_workflow_streaming` spawns a child Python process and pipes its JSON-line
events through `app.runner.events.append_event`, which fans them out to any
WebSocket subscribers and accumulates a backlog. `run_workflow_sync` is a
compat wrapper that runs streaming to completion and then materializes the
legacy result shape — used by tests and any other sync caller.
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
import tempfile
import uuid
from collections import defaultdict, deque
from typing import Any

from app.runner import events as ev_mod


def topo_sort(nodes: list[dict], edges: list[dict]) -> list[str]:
    indeg: dict[str, int] = defaultdict(int)
    adj: dict[str, list[str]] = defaultdict(list)
    node_ids = {n["id"] for n in nodes}
    for nid in node_ids:
        indeg[nid] = 0
    for e in edges:
        if e["from_node_id"] in node_ids and e["to_node_id"] in node_ids:
            adj[e["from_node_id"]].append(e["to_node_id"])
            indeg[e["to_node_id"]] += 1
    q = deque([nid for nid in node_ids if indeg[nid] == 0])
    out: list[str] = []
    while q:
        nid = q.popleft()
        out.append(nid)
        for m in adj[nid]:
            indeg[m] -= 1
            if indeg[m] == 0:
                q.append(m)
    if len(out) != len(node_ids):
        raise ValueError("workflow has a cycle")
    return out


def run_workflow_streaming(
    run_id: str,
    workflow: dict,
    inputs: dict[str, Any],
    default_model: str = "",
) -> None:
    """Run a workflow in a child subprocess. Blocks until the child exits.

    Each JSON-line event the child writes to stdout is appended via
    `events.append_event(run_id, ...)`. If the child exits without emitting a
    `run_finished` event (e.g. it crashed or was killed), a synthetic one is
    appended so subscribers always observe a terminal event.
    """
    workdir = tempfile.mkdtemp(prefix="wfrun-")
    payload = {
        "workflow": workflow,
        "inputs": inputs,
        "default_model": default_model,
        "workdir": workdir,
        "env": {
            "OPENROUTER_API_KEY": os.getenv("OPENROUTER_API_KEY", ""),
            "PARALLEL_API_KEY": os.getenv("PARALLEL_API_KEY", ""),
        },
    }

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"

    try:
        proc = subprocess.Popen(
            [sys.executable, "-m", "app.runner.child"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
    except Exception as e:
        ev_mod.append_event(
            run_id,
            {
                "type": "run_finished",
                "status": "error",
                "error": f"failed to spawn runner: {e}",
                "outputs": {},
                "total_cost": 0.0,
            },
        )
        return

    ev_mod.set_proc(run_id, proc)

    try:
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(payload).encode())
        proc.stdin.close()
    except Exception as e:
        ev_mod.append_event(
            run_id,
            {
                "type": "run_finished",
                "status": "error",
                "error": f"failed to write to runner stdin: {e}",
                "outputs": {},
                "total_cost": 0.0,
            },
        )
        try:
            proc.kill()
        except Exception:
            pass
        return

    saw_finished = False
    assert proc.stdout is not None
    for raw in proc.stdout:
        line = raw.decode(errors="replace").strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue
        ev_mod.append_event(run_id, event)
        if event.get("type") == "run_finished":
            saw_finished = True

    rc = proc.wait()

    if not saw_finished:
        stderr_text = ""
        try:
            if proc.stderr is not None:
                stderr_text = proc.stderr.read().decode(errors="replace")
        except Exception:
            pass
        st = ev_mod.get(run_id)
        cancelled = bool(st and st.cancelled)
        if cancelled or rc < 0:
            ev_mod.append_event(
                run_id,
                {
                    "type": "run_finished",
                    "status": "cancelled",
                    "error": "cancelled by user" if cancelled else f"runner killed (rc={rc})",
                    "outputs": {},
                    "total_cost": 0.0,
                },
            )
        else:
            ev_mod.append_event(
                run_id,
                {
                    "type": "run_finished",
                    "status": "error",
                    "error": f"runner exited rc={rc}: {stderr_text[-1000:]}",
                    "outputs": {},
                    "total_cost": 0.0,
                },
            )


def run_workflow_sync(
    workflow: dict,
    inputs: dict[str, Any],
    default_model: str = "",
) -> dict:
    """Compat wrapper. Runs a workflow to completion and materializes the
    legacy result shape: `{status, error, outputs, node_runs, total_cost}`."""
    run_id = "sync-" + uuid.uuid4().hex[:8]
    run_workflow_streaming(run_id, workflow, inputs, default_model)
    return materialize_run_result(run_id)


def materialize_run_result(run_id: str) -> dict:
    """Aggregate streamed events for a finished run into the legacy result dict."""
    st = ev_mod.get(run_id)
    if not st:
        return {
            "status": "error",
            "error": "no run state",
            "outputs": {},
            "node_runs": [],
            "total_cost": 0.0,
        }

    status = "error"
    error: str | None = None
    outputs: dict = {}
    total_cost = 0.0
    node_runs: list[dict] = []

    for ev in st.events:
        t = ev.get("type")
        if t == "node_finished":
            node_runs.append({k: v for k, v in ev.items() if k != "type"})
        elif t == "run_finished":
            status = ev.get("status", "error")
            error = ev.get("error")
            outputs = ev.get("outputs", {}) or {}
            total_cost = float(ev.get("total_cost", 0.0) or 0.0)

    return {
        "status": status,
        "error": error,
        "outputs": outputs,
        "node_runs": node_runs,
        "total_cost": total_cost,
    }
