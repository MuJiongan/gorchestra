"""Orchestrator tool surface — graph mutators the LLM can call.

Each function takes (db, workflow_id, **args) and either returns a JSON-serialisable
dict (the tool result the LLM sees) or raises a ValueError on bad input. The
agent loop catches errors and returns them as `{"error": ...}` results so the
LLM can self-correct.
"""
from __future__ import annotations
import math
from typing import Any

from sqlalchemy.orm import Session as DbSession

from app import models, schemas


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _get_workflow(db: DbSession, wid: str) -> models.Workflow:
    w = db.get(models.Workflow, wid)
    if not w:
        raise ValueError(f"workflow {wid} not found")
    return w


def _get_node(db: DbSession, wid: str, node_id: str) -> models.Node:
    n = db.get(models.Node, node_id)
    if not n or n.workflow_id != wid:
        raise ValueError(f"node {node_id} not found in workflow {wid}")
    return n


def _normalize_ports(ports: list[Any] | None, kind: str) -> list[dict]:
    """Coerce an LLM-supplied list of port dicts into IOPort shape."""
    out: list[dict] = []
    for p in (ports or []):
        if not isinstance(p, dict):
            raise ValueError(f"{kind} entry must be an object, got {type(p).__name__}")
        name = p.get("name")
        if not name or not isinstance(name, str):
            raise ValueError(f"{kind} entry missing 'name'")
        out.append(
            {
                "name": name,
                "type_hint": p.get("type_hint", "any") or "any",
                "required": bool(p.get("required", kind == "input")),
            }
        )
    return out


def _next_position(db: DbSession, wid: str) -> dict:
    existing = db.query(models.Node).filter_by(workflow_id=wid).all()
    n = len(existing)
    # Lay out nodes left-to-right in a gentle wave so the orchestrator's
    # auto-built graphs aren't a pile.
    x = 60 + (n % 4) * 280
    y = 60 + (n // 4) * 200 + int(math.sin(n) * 24)
    return {"x": float(x), "y": float(y)}


def _node_summary(n: models.Node) -> dict:
    return {
        "id": n.id,
        "name": n.name,
        "description": n.description or "",
        "inputs": n.inputs or [],
        "outputs": n.outputs or [],
        "config": n.config or {},
    }


def _node_full(n: models.Node) -> dict:
    """Full node payload — used by view_node_details. No truncation."""
    cfg = n.config or {}
    return {
        "id": n.id,
        "name": n.name,
        "description": n.description or "",
        "code": n.code or "",
        "inputs": n.inputs or [],
        "outputs": n.outputs or [],
        "config": {
            "model": cfg.get("model", ""),
        },
        "position": n.position or {"x": 0, "y": 0},
        "user_edited": n.user_edited_at is not None,
        "user_edited_at": n.user_edited_at.isoformat() if n.user_edited_at else None,
    }


def _edge_summary(e: models.Edge) -> dict:
    return {
        "id": e.id,
        "from_node_id": e.from_node_id,
        "from_output": e.from_output,
        "to_node_id": e.to_node_id,
        "to_input": e.to_input,
    }


# ---------------------------------------------------------------------------
# tool implementations
# ---------------------------------------------------------------------------


def add_node(
    db: DbSession,
    wid: str,
    *,
    name: str,
    description: str = "",
    code: str = schemas.DEFAULT_CODE,
    inputs: list[dict] | None = None,
    outputs: list[dict] | None = None,
    model: str = "",
) -> dict:
    """Create a new node in the workflow. Returns the new node id + summary."""
    _get_workflow(db, wid)
    n = models.Node(
        workflow_id=wid,
        name=name,
        description=description or "",
        code=code or schemas.DEFAULT_CODE,
        inputs=_normalize_ports(inputs, "input"),
        outputs=_normalize_ports(outputs, "output"),
        config={
            "model": model or "",
        },
        position=_next_position(db, wid),
    )
    db.add(n)
    db.commit()
    db.refresh(n)
    return {"node_id": n.id, "node": _node_summary(n)}


def remove_node(db: DbSession, wid: str, *, node_id: str) -> dict:
    n = _get_node(db, wid, node_id)
    # Cascade: remove edges touching this node and clear in/out pointers.
    db.query(models.Edge).filter(
        (models.Edge.from_node_id == node_id) | (models.Edge.to_node_id == node_id)
    ).delete(synchronize_session=False)
    w = _get_workflow(db, wid)
    if w.input_node_id == node_id:
        w.input_node_id = None
    if w.output_node_id == node_id:
        w.output_node_id = None
    db.delete(n)
    db.commit()
    return {"removed_node_id": node_id}


def rename_node(db: DbSession, wid: str, *, node_id: str, new_name: str) -> dict:
    if not new_name:
        raise ValueError("new_name must be non-empty")
    n = _get_node(db, wid, node_id)
    n.name = new_name
    db.commit()
    return {"node_id": node_id, "name": new_name}


def configure_node(
    db: DbSession,
    wid: str,
    *,
    node_id: str,
    description: str | None = None,
    code: str | None = None,
    inputs: list[dict] | None = None,
    outputs: list[dict] | None = None,
    model: str | None = None,
) -> dict:
    """Patch any subset of a node's mutable fields."""
    n = _get_node(db, wid, node_id)
    if description is not None:
        n.description = description
    if code is not None:
        n.code = code
    if inputs is not None:
        n.inputs = _normalize_ports(inputs, "input")
    if outputs is not None:
        n.outputs = _normalize_ports(outputs, "output")
    cfg = dict(n.config or {})
    if model is not None:
        cfg["model"] = model
    # Drop legacy fields that no longer mean anything so we don't carry
    # them forward on existing rows.
    cfg.pop("timeout_s", None)
    cfg.pop("tools_enabled", None)
    n.config = cfg
    db.commit()
    db.refresh(n)
    return {"node_id": node_id, "node": _node_summary(n)}


def add_edge(
    db: DbSession,
    wid: str,
    *,
    from_node_id: str,
    from_output: str,
    to_node_id: str,
    to_input: str,
) -> dict:
    """Connect one node's output to another node's input. Validates the ports
    exist on each side."""
    src = _get_node(db, wid, from_node_id)
    dst = _get_node(db, wid, to_node_id)
    src_out_names = [p.get("name") for p in (src.outputs or [])]
    dst_in_names = [p.get("name") for p in (dst.inputs or [])]
    if from_output not in src_out_names:
        raise ValueError(
            f"node {src.name!r} has no output named {from_output!r} (available: {src_out_names})"
        )
    if to_input not in dst_in_names:
        raise ValueError(
            f"node {dst.name!r} has no input named {to_input!r} (available: {dst_in_names})"
        )
    e = models.Edge(
        workflow_id=wid,
        from_node_id=from_node_id,
        from_output=from_output,
        to_node_id=to_node_id,
        to_input=to_input,
    )
    db.add(e)
    db.commit()
    db.refresh(e)
    return {"edge_id": e.id, "edge": _edge_summary(e)}


def remove_edge(db: DbSession, wid: str, *, edge_id: str) -> dict:
    e = db.get(models.Edge, edge_id)
    if not e or e.workflow_id != wid:
        raise ValueError(f"edge {edge_id} not found in workflow {wid}")
    db.delete(e)
    db.commit()
    return {"removed_edge_id": edge_id}


def clean_canvas(db: DbSession, wid: str) -> dict:
    """Wipe the workflow's graph: delete every node + edge and clear the
    input/output node pointers. The Workflow row itself stays (so the
    orchestrator session, runs, and run history are preserved).

    A session often spans multiple distinct workflows in sequence — e.g. a
    scoping workflow, then a solve workflow informed by what it found, then
    maybe a verify workflow. `clean_canvas` is the *transition* between
    stages: clear the canvas, build the next stage's graph, run it.
    """
    w = _get_workflow(db, wid)
    n_edges = db.query(models.Edge).filter_by(workflow_id=wid).delete(synchronize_session=False)
    n_nodes = db.query(models.Node).filter_by(workflow_id=wid).delete(synchronize_session=False)
    w.input_node_id = None
    w.output_node_id = None
    db.commit()
    return {"cleared": True, "removed_nodes": int(n_nodes), "removed_edges": int(n_edges)}


def set_input_node(db: DbSession, wid: str, *, node_id: str) -> dict:
    n = _get_node(db, wid, node_id)
    w = _get_workflow(db, wid)
    w.input_node_id = n.id
    db.commit()
    return {"input_node_id": n.id}


def set_output_node(db: DbSession, wid: str, *, node_id: str) -> dict:
    n = _get_node(db, wid, node_id)
    w = _get_workflow(db, wid)
    w.output_node_id = n.id
    db.commit()
    return {"output_node_id": n.id}


# ---------------------------------------------------------------------------
# read-only inspection tools
# ---------------------------------------------------------------------------


def view_graph(db: DbSession, wid: str) -> dict:
    """Return a structural snapshot of the workflow — node ids, names,
    descriptions, ports, model, user_edited. Code is intentionally
    omitted; call `view_node_details` for the full body of a specific node."""
    w = _get_workflow(db, wid)
    nodes = []
    for n in w.nodes:
        cfg = n.config or {}
        nodes.append(
            {
                "id": n.id,
                "name": n.name,
                "description": n.description or "",
                "inputs": n.inputs or [],
                "outputs": n.outputs or [],
                "model": cfg.get("model", ""),
                "user_edited": n.user_edited_at is not None,
            }
        )
    edges = [_edge_summary(e) for e in w.edges]
    return {
        "workflow_id": w.id,
        "name": w.name,
        "input_node_id": w.input_node_id,
        "output_node_id": w.output_node_id,
        "nodes": nodes,
        "edges": edges,
    }


def view_node_details(db: DbSession, wid: str, *, node_id: str) -> dict:
    """Return the full record for a node — including untruncated code, full
    config, position, and user_edited timestamp."""
    n = _get_node(db, wid, node_id)
    return _node_full(n)


# ---------------------------------------------------------------------------
# run trigger — kicks off a workflow run with explicit inputs and returns
# immediately with `{run_id, status: "running"}`. The agent loop detects
# this shape, emits a `run_started` chat event so the frontend can attach
# its run panel to the live WS, then waits via `wait_for_run` for the
# materialised final result before letting the LLM see it.
# ---------------------------------------------------------------------------


def run_workflow(
    db: DbSession,
    wid: str,
    *,
    inputs: dict | None = None,
) -> dict:
    """Kick off a workflow run with the given inputs in a background thread
    and return immediately with ``{run_id, status: "running"}``. The agent
    loop turns this into a ``run_started`` chat event (so the run panel
    can attach to the WS), waits for completion via :func:`wait_for_run`,
    and replaces this stub with the materialised result before the LLM
    sees a tool result.
    """
    # Lazy imports to avoid a load-time cycle between the orchestrator package
    # and the api routers.
    import threading
    from app.api.runs import _serialize_workflow, _execute_run
    from app.runner import events as ev_mod

    w = _get_workflow(db, wid)

    if not w.input_node_id:
        return {"error": "workflow has no input node — designate one with set_input_node first"}
    if not w.output_node_id:
        return {"error": "workflow has no output node — designate one with set_output_node first"}

    # Refuse to start a second run while one is in flight for this workflow.
    active = _active_run_id(db, wid)
    if active is not None:
        return {"error": f"another run ({active}) is already in progress for this workflow; wait for it to finish or cancel it"}

    inputs = inputs or {}
    input_node = db.get(models.Node, w.input_node_id)
    if input_node is None:
        return {"error": f"input node {w.input_node_id} not found"}
    declared_names = {p.get("name") for p in (input_node.inputs or [])}
    required_names = {p.get("name") for p in (input_node.inputs or []) if p.get("required")}
    missing = sorted(required_names - set(inputs.keys()))
    if missing:
        return {"error": f"missing required inputs on {input_node.name!r}: {missing}"}
    extra = sorted(set(inputs.keys()) - declared_names)
    if extra:
        return {"error": f"unknown inputs for {input_node.name!r}: {extra} (declared: {sorted(declared_names)})"}

    # Resolve the default node model, mirroring the API's lookup so behaviour
    # is identical whether a run is triggered via REST or via the orchestrator.
    import os as _os
    default_model = _os.getenv("DEFAULT_NODE_MODEL", "")
    if not default_model:
        setting = db.query(models.Setting).filter_by(key="default_node_model").first()
        default_model = setting.value if setting and setting.value else ""
    if not default_model:
        default_model = "anthropic/claude-sonnet-4.6"

    wf_data = _serialize_workflow(w)

    run = models.Run(
        workflow_id=wid,
        kind="user",
        status="running",
        inputs=inputs,
        workflow_snapshot=wf_data,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    run_id = run.id

    # Pre-create the run state so any WS subscriber that connects mid-run
    # doesn't race the first event.
    ev_mod.get_or_create(run_id)

    # Spawn the run in a daemon thread — same pattern the REST endpoint uses.
    # The agent loop will yield a `run_started` chat event with this run_id
    # (so the frontend can attach), then call `wait_for_run` to block on
    # completion before returning the final result to the LLM.
    threading.Thread(
        target=_execute_run,
        args=(run_id, wf_data, inputs, default_model),
        daemon=True,
    ).start()

    return {"run_id": run_id, "status": "running"}


def _materialise_run(
    db: DbSession,
    wid: str,
    run_id: str,
    *,
    full: bool = False,
) -> dict:
    """Read a run's current state from the DB into a result dict. Works for
    any status — running, success, error, cancelled — so this is shared
    between the post-completion read in :func:`wait_for_run` and the
    on-demand inspection in :func:`view_run`.

    When ``full=False`` (the default, used by ``run_workflow``), only
    ``{run_id, status, total_cost}`` is returned — the user inspects the
    actual outputs in the run panel; the orchestrator doesn't relay them.
    When ``full=True`` (used by ``view_run``), the full state is returned —
    ``outputs``, ``node_errors``, and the top-level ``error`` field — so the
    orchestrator can drill in on failure paths or answer follow-up
    questions about a specific run."""
    import time
    from app.runner import events as ev_mod

    db.expire_all()
    run = db.get(models.Run, run_id)
    if run is None or run.workflow_id != wid:
        return {"error": f"run {run_id} not found in workflow {wid}"}

    # Persist race: the runner appends `run_finished` (which sets
    # `finished_event`) *before* `_execute_run` materialises and commits the
    # final state to the DB. If the orchestrator calls `view_run` right
    # after `run_workflow` returns on a fast run, we can land here while
    # the in-memory stream says finished but the row still says "running".
    # Briefly poll for the persist to catch up (bounded; we'd rather return
    # stale than hang).
    st = ev_mod.get(run_id)
    if st is not None and st.finished and run.status == "running":
        for _ in range(50):  # up to ~5s
            time.sleep(0.1)
            db.expire_all()
            run = db.get(models.Run, run_id)
            if run is None or run.status != "running":
                break

    if run is None:
        return {"error": f"run {run_id} produced no result row"}

    if not full:
        return {
            "run_id": run_id,
            "status": run.status,
            "total_cost": run.total_cost or 0.0,
        }

    node_names = {n.id: n.name for n in _get_workflow(db, wid).nodes}
    node_errors: list[dict] = []
    for nr in run.node_runs or []:
        if nr.status == "error":
            node_errors.append(
                {
                    "node_id": nr.node_id,
                    "node_name": node_names.get(nr.node_id, nr.node_id),
                    "error": nr.error or "unknown error",
                }
            )
    return {
        "run_id": run_id,
        "status": run.status,
        "outputs": run.outputs or {},
        "node_errors": node_errors,
        "error": run.error,
        "total_cost": run.total_cost or 0.0,
    }


def wait_for_run(
    db: DbSession,
    wid: str,
    run_id: str,
    *,
    cancel_event: Any = None,
    poll_interval: float = 0.1,
) -> dict:
    """Block until the given run finishes, then return the lean
    ``{run_id, status, total_cost}`` shape ``run_workflow`` exposes to the LLM.

    Reads the terminal state from the in-memory event stream — *not* the DB.
    The runner's ``finished_event`` fires the instant ``run_finished`` is
    appended to the event log, but ``_execute_run`` persists to the DB
    *after* that, in a background thread. Querying the DB on this edge
    returns the stale ``status="running"`` row that ``run_workflow`` created
    at the top, which is exactly the race we hit before this fix. The
    materialised event stream is authoritative — that's what the run panel
    renders too.

    If ``cancel_event`` is provided and gets set, returns early with a
    cancellation result; the run keeps executing in the background.
    """
    from app.runner import events as ev_mod
    from app.runner.runner import materialize_run_result

    run = db.get(models.Run, run_id)
    if run is None or run.workflow_id != wid:
        return {"error": f"run {run_id} not found in workflow {wid}"}

    st = ev_mod.get_or_create(run_id)
    while not st.finished:
        if cancel_event is not None and cancel_event.is_set():
            return {
                "run_id": run_id,
                "status": "running",
                "error": "orchestrator turn cancelled while waiting; run is still in progress",
            }
        st.finished_event.wait(timeout=poll_interval)

    result = materialize_run_result(run_id)
    return {
        "run_id": run_id,
        "status": result.get("status") or "error",
        "total_cost": float(result.get("total_cost") or 0.0),
    }


def view_run(db: DbSession, wid: str, *, run_id: str) -> dict:
    """Return a run's full current state from the DB: ``{run_id, status,
    outputs, node_errors, error, total_cost}``. Use this on the error/cancelled
    paths where ``run_workflow`` deliberately omits details, on a run that
    was interrupted (e.g. the orchestrator turn was cancelled while waiting),
    or to answer follow-up questions about a specific run."""
    return _materialise_run(db, wid, run_id, full=True)


# ---------------------------------------------------------------------------
# registry + LLM tool schemas
# ---------------------------------------------------------------------------


REGISTRY = {
    "view_graph": view_graph,
    "view_node_details": view_node_details,
    "add_node": add_node,
    "remove_node": remove_node,
    "rename_node": rename_node,
    "configure_node": configure_node,
    "add_edge": add_edge,
    "remove_edge": remove_edge,
    "set_input_node": set_input_node,
    "set_output_node": set_output_node,
    "clean_canvas": clean_canvas,
    "run_workflow": run_workflow,
    "view_run": view_run,
}


# Tools that don't mutate the workflow graph — exempt from the dispatcher's
# run-in-progress lock (which only blocks graph mutation). Includes the
# read-only inspection tools and `run_workflow` itself — `run_workflow` does
# its own active-run check internally with a clearer error message than the
# generic "cannot mutate the graph" guard.
NON_GRAPH_MUTATING_TOOLS: set[str] = {
    "view_graph",
    "view_node_details",
    "view_run",
    "run_workflow",
}


_PORT_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "type_hint": {"type": "string", "description": "human-readable type label, e.g. 'list[path]', 'dict', 'string'"},
            "required": {"type": "boolean", "description": "input only — whether this input must be non-None for the node to run"},
        },
        "required": ["name"],
    },
}


TOOL_SCHEMAS: dict[str, dict] = {
    "view_graph": {
        "type": "function",
        "function": {
            "name": "view_graph",
            "description": (
                "Return a structural snapshot of the workflow — node ids, names, descriptions, "
                "ports, model, user_edited. Useful to confirm state mid-turn after "
                "a sequence of mutations, or to plan before editing. Does not include node code; "
                "use `view_node_details` for that."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    "view_node_details": {
        "type": "function",
        "function": {
            "name": "view_node_details",
            "description": (
                "Return the full record for one node — including its complete code, full config "
                "(model), and user_edited status. Call this before "
                "editing a node so you can make targeted patches instead of guessing at its "
                "current state, especially when `user_edited` is true."
            ),
            "parameters": {
                "type": "object",
                "properties": {"node_id": {"type": "string"}},
                "required": ["node_id"],
            },
        },
    },
    "add_node": {
        "type": "function",
        "function": {
            "name": "add_node",
            "description": (
                "Create a new node. The `code` is Python following the run(inputs, ctx) -> dict contract. "
                "Returns {node_id, node}."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "snake_case node name"},
                    "description": {"type": "string", "description": "one-line italic description for the canvas"},
                    "code": {
                        "type": "string",
                        "description": "Full Python source. Must define `def run(inputs, ctx) -> dict:`.",
                    },
                    "inputs": _PORT_SCHEMA,
                    "outputs": _PORT_SCHEMA,
                    "model": {"type": "string", "description": "OpenRouter model id (optional)"},
                },
                "required": ["name"],
            },
        },
    },
    "remove_node": {
        "type": "function",
        "function": {
            "name": "remove_node",
            "description": "Delete a node. Edges touching it are removed automatically.",
            "parameters": {
                "type": "object",
                "properties": {"node_id": {"type": "string"}},
                "required": ["node_id"],
            },
        },
    },
    "rename_node": {
        "type": "function",
        "function": {
            "name": "rename_node",
            "description": "Rename a node.",
            "parameters": {
                "type": "object",
                "properties": {
                    "node_id": {"type": "string"},
                    "new_name": {"type": "string"},
                },
                "required": ["node_id", "new_name"],
            },
        },
    },
    "configure_node": {
        "type": "function",
        "function": {
            "name": "configure_node",
            "description": (
                "Patch any subset of a node's fields (description, code, inputs, outputs, model). "
                "Omitted fields are left unchanged."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "node_id": {"type": "string"},
                    "description": {"type": "string"},
                    "code": {"type": "string"},
                    "inputs": _PORT_SCHEMA,
                    "outputs": _PORT_SCHEMA,
                    "model": {"type": "string"},
                },
                "required": ["node_id"],
            },
        },
    },
    "add_edge": {
        "type": "function",
        "function": {
            "name": "add_edge",
            "description": (
                "Connect one node's named output to another node's named input. Both ports must "
                "already exist."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "from_node_id": {"type": "string"},
                    "from_output": {"type": "string"},
                    "to_node_id": {"type": "string"},
                    "to_input": {"type": "string"},
                },
                "required": ["from_node_id", "from_output", "to_node_id", "to_input"],
            },
        },
    },
    "remove_edge": {
        "type": "function",
        "function": {
            "name": "remove_edge",
            "description": "Delete an edge by id.",
            "parameters": {
                "type": "object",
                "properties": {"edge_id": {"type": "string"}},
                "required": ["edge_id"],
            },
        },
    },
    "set_input_node": {
        "type": "function",
        "function": {
            "name": "set_input_node",
            "description": "Designate this node as the entry point of the workflow.",
            "parameters": {
                "type": "object",
                "properties": {"node_id": {"type": "string"}},
                "required": ["node_id"],
            },
        },
    },
    "set_output_node": {
        "type": "function",
        "function": {
            "name": "set_output_node",
            "description": "Designate this node as the workflow's terminal node.",
            "parameters": {
                "type": "object",
                "properties": {"node_id": {"type": "string"}},
                "required": ["node_id"],
            },
        },
    },
    "clean_canvas": {
        "type": "function",
        "function": {
            "name": "clean_canvas",
            "description": (
                "Wipe the workflow's graph — delete every node + edge and clear the "
                "input/output node pointers. The session, runs, and run history are "
                "preserved. A session can host a *sequence of distinct workflows* on "
                "the way to one answer — e.g. a scoping workflow, then a solve workflow "
                "built on what it found, then a verify workflow. `clean_canvas` is the "
                "transition between stages. For incremental refinements within the "
                "current stage, patch in place instead."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    "run_workflow": {
        "type": "function",
        "function": {
            "name": "run_workflow",
            "description": (
                "Trigger a workflow run with explicit inputs. The call returns once the run "
                "finishes — you wait, and the user sees live progress + the actual outputs in "
                "the run panel. Returns ONLY {run_id, status, total_cost} — outputs are not "
                "relayed back to you. The user is the audience for outputs; on success, point "
                "them at the run panel rather than summarising. Call only when you can "
                "confidently supply the input node's required inputs from the conversation; "
                "otherwise leave running to the user. Refuses if another run is already in "
                "flight for this workflow."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "inputs": {
                        "type": "object",
                        "description": (
                            "Map of input port name → value for the workflow's input node. "
                            "Keys must match the input node's declared input names. Every "
                            "port marked `required` must be present."
                        ),
                    },
                },
                "required": ["inputs"],
            },
        },
    },
    "view_run": {
        "type": "function",
        "function": {
            "name": "view_run",
            "description": (
                "Return a run's full state from the DB: {run_id, status, outputs, node_errors, "
                "error, total_cost}. *Default: don't call this.* Use it ONLY when you "
                "absolutely cannot proceed without the run's contents — diagnosing a failure "
                "(`status: \"error\"` or `\"cancelled\"`), reading a research node's findings "
                "before continuing the build, handing off between stages of a multi-workflow "
                "solve where the previous run's outputs are the input to designing the next "
                "graph, or checking on an interrupted run. On a successful end-user run, do "
                "NOT call this just to summarise — the user reads outputs in the run panel."
            ),
            "parameters": {
                "type": "object",
                "properties": {"run_id": {"type": "string"}},
                "required": ["run_id"],
            },
        },
    },
}


def llm_tool_specs() -> list[dict]:
    """Tool schemas in OpenRouter `tools` array shape."""
    return list(TOOL_SCHEMAS.values())


def _active_run_id(db: DbSession, wid: str) -> str | None:
    """Return the id of any in-flight run for this workflow, or None.

    Cross-references the DB with the live `events` registry so a stale
    `running` row from a crashed runner doesn't permanently block mutations.
    """
    from app.runner import events as ev_mod

    rows = (
        db.query(models.Run.id)
        .filter(
            models.Run.workflow_id == wid,
            models.Run.status.in_(["pending", "running"]),
        )
        .all()
    )
    for (rid,) in rows:
        st = ev_mod.get(rid)
        # If we have no in-memory state for it (process restart) OR the in-memory
        # state isn't finished yet, treat the run as active.
        if st is None or not st.finished:
            return rid
    return None


def execute(db: DbSession, wid: str, name: str, args: dict) -> dict:
    """Dispatch a tool call. Returns either the tool's result dict or
    {"error": "..."} on failure — never raises, so the agent loop can keep
    going and let the LLM self-correct."""
    fn = REGISTRY.get(name)
    if fn is None:
        return {"error": f"unknown tool {name!r}"}
    # Refuse graph *mutations* while a workflow run is executing — the runner
    # snapshots the graph at start, so mid-run mutations won't take effect for
    # the current run anyway, and they can leave the orchestrator's mental
    # model out of sync with the run that the user is watching. Read-only
    # inspection tools are always allowed.
    if name not in NON_GRAPH_MUTATING_TOOLS:
        active = _active_run_id(db, wid)
        if active is not None:
            return {
                "error": (
                    f"cannot mutate the graph: run {active} is in progress. "
                    "wait for it to finish (or cancel it) before changing nodes/edges."
                )
            }
    try:
        return fn(db, wid, **(args or {}))
    except TypeError as e:
        # bad arguments — surface to LLM as an error result
        db.rollback()
        return {"error": f"bad arguments to {name}: {e}"}
    except ValueError as e:
        db.rollback()
        return {"error": str(e)}
    except Exception as e:  # pragma: no cover — defensive
        db.rollback()
        return {"error": f"{type(e).__name__}: {e}"}
