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
            "tools_enabled": cfg.get("tools_enabled", []),
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
    tools_enabled: list[str] | None = None,
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
            "tools_enabled": list(tools_enabled or []),
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
    tools_enabled: list[str] | None = None,
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
    if tools_enabled is not None:
        cfg["tools_enabled"] = list(tools_enabled)
    # Drop any legacy timeout_s from existing rows so we don't carry a
    # field that no longer means anything.
    cfg.pop("timeout_s", None)
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
    descriptions, ports, model, tools_enabled, user_edited. Code is intentionally
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
                "tools_enabled": cfg.get("tools_enabled", []),
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
}


# Tools that don't mutate the graph — exempt from the run-in-progress lock so
# the orchestrator can still inspect the graph while a workflow is executing.
READ_ONLY_TOOLS: set[str] = {"view_graph", "view_node_details"}


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
                "ports, model, tools_enabled, user_edited. Useful to confirm state mid-turn after "
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
                "(model, tools_enabled), and user_edited status. Call this before "
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
                    "tools_enabled": {
                        "type": "array",
                        "items": {"type": "string", "enum": ["shell", "fetch", "web_search"]},
                    },
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
                "Patch any subset of a node's fields (description, code, inputs, outputs, model, "
                "tools_enabled). Omitted fields are left unchanged."
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
                    "tools_enabled": {
                        "type": "array",
                        "items": {"type": "string", "enum": ["shell", "fetch", "web_search"]},
                    },
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
    if name not in READ_ONLY_TOOLS:
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
