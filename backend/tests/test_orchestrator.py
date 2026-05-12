"""Unit tests for the orchestrator tool surface. No API keys / no LLM calls."""
from __future__ import annotations
import json
import threading

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app import models
from app.api import workflows as workflow_api
from app.orchestrator import tools as orch_tools
from app.orchestrator import agent as orch_agent
from app.orchestrator.prompt import (
    SYSTEM_PROMPT,
    graph_state_message,
)
from app.runner import events as runner_events


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture()
def workflow(db):
    w = models.Workflow(name="test wf")
    db.add(w)
    db.commit()
    db.refresh(w)
    return w


def test_add_node_creates_with_normalized_ports(db, workflow):
    res = orch_tools.add_node(
        db,
        workflow.id,
        name="loader",
        description="loads stuff",
        inputs=[{"name": "folder", "type_hint": "path", "required": True}],
        outputs=[{"name": "files", "type_hint": "list[path]"}],
    )
    assert "node_id" in res
    n = db.get(models.Node, res["node_id"])
    assert n is not None
    assert n.name == "loader"
    assert n.inputs == [{"name": "folder", "type_hint": "path", "required": True}]
    # output's required defaults to False (since kind="output")
    assert n.outputs == [{"name": "files", "type_hint": "list[path]", "required": False}]
    # default config sane
    assert "tools_enabled" not in n.config
    assert "timeout_s" not in n.config


def test_add_node_always_starts_with_stub_code(db, workflow):
    """`add_node` is structure-only: code starts as the default stub and must
    be set via `configure_node`."""
    from app import schemas

    nid = orch_tools.add_node(db, workflow.id, name="x")["node_id"]
    n = db.get(models.Node, nid)
    assert n.code == schemas.DEFAULT_CODE


def test_add_node_rejects_code_kwarg(db, workflow):
    """`add_node` no longer accepts a `code` argument — code lives on
    `configure_node`. The dispatcher surfaces this as a bad-args error so the
    LLM can self-correct."""
    res = orch_tools.execute(
        db, workflow.id, "add_node",
        {"name": "x", "code": "def run(inputs, ctx):\n    return {'a': 1}\n"},
    )
    assert "error" in res
    assert "code" in res["error"]


def test_add_node_unknown_workflow_raises(db):
    with pytest.raises(ValueError):
        orch_tools.add_node(db, "nope", name="x")


def test_remove_node_cascades_edges_and_pointers(db, workflow):
    a = orch_tools.add_node(
        db, workflow.id, name="a",
        outputs=[{"name": "x"}],
    )["node_id"]
    b = orch_tools.add_node(
        db, workflow.id, name="b",
        inputs=[{"name": "y", "required": True}],
    )["node_id"]
    orch_tools.add_edge(
        db, workflow.id,
        from_node_id=a, from_output="x", to_node_id=b, to_input="y",
    )
    orch_tools.set_input_node(db, workflow.id, node_id=a)
    orch_tools.set_output_node(db, workflow.id, node_id=b)

    orch_tools.remove_node(db, workflow.id, node_id=a)

    db.refresh(workflow)
    assert workflow.input_node_id is None
    # edge should be gone
    assert db.query(models.Edge).count() == 0
    # b still exists
    assert db.get(models.Node, b) is not None


def test_add_edge_validates_ports(db, workflow):
    a = orch_tools.add_node(
        db, workflow.id, name="a",
        outputs=[{"name": "out1"}],
    )["node_id"]
    b = orch_tools.add_node(
        db, workflow.id, name="b",
        inputs=[{"name": "in1", "required": True}],
    )["node_id"]

    # Wrong output name
    with pytest.raises(ValueError, match="no output named"):
        orch_tools.add_edge(
            db, workflow.id,
            from_node_id=a, from_output="missing", to_node_id=b, to_input="in1",
        )

    # Wrong input name
    with pytest.raises(ValueError, match="no input named"):
        orch_tools.add_edge(
            db, workflow.id,
            from_node_id=a, from_output="out1", to_node_id=b, to_input="missing",
        )


def test_rename_and_configure_node(db, workflow):
    nid = orch_tools.add_node(
        db, workflow.id, name="old", description="old desc", model="",
    )["node_id"]
    orch_tools.rename_node(db, workflow.id, node_id=nid, new_name="new")
    orch_tools.configure_node(
        db, workflow.id,
        node_id=nid,
        description="patched",
        model="anthropic/claude-sonnet-4.5",
    )
    n = db.get(models.Node, nid)
    assert n.name == "new"
    assert n.description == "patched"
    assert n.config["model"] == "anthropic/claude-sonnet-4.5"
    assert "tools_enabled" not in n.config
    assert "timeout_s" not in n.config


def test_configure_node_partial_keeps_other_fields(db, workflow):
    nid = orch_tools.add_node(
        db, workflow.id, name="x",
        outputs=[{"name": "out1"}],
    )["node_id"]
    orch_tools.configure_node(db, workflow.id, node_id=nid, description="just this")
    n = db.get(models.Node, nid)
    assert n.description == "just this"
    # outputs untouched
    assert n.outputs == [{"name": "out1", "type_hint": "any", "required": False}]


def test_set_input_set_output(db, workflow):
    nid = orch_tools.add_node(db, workflow.id, name="x")["node_id"]
    orch_tools.set_input_node(db, workflow.id, node_id=nid)
    orch_tools.set_output_node(db, workflow.id, node_id=nid)
    db.refresh(workflow)
    assert workflow.input_node_id == nid
    assert workflow.output_node_id == nid


def test_execute_returns_error_for_unknown_tool(db, workflow):
    res = orch_tools.execute(db, workflow.id, "nope", {})
    assert "error" in res
    assert "unknown" in res["error"]


def test_execute_returns_error_for_bad_args(db, workflow):
    # missing required `name`
    res = orch_tools.execute(db, workflow.id, "add_node", {})
    assert "error" in res


def test_execute_returns_error_for_bad_workflow(db):
    res = orch_tools.execute(db, "nope-wid", "add_node", {"name": "x"})
    assert "error" in res
    assert "not found" in res["error"]


def test_graph_state_message_contains_current_state(db, workflow):
    nid = orch_tools.add_node(
        db, workflow.id, name="loader", outputs=[{"name": "files"}],
    )["node_id"]
    orch_tools.set_input_node(db, workflow.id, node_id=nid)

    msg = graph_state_message(db, workflow.id)
    assert msg["role"] == "system"
    # parse out the JSON portion
    payload = msg["content"].split("\n", 1)[1]
    state = json.loads(payload)
    assert state["input_node_id"] == nid
    assert any(n["name"] == "loader" for n in state["nodes"])


def test_render_history_collapses_assistant_with_tool_cards(db, workflow):
    """After persisting an assistant message + a tool result, the rendered
    history should contain a single assistant bubble with both a paragraph
    and a tool card."""
    sess = models.Session(workflow_id=workflow.id)
    db.add(sess)
    db.commit()
    db.refresh(sess)

    db.add(models.Message(session_id=sess.id, role="user", content="build it"))
    db.add(
        models.Message(
            session_id=sess.id,
            role="assistant",
            content="okay, adding a loader.",
            tool_calls=[
                {
                    "id": "tc_1",
                    "type": "function",
                    "function": {
                        "name": "add_node",
                        "arguments": json.dumps({"name": "loader"}),
                    },
                }
            ],
        )
    )
    db.add(
        models.Message(
            session_id=sess.id,
            role="tool",
            tool_call_id="tc_1",
            name="add_node",
            content=json.dumps({"node_id": "abc", "node": {"name": "loader"}}),
        )
    )
    db.commit()

    bubbles = orch_agent.render_history(db, sess.id)
    assert bubbles[0] == {"role": "user", "text": "build it"}
    assert bubbles[1]["role"] == "assistant"
    blocks = bubbles[1]["content"]
    assert blocks[0]["t"] == "p"
    assert blocks[0]["text"].startswith("okay")
    assert blocks[1]["t"] == "tool"
    assert blocks[1]["tool"] == "add_node"
    assert blocks[1]["status"] == "ok"


def test_llm_tool_specs_covers_full_surface():
    names = {spec["function"]["name"] for spec in orch_tools.llm_tool_specs()}
    assert names == {
        "view_graph",
        "view_node_details",
        "add_node",
        "remove_node",
        "rename_node",
        "configure_node",
        "add_edge",
        "remove_edge",
        "set_input_node",
        "set_output_node",
        "clean_canvas",
        "run_workflow",
        "list_runs",
        "view_run",
    }


def test_clean_canvas_wipes_nodes_edges_and_pointers(db, workflow):
    """`clean_canvas` removes every node + edge and clears in/out pointers,
    but leaves the workflow row + sessions + runs intact."""
    a = orch_tools.add_node(
        db, workflow.id, name="a", outputs=[{"name": "x"}],
    )["node_id"]
    b = orch_tools.add_node(
        db, workflow.id, name="b", inputs=[{"name": "y", "required": True}],
    )["node_id"]
    orch_tools.add_edge(
        db, workflow.id,
        from_node_id=a, from_output="x", to_node_id=b, to_input="y",
    )
    orch_tools.set_input_node(db, workflow.id, node_id=a)
    orch_tools.set_output_node(db, workflow.id, node_id=b)
    # A historical run row — must survive the wipe.
    run = models.Run(workflow_id=workflow.id, kind="user", status="success", inputs={})
    db.add(run)
    db.commit()
    rid = run.id

    res = orch_tools.clean_canvas(db, workflow.id)
    assert res == {"cleared": True, "removed_nodes": 2, "removed_edges": 1}

    db.refresh(workflow)
    assert workflow.input_node_id is None
    assert workflow.output_node_id is None
    assert db.query(models.Node).filter_by(workflow_id=workflow.id).count() == 0
    assert db.query(models.Edge).filter_by(workflow_id=workflow.id).count() == 0
    # Run history preserved.
    assert db.get(models.Run, rid) is not None


def test_clean_canvas_blocked_during_active_run(db, workflow):
    """Clean is a graph mutation — must respect the run-in-progress lock."""
    from app.runner import events as ev_mod

    orch_tools.add_node(db, workflow.id, name="a")["node_id"]
    run = models.Run(workflow_id=workflow.id, kind="user", status="running", inputs={})
    db.add(run); db.commit(); db.refresh(run)
    ev_mod.get_or_create(run.id)

    res = orch_tools.execute(db, workflow.id, "clean_canvas", {})
    assert "error" in res
    assert "in progress" in res["error"]
    assert db.query(models.Node).filter_by(workflow_id=workflow.id).count() == 1


# ---------------------------------------------------------------------------
def test_delete_workflow_blocked_during_active_run(db, workflow):
    run = models.Run(workflow_id=workflow.id, kind="user", status="running", inputs={})
    db.add(run)
    db.commit()

    with pytest.raises(HTTPException) as exc:
        workflow_api.delete_workflow(workflow.id, db=db)

    assert exc.value.status_code == 409
    assert db.get(models.Workflow, workflow.id) is not None


def test_delete_workflow_cascades_rows_and_discards_run_events(db, workflow):
    sess = models.Session(workflow_id=workflow.id)
    run = models.Run(workflow_id=workflow.id, kind="user", status="success", inputs={})
    node = models.Node(workflow_id=workflow.id, name="n")
    db.add_all([sess, run, node])
    db.commit()
    db.add(models.Message(session_id=sess.id, role="user", content="hi"))
    db.add(models.NodeRun(run_id=run.id, node_id=node.id, status="success"))
    db.commit()
    runner_events.append_event(
        run.id,
        {"type": "run_finished", "status": "success", "outputs": {}, "total_cost": 0.0},
    )

    workflow_api.delete_workflow(workflow.id, db=db)

    assert db.get(models.Workflow, workflow.id) is None
    assert db.get(models.Run, run.id) is None
    assert db.query(models.NodeRun).filter_by(run_id=run.id).count() == 0
    assert db.get(models.Session, sess.id) is None
    assert db.query(models.Message).filter_by(session_id=sess.id).count() == 0
    assert runner_events.get(run.id) is None


# graph state snapshot — code is intentionally omitted (orchestrator pulls it
# on demand via view_node_details). The user_edited flag stays.
# ---------------------------------------------------------------------------


def test_graph_state_omits_code_but_keeps_user_edited_flag(db, workflow):
    nid = orch_tools.add_node(db, workflow.id, name="loader")["node_id"]
    orch_tools.configure_node(
        db, workflow.id,
        node_id=nid,
        code="def run(inputs, ctx):\n    return {'x': 1}\n",
    )

    msg = graph_state_message(db, workflow.id)
    state = json.loads(msg["content"].split("\n", 1)[1])
    node = next(n for n in state["nodes"] if n["id"] == nid)

    assert "code" not in node
    assert "code_truncated" not in node
    assert node["user_edited"] is False

    # mark the node user-edited and verify the flag flips
    n = db.get(models.Node, nid)
    from datetime import datetime
    n.user_edited_at = datetime.utcnow()
    db.commit()
    msg2 = graph_state_message(db, workflow.id)
    state2 = json.loads(msg2["content"].split("\n", 1)[1])
    node2 = next(n for n in state2["nodes"] if n["id"] == nid)
    assert node2["user_edited"] is True


# ---------------------------------------------------------------------------
# view_graph + view_node_details — read-only inspection tools
# ---------------------------------------------------------------------------


def test_view_graph_returns_full_structural_state(db, workflow):
    a = orch_tools.add_node(
        db, workflow.id, name="a",
        outputs=[{"name": "x"}],
    )["node_id"]
    b = orch_tools.add_node(
        db, workflow.id, name="b",
        inputs=[{"name": "y", "required": True}],
    )["node_id"]
    orch_tools.add_edge(
        db, workflow.id,
        from_node_id=a, from_output="x", to_node_id=b, to_input="y",
    )
    orch_tools.set_input_node(db, workflow.id, node_id=a)
    orch_tools.set_output_node(db, workflow.id, node_id=b)

    res = orch_tools.view_graph(db, workflow.id)
    assert res["workflow_id"] == workflow.id
    assert res["input_node_id"] == a
    assert res["output_node_id"] == b
    names = {n["name"] for n in res["nodes"]}
    assert names == {"a", "b"}
    # No code in the structural view.
    assert all("code" not in n for n in res["nodes"])
    assert len(res["edges"]) == 1


def test_view_node_details_returns_full_untruncated_code(db, workflow):
    long_code = "def run(inputs, ctx):\n" + ("    pass  # long\n" * 500)
    nid = orch_tools.add_node(
        db, workflow.id, name="big",
        description="huge node",
        model="anthropic/claude-sonnet-4.5",
    )["node_id"]
    orch_tools.configure_node(db, workflow.id, node_id=nid, code=long_code)

    res = orch_tools.view_node_details(db, workflow.id, node_id=nid)
    assert res["id"] == nid
    assert res["name"] == "big"
    assert res["description"] == "huge node"
    # Full code returned, no truncation marker.
    assert res["code"] == long_code
    assert "<truncated" not in res["code"]
    assert res["config"]["model"] == "anthropic/claude-sonnet-4.5"
    assert "tools_enabled" not in res["config"]
    assert "timeout_s" not in res["config"]
    assert res["user_edited"] is False
    # position + user_edited_at are not exposed to the LLM (no point — it
    # can't move nodes and the boolean `user_edited` is all it acts on).
    assert "position" not in res
    assert "user_edited_at" not in res


def test_view_node_details_unknown_node_errors(db, workflow):
    res = orch_tools.execute(
        db, workflow.id, "view_node_details", {"node_id": "does-not-exist"}
    )
    assert "error" in res
    assert "not found" in res["error"]


def test_view_tools_work_during_active_run(db, workflow):
    """Non-graph-mutating tools must NOT be blocked by the run-in-progress lock."""
    from app.runner import events as ev_mod

    nid = orch_tools.add_node(db, workflow.id, name="a")["node_id"]

    run = models.Run(workflow_id=workflow.id, kind="user", status="running", inputs={})
    db.add(run)
    db.commit()
    db.refresh(run)
    ev_mod.get_or_create(run.id)

    # Mutating tool: blocked.
    blocked = orch_tools.execute(
        db, workflow.id, "rename_node", {"node_id": nid, "new_name": "b"}
    )
    assert "error" in blocked and "in progress" in blocked["error"]

    # Read-only tools: still work.
    g = orch_tools.execute(db, workflow.id, "view_graph", {})
    assert "error" not in g
    assert any(n["id"] == nid for n in g["nodes"])

    d = orch_tools.execute(db, workflow.id, "view_node_details", {"node_id": nid})
    assert "error" not in d
    assert d["id"] == nid


def test_view_run_returns_run_level_summary_by_default(db, workflow):
    """No `node_id` → run-level summary: outputs, node_errors, error, total_cost."""
    nid = orch_tools.add_node(db, workflow.id, name="summariser")["node_id"]
    run = models.Run(
        workflow_id=workflow.id,
        kind="user",
        status="error",
        inputs={"q": "hi"},
        outputs={"summary": "partial"},
        error="downstream blew up",
        total_cost=0.42,
    )
    db.add(run); db.commit(); db.refresh(run)
    db.add(
        models.NodeRun(
            run_id=run.id,
            node_id=nid,
            status="error",
            inputs={"q": "hi"},
            outputs={},
            logs=["loaded", "boom"],
            error="ValueError: bad input",
            duration_ms=42,
            cost=0.01,
        )
    )
    db.commit()

    res = orch_tools.view_run(db, workflow.id, run_id=run.id)
    assert res["run_id"] == run.id
    assert res["status"] == "error"
    assert res["outputs"] == {"summary": "partial"}
    assert res["error"] == "downstream blew up"
    assert res["total_cost"] == 0.42
    assert res["node_errors"] == [
        {"node_id": nid, "node_name": "summariser", "error": "ValueError: bad input"}
    ]
    # Summary form must NOT carry per-node logs/inputs.
    assert "logs" not in res
    assert "node_id" not in res


def test_view_run_with_node_id_returns_node_inputs_outputs_logs(db, workflow):
    """`node_id` → per-node record: inputs, outputs, logs, status, error, etc."""
    nid = orch_tools.add_node(db, workflow.id, name="loader")["node_id"]
    run = models.Run(
        workflow_id=workflow.id,
        kind="user",
        status="success",
        inputs={"path": "/tmp/x"},
        outputs={"items": [1, 2, 3]},
        total_cost=0.05,
    )
    db.add(run); db.commit(); db.refresh(run)
    db.add(
        models.NodeRun(
            run_id=run.id,
            node_id=nid,
            status="success",
            inputs={"path": "/tmp/x"},
            outputs={"items": [1, 2, 3]},
            logs=["reading /tmp/x", "got 3 rows"],
            error=None,
            duration_ms=17,
            cost=0.02,
        )
    )
    db.commit()

    res = orch_tools.view_run(db, workflow.id, run_id=run.id, node_id=nid)
    assert res == {
        "run_id": run.id,
        "node_id": nid,
        "node_name": "loader",
        "status": "success",
        "inputs": {"path": "/tmp/x"},
        "outputs": {"items": [1, 2, 3]},
        "logs": ["reading /tmp/x", "got 3 rows"],
        "error": None,
        "duration_ms": 17,
        "cost": 0.02,
    }


def test_view_run_with_node_id_uses_snapshot_name_after_rename(db, workflow):
    """When the live node has been renamed since the run, prefer the
    snapshot's name — that's the name the user saw when the run executed."""
    nid = orch_tools.add_node(db, workflow.id, name="loader")["node_id"]
    snapshot = {"nodes": [{"id": nid, "name": "loader"}], "edges": []}
    run = models.Run(
        workflow_id=workflow.id,
        kind="user",
        status="success",
        inputs={},
        outputs={},
        workflow_snapshot=snapshot,
    )
    db.add(run); db.commit(); db.refresh(run)
    db.add(
        models.NodeRun(
            run_id=run.id, node_id=nid, status="success",
            inputs={}, outputs={}, logs=[], duration_ms=0, cost=0.0,
        )
    )
    db.commit()

    orch_tools.rename_node(db, workflow.id, node_id=nid, new_name="loader_v2")

    res = orch_tools.view_run(db, workflow.id, run_id=run.id, node_id=nid)
    assert res["node_name"] == "loader"


def test_view_run_with_unknown_node_id_returns_error(db, workflow):
    """If the node never executed (no NodeRun row), surface a clear error
    rather than an empty record."""
    nid = orch_tools.add_node(db, workflow.id, name="reached")["node_id"]
    skipped = orch_tools.add_node(db, workflow.id, name="never_reached")["node_id"]
    run = models.Run(
        workflow_id=workflow.id, kind="user", status="error",
        inputs={}, outputs={}, error="reached failed",
    )
    db.add(run); db.commit(); db.refresh(run)
    db.add(
        models.NodeRun(
            run_id=run.id, node_id=nid, status="error",
            inputs={}, outputs={}, logs=[], error="boom",
            duration_ms=1, cost=0.0,
        )
    )
    db.commit()

    res = orch_tools.view_run(db, workflow.id, run_id=run.id, node_id=skipped)
    assert "error" in res
    assert skipped in res["error"]
    assert "did not execute" in res["error"]


def test_view_run_node_id_dispatches_via_execute(db, workflow):
    """`execute()` must forward the optional `node_id` arg through to the tool."""
    nid = orch_tools.add_node(db, workflow.id, name="n")["node_id"]
    run = models.Run(
        workflow_id=workflow.id, kind="user", status="success",
        inputs={}, outputs={},
    )
    db.add(run); db.commit(); db.refresh(run)
    db.add(
        models.NodeRun(
            run_id=run.id, node_id=nid, status="success",
            inputs={"a": 1}, outputs={"b": 2}, logs=["hi"],
            duration_ms=5, cost=0.0,
        )
    )
    db.commit()

    res = orch_tools.execute(
        db, workflow.id, "view_run", {"run_id": run.id, "node_id": nid}
    )
    assert res["node_id"] == nid
    assert res["inputs"] == {"a": 1}
    assert res["outputs"] == {"b": 2}
    assert res["logs"] == ["hi"]


def test_view_run_schema_advertises_optional_node_id_and_fields():
    """The OpenRouter tool schema must expose `node_id` and `fields` as
    optional parameters — required list stays as just `run_id`. `fields` is
    an array of enum constrained to {inputs, outputs, logs}."""
    spec = orch_tools.TOOL_SCHEMAS["view_run"]
    params = spec["function"]["parameters"]
    assert set(params["properties"].keys()) == {"run_id", "node_id", "fields"}
    assert params["required"] == ["run_id"]
    fields_spec = params["properties"]["fields"]
    assert fields_spec["type"] == "array"
    assert fields_spec["items"]["enum"] == ["inputs", "outputs", "logs"]
    assert fields_spec.get("uniqueItems") is True


def test_view_run_node_fields_filters_to_requested_slice(db, workflow):
    """`fields=["logs"]` returns only logs (plus the always-present metadata)
    — `inputs` and `outputs` are omitted entirely from the dict."""
    nid = orch_tools.add_node(db, workflow.id, name="loader")["node_id"]
    run = models.Run(
        workflow_id=workflow.id, kind="user", status="success",
        inputs={}, outputs={},
    )
    db.add(run); db.commit(); db.refresh(run)
    db.add(
        models.NodeRun(
            run_id=run.id, node_id=nid, status="success",
            inputs={"path": "/tmp/x"},
            outputs={"items": [1, 2, 3]},
            logs=["reading", "done"],
            duration_ms=9, cost=0.0,
        )
    )
    db.commit()

    res = orch_tools.view_run(
        db, workflow.id, run_id=run.id, node_id=nid, fields=["logs"]
    )
    assert res["logs"] == ["reading", "done"]
    assert "inputs" not in res
    assert "outputs" not in res
    # Metadata still present.
    assert res["status"] == "success"
    assert res["node_name"] == "loader"
    assert res["duration_ms"] == 9


def test_view_run_node_fields_accepts_multiple_and_dedupes(db, workflow):
    """Multi-select works; duplicates in `fields` don't break anything."""
    nid = orch_tools.add_node(db, workflow.id, name="n")["node_id"]
    run = models.Run(
        workflow_id=workflow.id, kind="user", status="success",
        inputs={}, outputs={},
    )
    db.add(run); db.commit(); db.refresh(run)
    db.add(
        models.NodeRun(
            run_id=run.id, node_id=nid, status="success",
            inputs={"a": 1}, outputs={"b": 2}, logs=["hi"],
            duration_ms=1, cost=0.0,
        )
    )
    db.commit()

    res = orch_tools.view_run(
        db, workflow.id, run_id=run.id, node_id=nid,
        fields=["inputs", "outputs", "inputs"],
    )
    assert res["inputs"] == {"a": 1}
    assert res["outputs"] == {"b": 2}
    assert "logs" not in res


def test_view_run_node_fields_rejects_unknown_field(db, workflow):
    nid = orch_tools.add_node(db, workflow.id, name="n")["node_id"]
    run = models.Run(
        workflow_id=workflow.id, kind="user", status="success",
        inputs={}, outputs={},
    )
    db.add(run); db.commit(); db.refresh(run)
    db.add(
        models.NodeRun(
            run_id=run.id, node_id=nid, status="success",
            inputs={}, outputs={}, logs=[], duration_ms=0, cost=0.0,
        )
    )
    db.commit()

    res = orch_tools.view_run(
        db, workflow.id, run_id=run.id, node_id=nid, fields=["bogus"]
    )
    assert "error" in res
    assert "bogus" in res["error"]


def test_list_runs_returns_recent_first_with_lean_shape(db, workflow):
    """`list_runs` returns the most recent runs first, each as the lean
    metadata-only shape — no inputs/outputs/node_runs payload."""
    import time
    from datetime import datetime, timedelta

    # Three runs, oldest → newest. Set started_at explicitly so ordering
    # doesn't depend on the test taking measurable wall time.
    base = datetime(2026, 5, 10, 12, 0, 0)
    r_old = models.Run(
        workflow_id=workflow.id, kind="user", status="success",
        inputs={}, outputs={"big": "x" * 1000}, total_cost=0.10,
        started_at=base, ended_at=base + timedelta(seconds=5),
    )
    r_mid = models.Run(
        workflow_id=workflow.id, kind="orchestrator", status="error",
        inputs={}, outputs={}, error="boom", total_cost=0.05,
        started_at=base + timedelta(minutes=1),
        ended_at=base + timedelta(minutes=1, seconds=2),
    )
    r_new = models.Run(
        workflow_id=workflow.id, kind="user", status="running",
        inputs={}, outputs={}, total_cost=0.0,
        started_at=base + timedelta(minutes=2),
    )
    db.add_all([r_old, r_mid, r_new])
    db.commit()

    res = orch_tools.list_runs(db, workflow.id)
    assert res["count"] == 3
    assert res["limit"] == 20
    assert [r["run_id"] for r in res["runs"]] == [r_new.id, r_mid.id, r_old.id]

    # Lean shape — no heavy fields leaked.
    first = res["runs"][0]
    assert set(first.keys()) == {
        "run_id", "status", "kind", "started_at", "ended_at", "total_cost", "error",
    }
    assert first["status"] == "running"
    assert first["ended_at"] is None
    assert first["error"] is None

    mid = res["runs"][1]
    assert mid["kind"] == "orchestrator"
    assert mid["status"] == "error"
    assert mid["error"] == "boom"
    assert mid["total_cost"] == 0.05
    assert mid["started_at"] == (base + timedelta(minutes=1)).isoformat()


def test_list_runs_respects_limit_and_clamps_to_max(db, workflow):
    """`limit` trims the page; absurd values clamp to the hard ceiling."""
    from datetime import datetime, timedelta

    base = datetime(2026, 5, 10, 12, 0, 0)
    for i in range(5):
        db.add(
            models.Run(
                workflow_id=workflow.id, kind="user", status="success",
                inputs={}, outputs={}, total_cost=0.0,
                started_at=base + timedelta(minutes=i),
            )
        )
    db.commit()

    res = orch_tools.list_runs(db, workflow.id, limit=2)
    assert res["count"] == 2
    assert res["limit"] == 2

    # Way over the ceiling clamps to MAX (100). Doesn't fabricate rows.
    res_big = orch_tools.list_runs(db, workflow.id, limit=10_000)
    assert res_big["limit"] == 100
    assert res_big["count"] == 5


def test_list_runs_empty_when_no_runs(db, workflow):
    res = orch_tools.list_runs(db, workflow.id)
    assert res == {"runs": [], "count": 0, "limit": 20}


def test_run_workflow_tags_run_as_orchestrator_kind(db, workflow, monkeypatch):
    """Runs the orchestrator triggers via `run_workflow` are tagged
    `kind="orchestrator"` so `list_runs` can distinguish them from runs the
    user kicked off directly (which stay `kind="user"`)."""
    from app.runner import service as run_service

    # The orchestrator's run_workflow shells out to start_run for actual
    # execution — stub it out so this stays a unit test.
    monkeypatch.setattr(run_service, "start_run", lambda *a, **kw: None)

    nid = orch_tools.add_node(
        db, workflow.id, name="passthrough",
        inputs=[{"name": "q", "required": True}],
        outputs=[{"name": "out"}],
    )["node_id"]
    orch_tools.set_input_node(db, workflow.id, node_id=nid)
    orch_tools.set_output_node(db, workflow.id, node_id=nid)

    res = orch_tools.run_workflow(db, workflow.id, inputs={"q": "hi"})
    assert res["status"] == "running"
    rid = res["run_id"]

    row = db.get(models.Run, rid)
    assert row is not None
    assert row.kind == "orchestrator"


def test_list_runs_unknown_workflow_errors_via_execute(db):
    res = orch_tools.execute(db, "no-such-workflow", "list_runs", {})
    assert "error" in res
    assert "no-such-workflow" in res["error"]


def test_list_runs_works_during_active_run(db, workflow):
    """Like the other read-only tools, `list_runs` must NOT be blocked by
    the run-in-progress lock."""
    from app.runner import events as ev_mod

    run = models.Run(
        workflow_id=workflow.id, kind="user", status="running", inputs={},
    )
    db.add(run); db.commit(); db.refresh(run)
    ev_mod.get_or_create(run.id)

    res = orch_tools.execute(db, workflow.id, "list_runs", {})
    assert "error" not in res
    assert any(r["run_id"] == run.id for r in res["runs"])


def test_view_run_fields_without_node_id_is_an_error(db, workflow):
    """`fields` only makes sense for the per-node form — reject otherwise
    instead of silently ignoring it."""
    run = models.Run(
        workflow_id=workflow.id, kind="user", status="success",
        inputs={}, outputs={},
    )
    db.add(run); db.commit(); db.refresh(run)
    res = orch_tools.view_run(db, workflow.id, run_id=run.id, fields=["logs"])
    assert "error" in res
    assert "node_id" in res["error"]


def test_run_snapshot_survives_subsequent_graph_mutation(db, workflow):
    """A `Run` row's `workflow_snapshot` is frozen at creation — removing
    nodes/edges afterwards must not perturb it. This is the contract that
    lets the canvas re-render an old run's graph after the live workflow
    has been edited."""
    from app.api.runs import _serialize_workflow

    a = orch_tools.add_node(
        db, workflow.id, name="loader",
        outputs=[{"name": "x"}],
    )["node_id"]
    orch_tools.configure_node(
        db, workflow.id, node_id=a,
        code="def run(inputs, ctx):\n    return {'x': 1}\n",
    )
    b = orch_tools.add_node(
        db, workflow.id, name="summariser",
        inputs=[{"name": "y", "required": True}],
    )["node_id"]
    orch_tools.add_edge(
        db, workflow.id,
        from_node_id=a, from_output="x", to_node_id=b, to_input="y",
    )
    orch_tools.set_input_node(db, workflow.id, node_id=a)
    orch_tools.set_output_node(db, workflow.id, node_id=b)

    db.refresh(workflow)
    snapshot = _serialize_workflow(workflow)

    run = models.Run(
        workflow_id=workflow.id,
        kind="user",
        status="success",
        inputs={},
        workflow_snapshot=snapshot,
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    # Mutate the live graph: rename a node and delete the other.
    orch_tools.rename_node(db, workflow.id, node_id=a, new_name="renamed_loader")
    orch_tools.remove_node(db, workflow.id, node_id=b)

    # The run's snapshot is untouched — same node names, same edge, same code.
    db.expire_all()
    persisted = db.get(models.Run, run.id)
    assert persisted is not None
    snap = persisted.workflow_snapshot
    assert snap is not None
    snap_names = sorted(n["name"] for n in snap["nodes"])
    assert snap_names == ["loader", "summariser"]
    assert snap["input_node_id"] == a
    assert snap["output_node_id"] == b
    assert len(snap["edges"]) == 1
    # Code is preserved so the canvas can show what actually ran.
    loader = next(n for n in snap["nodes"] if n["name"] == "loader")
    assert "return {'x': 1}" in loader["code"]
    # Position is preserved so the canvas can re-render without re-laying out.
    assert "position" in loader and "x" in loader["position"]


def test_render_history_surfaces_tool_result(db, workflow):
    """Persisted tool blocks should carry their `result` payload so the chat
    panel can render rich tool cards (e.g. `run_workflow`) on history reload,
    not only during the live stream."""
    sess = models.Session(workflow_id=workflow.id)
    db.add(sess); db.commit(); db.refresh(sess)

    db.add(models.Message(session_id=sess.id, role="user", content="run it"))
    db.add(
        models.Message(
            session_id=sess.id,
            role="assistant",
            content="",
            tool_calls=[
                {
                    "id": "tc_run",
                    "type": "function",
                    "function": {
                        "name": "run_workflow",
                        "arguments": json.dumps({"inputs": {}}),
                    },
                }
            ],
        )
    )
    db.add(
        models.Message(
            session_id=sess.id,
            role="tool",
            tool_call_id="tc_run",
            name="run_workflow",
            content=json.dumps(
                {
                    "run_id": "abc",
                    "status": "success",
                    "outputs": {"summary": "hi"},
                    "node_errors": [],
                    "error": None,
                    "total_cost": 0.04,
                }
            ),
        )
    )
    db.commit()

    bubbles = orch_agent.render_history(db, sess.id)
    asst = bubbles[1]
    tool_block = next(b for b in asst["content"] if b["t"] == "tool")
    assert tool_block["tool"] == "run_workflow"
    assert tool_block["status"] == "ok"
    assert tool_block["result"]["run_id"] == "abc"
    assert tool_block["result"]["total_cost"] == 0.04


def test_non_graph_mutating_tools_set_matches_registry():
    # Belt-and-braces: the named-set has to match what's exempt from the
    # dispatcher's "no mutation during a run" guard. Inspection tools and
    # `run_workflow` qualify; `run_workflow` does its own active-run check
    # internally with a clearer error message.
    assert orch_tools.NON_GRAPH_MUTATING_TOOLS == {
        "view_graph",
        "view_node_details",
        "list_runs",
        "view_run",
        "run_workflow",
    }
    for name in orch_tools.NON_GRAPH_MUTATING_TOOLS:
        assert name in orch_tools.REGISTRY


# ---------------------------------------------------------------------------
# SSE streaming parser
# ---------------------------------------------------------------------------


def _sse(payload: dict) -> str:
    return "data: " + json.dumps(payload)


def test_parse_sse_yields_text_deltas_in_order():
    lines = [
        _sse({"choices": [{"delta": {"role": "assistant", "content": "hel"}}]}),
        _sse({"choices": [{"delta": {"content": "lo"}}]}),
        _sse({"choices": [{"delta": {"content": " world"}}]}),
        "data: [DONE]",
    ]
    events = list(orch_agent._parse_sse_chunks(iter(lines)))
    text_deltas = [p for k, p in events if k == "text"]
    assert text_deltas == ["hel", "lo", " world"]
    done = [p for k, p in events if k == "done"]
    assert len(done) == 1
    assert done[0]["message"]["content"] == "hello world"
    assert done[0]["message"].get("tool_calls", []) == []


def test_parse_sse_assembles_tool_call_deltas():
    """Tool calls arrive piece-by-piece across chunks: id once, name once,
    arguments incrementally. We need to assemble them by `index`."""
    lines = [
        _sse({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0, "id": "call_xyz", "type": "function",
                        "function": {"name": "add_node", "arguments": ""},
                    }],
                },
            }],
        }),
        _sse({
            "choices": [{
                "delta": {"tool_calls": [{"index": 0, "function": {"arguments": "{\"name"}}]},
            }],
        }),
        _sse({
            "choices": [{
                "delta": {"tool_calls": [{"index": 0, "function": {"arguments": "\":\"loader\"}"}}]},
            }],
        }),
        "data: [DONE]",
    ]
    events = list(orch_agent._parse_sse_chunks(iter(lines)))
    done = next(p for k, p in events if k == "done")
    msg = done["message"]
    assert msg["content"] == ""
    assert len(msg["tool_calls"]) == 1
    tc = msg["tool_calls"][0]
    assert tc["id"] == "call_xyz"
    assert tc["function"]["name"] == "add_node"
    assert json.loads(tc["function"]["arguments"]) == {"name": "loader"}


def test_parse_sse_text_then_tool_call_in_one_round():
    lines = [
        _sse({"choices": [{"delta": {"content": "okay,"}}]}),
        _sse({"choices": [{"delta": {"content": " adding it."}}]}),
        _sse({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0, "id": "c1", "type": "function",
                        "function": {"name": "add_node", "arguments": "{}"},
                    }],
                },
            }],
        }),
        "data: [DONE]",
    ]
    events = list(orch_agent._parse_sse_chunks(iter(lines)))
    text = "".join(p for k, p in events if k == "text")
    assert text == "okay, adding it."
    done = next(p for k, p in events if k == "done")
    assert done["message"]["content"] == "okay, adding it."
    assert done["message"]["tool_calls"][0]["function"]["name"] == "add_node"


def test_parse_sse_skips_garbage_and_non_data_lines():
    """Comments, blank lines, and malformed JSON shouldn't crash the parser."""
    lines = [
        "",
        ": heartbeat comment",
        "event: message",
        "data: {not valid json",
        _sse({"choices": [{"delta": {"content": "hi"}}]}),
        "data: [DONE]",
    ]
    events = list(orch_agent._parse_sse_chunks(iter(lines)))
    text = "".join(p for k, p in events if k == "text")
    assert text == "hi"


def test_parse_sse_handles_natural_eof_without_done_marker():
    """Some upstreams close the connection without sending `[DONE]`. We should
    still emit a final `done` event with what we accumulated."""
    lines = [
        _sse({"choices": [{"delta": {"content": "partial"}}]}),
        # no [DONE] line — iterator just exhausts
    ]
    events = list(orch_agent._parse_sse_chunks(iter(lines)))
    done = next(p for k, p in events if k == "done")
    assert done["message"]["content"] == "partial"


def test_parse_sse_captures_usage_when_present():
    lines = [
        _sse({"choices": [{"delta": {"content": "x"}}]}),
        _sse({"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 3}}),
        "data: [DONE]",
    ]
    events = list(orch_agent._parse_sse_chunks(iter(lines)))
    done = next(p for k, p in events if k == "done")
    assert done["usage"] == {"prompt_tokens": 12, "completion_tokens": 3}


# ---------------------------------------------------------------------------
# end-to-end: run_turn with a stubbed OpenRouter stream
# ---------------------------------------------------------------------------


def test_run_turn_streams_chunks_executes_tools_and_persists(db, workflow, monkeypatch):
    """Drive a two-round agent loop with a fake OpenRouter stream:

      round 1: chunks "okay," " adding." + a tool call to add_node(name="loader")
      round 2: chunk " done." + no tool calls → loop exits

    Verifies (a) chunk events flow in order, (b) the tool actually mutated the
    DB, (c) the assistant message + tool result are persisted in OpenRouter
    shape, and (d) the run_turn generator terminates with `done`.
    """
    sess = models.Session(workflow_id=workflow.id)
    db.add(sess)
    db.commit()
    db.refresh(sess)

    rounds = [
        [
            ("text", "okay,"),
            ("text", " adding."),
            (
                "done",
                {
                    "message": {
                        "role": "assistant",
                        "content": "okay, adding.",
                        "tool_calls": [
                            {
                                "id": "call_loader",
                                "type": "function",
                                "function": {
                                    "name": "add_node",
                                    "arguments": json.dumps({"name": "loader"}),
                                },
                            }
                        ],
                    },
                    "usage": {},
                },
            ),
        ],
        [
            ("text", " done."),
            (
                "done",
                {
                    "message": {"role": "assistant", "content": " done.", "tool_calls": []},
                    "usage": {},
                },
            ),
        ],
    ]
    rounds_iter = iter(rounds)

    def fake_stream(model, messages, tool_specs, cancel_event=None):
        # The agent loop calls this once per round; pull the next scripted set.
        return iter(next(rounds_iter))

    monkeypatch.setattr(orch_agent, "_call_openrouter_stream", fake_stream)

    events = list(orch_agent.run_turn(db, sess.id, "build me one"))
    kinds = [e["kind"] for e in events]

    # First event is the user echo; last is `done`.
    assert kinds[0] == "user_message"
    assert kinds[-1] == "done"

    # All text chunks (in order) reconstruct both rounds' content.
    chunk_text = "".join(e["text"] for e in events if e["kind"] == "assistant_text_chunk")
    assert chunk_text == "okay, adding. done."

    # The tool fired, with start before end.
    starts = [i for i, k in enumerate(kinds) if k == "tool_call_start"]
    ends = [i for i, k in enumerate(kinds) if k == "tool_call_end"]
    assert len(starts) == 1 and len(ends) == 1
    assert starts[0] < ends[0]
    end_event = events[ends[0]]
    assert end_event["status"] == "ok"
    assert end_event["tool"] == "add_node"

    # Real DB mutation happened.
    assert db.query(models.Node).filter_by(workflow_id=workflow.id, name="loader").count() == 1

    # Persisted history shape: user → assistant(+tool_calls) → tool → assistant.
    msgs = (
        db.query(models.Message)
        .filter_by(session_id=sess.id)
        .order_by(models.Message.ts.asc(), models.Message.id.asc())
        .all()
    )
    roles = [m.role for m in msgs]
    assert roles == ["user", "assistant", "tool", "assistant"]
    assert msgs[1].tool_calls and msgs[1].tool_calls[0]["function"]["name"] == "add_node"
    assert msgs[2].tool_call_id == "call_loader"
    assert msgs[3].content == " done."


def test_run_turn_user_cancel_mid_stream_does_not_persist_partial(db, workflow, monkeypatch):
    """When the user clicks cancel while text is streaming, no assistant
    message gets persisted (so half-formed tool_calls can't corrupt history)
    and the stream terminates cleanly with `done` — no scary error banner."""
    sess = models.Session(workflow_id=workflow.id)
    db.add(sess); db.commit(); db.refresh(sess)

    def fake_stream(model, messages, tool_specs, cancel_event=None):
        # First chunk: emit text. Then simulate the user clicking cancel
        # mid-stream by setting the event ourselves. Subsequent yields stop.
        yield ("text", "okay,")
        if cancel_event is not None:
            cancel_event.set()
        # The real `_call_openrouter_stream` would observe cancel_event and
        # break out. We simulate that by emitting only the final done with
        # whatever was assembled so far (no tool_calls, partial content).
        yield ("done", {"message": {"role": "assistant", "content": "okay,"}, "usage": {}})

    monkeypatch.setattr(orch_agent, "_call_openrouter_stream", fake_stream)

    events = list(orch_agent.run_turn(db, sess.id, "build something"))
    kinds = [e["kind"] for e in events]

    # Sequence: user_message, the one chunk, then `done`. No `error` event
    # because the user cancelled — they don't need a banner.
    assert kinds == ["user_message", "assistant_text_chunk", "done"]

    # Only the user message was persisted — no partial assistant message.
    msgs = db.query(models.Message).filter_by(session_id=sess.id).all()
    assert [m.role for m in msgs] == ["user"]


def test_run_turn_supersede_emits_error_banner(db, workflow, monkeypatch):
    """If a NEW user message arrives while the prior turn is mid-stream,
    we emit `superseded by a newer message` (so the prior bubble shows the
    interruption) followed by `done`."""
    sess = models.Session(workflow_id=workflow.id)
    db.add(sess); db.commit(); db.refresh(sess)

    def fake_stream(model, messages, tool_specs, cancel_event=None):
        yield ("text", "starting…")
        # Simulate a new turn claiming the session — this rotates the registry
        # so `_was_superseded` returns True.
        if cancel_event is not None:
            orch_agent._claim_turn(sess.id)  # rotates registry, sets old event
        yield ("done", {"message": {"role": "assistant", "content": "starting…"}, "usage": {}})

    monkeypatch.setattr(orch_agent, "_call_openrouter_stream", fake_stream)

    events = list(orch_agent.run_turn(db, sess.id, "first message"))
    kinds = [e["kind"] for e in events]

    # The `error` banner shows up because supersede is user-visible noise
    # (the new turn will produce its own assistant bubble).
    assert "error" in kinds
    err_event = next(e for e in events if e["kind"] == "error")
    assert "superseded" in err_event["message"]
    assert kinds[-1] == "done"

    # Clean up the registry entry left over from the simulated supersede.
    with orch_agent._TURN_LOCK:
        orch_agent._TURN_CANCEL_EVENTS.pop(sess.id, None)


def test_call_openrouter_stream_skips_remaining_lines_when_cancelled():
    """The HTTP-layer cancel check: once cancel_event is set between iter_lines
    yields, no further lines feed into the SSE parser, and the parser still
    emits a clean final `done` with whatever was assembled."""
    cancel_event = threading.Event()

    def lines():
        yield _sse({"choices": [{"delta": {"content": "first"}}]})
        cancel_event.set()
        # These lines should NOT be consumed.
        yield _sse({"choices": [{"delta": {"content": "second"}}]})
        yield "data: [DONE]"

    def cancellable_lines():
        for line in lines():
            if cancel_event.is_set():
                return
            yield line

    events = list(orch_agent._parse_sse_chunks(cancellable_lines()))
    text = "".join(p for k, p in events if k == "text")
    assert text == "first"
    done = next(p for k, p in events if k == "done")
    assert done["message"]["content"] == "first"


# ---------------------------------------------------------------------------
# gap 2 — user_edited mentioned in system prompt
# ---------------------------------------------------------------------------


def test_system_prompt_explains_user_edited_flag():
    assert "user_edited" in SYSTEM_PROMPT
    # Must instruct the model to *preserve* user intent, not just mention the flag.
    assert "preserve" in SYSTEM_PROMPT.lower()


def test_system_prompt_offers_both_direct_and_llm_tool_forms():
    """Nodes can invoke tools two ways: through `ctx.call_llm(tools=[...])` so
    the model decides, or directly via `ctx.tools.X(...)` for deterministic
    calls. The prompt must surface both — choosing between them is the
    orchestrator's call."""
    p = SYSTEM_PROMPT
    assert "ctx.tools" in p
    assert "tools=[...]" in p or "tools=[" in p


def test_system_prompt_lists_node_runtime_tool_signatures():
    """The orchestrator writes Python like `ctx.tools.web_fetch(...)` — it
    needs the canonical signatures (param names + types) in the prompt or it
    has to guess. Pulled at module load from `runner.tools.REGISTRY` via
    `inspect.signature`, so this test also catches signature drift."""
    from app.runner import tools as runtime_tools

    p = SYSTEM_PROMPT
    # placeholder must have been substituted
    assert "[[NODE_TOOL_SIGNATURES]]" not in p
    # Every registered tool's name appears in a signature-shaped line.
    for name in runtime_tools.REGISTRY:
        assert f"`{name}(" in p, f"missing signature line for '{name}'"
    # Spot-check a few of the actual params so a rename in tools.py
    # would break this test rather than silently drift the prompt.
    assert "command: str" in p  # shell
    assert "query: str" in p  # web_search
    assert "urls: list[str]" in p  # web_fetch


def test_system_prompt_distinguishes_orchestrator_vs_node_tools():
    """The prompt must teach the orchestrator that there are two kinds of
    tool: ones it invokes directly (graph mutators) and ones the *node code*
    uses at runtime (shell/web_search/web_fetch). The framing is constructive —
    the orchestrator has agency over both — but the categories are distinct.
    """
    p = SYSTEM_PROMPT
    lower = p.lower()
    # The graph-shaping tools belong to the orchestrator.
    assert "your tools" in lower
    # The runtime tool names are still mentioned alongside the node-code contract.
    assert "shell" in lower
    assert "web_search" in lower
    assert "web_fetch" in lower
    # tools_enabled is gone — make sure it didn't sneak back in.
    assert "tools_enabled" not in lower
    # And the prompt directly instructs how to answer "what tools do you have?"
    assert "what tools do you have" in lower


# ---------------------------------------------------------------------------
# gap 3 — turn cancellation
# ---------------------------------------------------------------------------


def test_claim_turn_signals_prior_event():
    sid = "test-session-cancel"
    a = orch_agent._claim_turn(sid)
    assert not a.is_set()
    b = orch_agent._claim_turn(sid)
    # claiming again signals the prior event...
    assert a.is_set()
    # ...and gives a fresh, unset event for the new turn.
    assert not b.is_set()
    orch_agent._release_turn(sid, b)
    # and only the active claim is in the registry now.
    assert sid not in orch_agent._TURN_CANCEL_EVENTS


def test_release_turn_only_clears_owned_event():
    sid = "test-session-release"
    a = orch_agent._claim_turn(sid)
    b = orch_agent._claim_turn(sid)
    # `a` is no longer current — releasing it should NOT clear the registry.
    orch_agent._release_turn(sid, a)
    assert orch_agent._TURN_CANCEL_EVENTS.get(sid) is b
    orch_agent._release_turn(sid, b)
    assert sid not in orch_agent._TURN_CANCEL_EVENTS


def test_signal_cancel_sets_event_without_rotating_registry():
    """Explicit user cancel sets the existing event; the registry entry stays
    the same instance, so `_was_superseded` returns False."""
    sid = "test-session-signal-cancel"
    a = orch_agent._claim_turn(sid)

    assert orch_agent._signal_cancel(sid) is True
    assert a.is_set() is True
    # Identity preserved — this is what distinguishes it from supersede.
    assert orch_agent._TURN_CANCEL_EVENTS.get(sid) is a
    assert orch_agent._was_superseded(sid, a) is False

    orch_agent._release_turn(sid, a)


def test_signal_cancel_returns_false_when_no_active_turn():
    sid = "test-session-no-turn"
    assert orch_agent._signal_cancel(sid) is False


def test_was_superseded_distinguishes_user_cancel_from_new_message():
    sid = "test-session-supersede"
    a = orch_agent._claim_turn(sid)

    # Path 1: explicit user cancel — `a` stays in the registry.
    orch_agent._signal_cancel(sid)
    assert orch_agent._was_superseded(sid, a) is False

    # Path 2: a newer message arrives — `a` is replaced by `b`.
    b = orch_agent._claim_turn(sid)
    assert orch_agent._was_superseded(sid, a) is True
    # `b` is the current turn and isn't superseded itself.
    assert orch_agent._was_superseded(sid, b) is False

    orch_agent._release_turn(sid, b)


# ---------------------------------------------------------------------------
# gap 4 — graph mutations blocked during a run
# ---------------------------------------------------------------------------


def test_execute_blocks_mutations_during_active_run(db, workflow):
    """When a Run row is `running` (and the in-memory event state agrees), all
    graph-mutating tool calls should return an error result instead of
    mutating the DB."""
    from app.runner import events as ev_mod

    nid = orch_tools.add_node(db, workflow.id, name="a")["node_id"]

    run = models.Run(workflow_id=workflow.id, kind="user", status="running", inputs={})
    db.add(run)
    db.commit()
    db.refresh(run)
    # The events registry must agree: we treat a DB row without in-memory state
    # as still active (handles the process-restart case), so an entry with
    # `finished=False` is the most defensive way to assert a real in-flight run.
    ev_mod.get_or_create(run.id)

    res = orch_tools.execute(db, workflow.id, "rename_node", {"node_id": nid, "new_name": "b"})
    assert "error" in res
    assert "in progress" in res["error"]

    # Original name preserved.
    assert db.get(models.Node, nid).name == "a"

    # Once the run finishes, mutations are allowed again.
    run.status = "success"
    db.commit()
    st = ev_mod.get(run.id)
    assert st is not None
    st.finished = True

    res2 = orch_tools.execute(db, workflow.id, "rename_node", {"node_id": nid, "new_name": "b"})
    assert "error" not in res2
    assert db.get(models.Node, nid).name == "b"


def test_execute_treats_stale_running_row_without_state_as_active(db, workflow):
    """If the runner crashed and left a `running` Run row but there's no
    in-memory state, we currently still block mutations (defensive). The user
    can recover by deleting/cancelling the row manually."""
    from app.runner import events as ev_mod

    orch_tools.add_node(db, workflow.id, name="a")["node_id"]
    run = models.Run(workflow_id=workflow.id, kind="user", status="running", inputs={})
    db.add(run)
    db.commit()
    # No ev_mod.get_or_create() for this run — simulating a crashed runner.
    assert ev_mod.get(run.id) is None

    res = orch_tools.execute(db, workflow.id, "add_node", {"name": "z"})
    assert "error" in res
    assert "in progress" in res["error"]


# --- reasoning / extended-thinking ---------------------------------------


def _sse_lines(*frames):
    """Build a flat list of SSE lines from JSON-serialisable chunk dicts."""
    out = []
    for f in frames:
        if f == "[DONE]":
            out.append("data: [DONE]")
        else:
            out.append("data: " + json.dumps(f))
        out.append("")
    return out


def test_parse_sse_emits_thinking_chunks_and_collects_details():
    """The streaming parser yields ('thinking', text) per delta and assembles
    the full reasoning_details array on the final message."""
    frames = [
        {
            "choices": [{"delta": {"reasoning_details": [
                {"type": "reasoning.text", "text": "thinking ", "id": "r1", "format": "anthropic-claude-v1", "index": 0}
            ]}}]
        },
        {
            "choices": [{"delta": {"reasoning_details": [
                {"type": "reasoning.text", "text": "out loud", "id": "r1", "format": "anthropic-claude-v1", "index": 0}
            ]}}]
        },
        {"choices": [{"delta": {"content": "okay."}}]},
        "[DONE]",
    ]

    events = list(orch_agent._parse_sse_chunks(iter(_sse_lines(*frames))))
    kinds = [k for k, _ in events]
    assert kinds == ["thinking", "thinking", "text", "done"]

    thinks = [p for k, p in events if k == "thinking"]
    assert thinks == ["thinking ", "out loud"]

    text_payload = [p for k, p in events if k == "text"]
    assert text_payload == ["okay."]

    _, done_payload = events[-1]
    msg = done_payload["message"]
    assert msg["content"] == "okay."
    rds = msg["reasoning_details"]
    assert len(rds) == 1
    assert rds[0]["text"] == "thinking out loud"
    assert rds[0]["id"] == "r1"
    assert rds[0]["format"] == "anthropic-claude-v1"


def test_history_messages_echoes_reasoning_details_back(db, workflow):
    """Persisted assistant rows must surface their reasoning_details when we
    rebuild OpenRouter chat history — Anthropic enforces ordering of the
    blocks across turns when tools are involved."""
    sess = models.Session(workflow_id=workflow.id)
    db.add(sess)
    db.commit()
    db.refresh(sess)

    rds = [{"type": "reasoning.text", "text": "thought", "id": "r1", "format": "anthropic-claude-v1"}]
    db.add(models.Message(session_id=sess.id, role="user", content="go"))
    db.add(
        models.Message(
            session_id=sess.id,
            role="assistant",
            content="ok",
            tool_calls=[{"id": "tc_1", "type": "function", "function": {"name": "add_node", "arguments": "{}"}}],
            reasoning_details=rds,
        )
    )
    db.commit()

    history = orch_agent._history_messages(db, sess.id)
    # find the assistant entry
    asst = next(m for m in history if m.get("role") == "assistant")
    assert asst.get("reasoning_details") == rds


def test_history_messages_drops_pointer_only_reasoning_blocks(db, workflow):
    """Reasoning blocks that are pure server-side pointers (e.g. OpenAI
    Responses ``rs_…`` ids with no inline text/data/signature) must be
    stripped from the echoed history — the provider rejects them on the
    next turn because items aren't persisted when ``store`` is false."""
    sess = models.Session(workflow_id=workflow.id)
    db.add(sess)
    db.commit()
    db.refresh(sess)

    rds = [
        # Self-contained Anthropic-style block — keep.
        {"type": "reasoning.text", "text": "thought", "id": "r1", "format": "anthropic-claude-v1"},
        # Pure server-side pointer — drop.
        {"type": "reasoning", "id": "rs_0c6428aaf15427270169feb1f299d48197b4ab4f8b3510a417"},
    ]
    db.add(models.Message(session_id=sess.id, role="user", content="go"))
    db.add(
        models.Message(
            session_id=sess.id,
            role="assistant",
            content="ok",
            reasoning_details=rds,
        )
    )
    db.commit()

    history = orch_agent._history_messages(db, sess.id)
    asst = next(m for m in history if m.get("role") == "assistant")
    assert asst.get("reasoning_details") == [rds[0]]


def test_history_messages_omits_reasoning_when_all_blocks_are_pointers(db, workflow):
    """If every reasoning block is a non-portable pointer, the echoed
    assistant message should carry no ``reasoning_details`` field at all."""
    sess = models.Session(workflow_id=workflow.id)
    db.add(sess)
    db.commit()
    db.refresh(sess)

    db.add(models.Message(session_id=sess.id, role="user", content="go"))
    db.add(
        models.Message(
            session_id=sess.id,
            role="assistant",
            content="ok",
            reasoning_details=[{"type": "reasoning", "id": "rs_abc"}],
        )
    )
    db.commit()

    history = orch_agent._history_messages(db, sess.id)
    asst = next(m for m in history if m.get("role") == "assistant")
    assert "reasoning_details" not in asst


def test_render_history_surfaces_thinking_block(db, workflow):
    """A persisted reasoning_details array should render as a thinking
    ChatBlock at the top of the assistant bubble."""
    sess = models.Session(workflow_id=workflow.id)
    db.add(sess)
    db.commit()
    db.refresh(sess)

    db.add(models.Message(session_id=sess.id, role="user", content="go"))
    db.add(
        models.Message(
            session_id=sess.id,
            role="assistant",
            content="here you go.",
            reasoning_details=[
                {"type": "reasoning.text", "text": "consider the inputs", "id": "r1"},
                {"type": "reasoning.text", "text": "then the outputs", "id": "r2"},
            ],
        )
    )
    db.commit()

    bubbles = orch_agent.render_history(db, sess.id)
    assistant = bubbles[1]
    assert assistant["role"] == "assistant"
    blocks = assistant["content"]
    # thinking comes first, paragraph after
    assert blocks[0]["t"] == "thinking"
    assert "consider the inputs" in blocks[0]["text"]
    assert "then the outputs" in blocks[0]["text"]
    assert blocks[1]["t"] == "p"
    assert blocks[1]["text"] == "here you go."
