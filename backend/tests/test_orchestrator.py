"""Unit tests for the orchestrator tool surface. No API keys / no LLM calls."""
from __future__ import annotations
import json
import threading

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app import models
from app.orchestrator import tools as orch_tools
from app.orchestrator import agent as orch_agent
from app.orchestrator.prompt import (
    SYSTEM_PROMPT,
    graph_state_message,
)


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
    assert n.config["tools_enabled"] == []
    assert "timeout_s" not in n.config


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
        tools_enabled=["fetch"],
    )
    n = db.get(models.Node, nid)
    assert n.name == "new"
    assert n.description == "patched"
    assert n.config["model"] == "anthropic/claude-sonnet-4.5"
    assert n.config["tools_enabled"] == ["fetch"]
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
    }


# ---------------------------------------------------------------------------
# graph state snapshot — code is intentionally omitted (orchestrator pulls it
# on demand via view_node_details). The user_edited flag stays.
# ---------------------------------------------------------------------------


def test_graph_state_omits_code_but_keeps_user_edited_flag(db, workflow):
    nid = orch_tools.add_node(
        db,
        workflow.id,
        name="loader",
        code="def run(inputs, ctx):\n    return {'x': 1}\n",
    )["node_id"]

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
        code=long_code,
        model="anthropic/claude-sonnet-4.5",
        tools_enabled=["shell"],
    )["node_id"]

    res = orch_tools.view_node_details(db, workflow.id, node_id=nid)
    assert res["id"] == nid
    assert res["name"] == "big"
    assert res["description"] == "huge node"
    # Full code returned, no truncation marker.
    assert res["code"] == long_code
    assert "<truncated" not in res["code"]
    assert res["config"]["model"] == "anthropic/claude-sonnet-4.5"
    assert res["config"]["tools_enabled"] == ["shell"]
    assert "timeout_s" not in res["config"]
    assert res["user_edited"] is False
    assert res["user_edited_at"] is None


def test_view_node_details_unknown_node_errors(db, workflow):
    res = orch_tools.execute(
        db, workflow.id, "view_node_details", {"node_id": "does-not-exist"}
    )
    assert "error" in res
    assert "not found" in res["error"]


def test_view_tools_work_during_active_run(db, workflow):
    """Read-only tools must NOT be blocked by the run-in-progress lock."""
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


def test_read_only_tools_set_matches_registry():
    # Belt-and-braces: the named-set has to match what's actually safe to call.
    assert orch_tools.READ_ONLY_TOOLS == {"view_graph", "view_node_details"}
    for name in orch_tools.READ_ONLY_TOOLS:
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


def test_system_prompt_forbids_direct_ctx_tools_calls():
    """Tools are LLM-mediated only — generated node code must route every
    tool invocation through `call_llm(tools=[...])`, never as a standalone
    `ctx.tools.X(...)` line."""
    lower = SYSTEM_PROMPT.lower()
    # The rule must be present and decisive.
    assert "ctx.tools" in lower
    assert "never" in lower
    # And the orchestrator must be told that tools live in call_llm's tools list.
    assert "tools=[...]" in SYSTEM_PROMPT or "tools=[" in SYSTEM_PROMPT


def test_system_prompt_distinguishes_orchestrator_vs_node_tools():
    """The prompt must teach the orchestrator that there are two kinds of
    tool: ones it invokes directly (graph mutators) and ones it *equips
    nodes with* (shell/fetch/web_search). The framing is constructive — the
    orchestrator has agency over both — but the categories are distinct.
    """
    p = SYSTEM_PROMPT
    lower = p.lower()
    # The graph-shaping tools belong to the orchestrator.
    assert "your tools" in lower
    # Node-runtime tools are talked about as something nodes get *equipped*
    # with, not something the orchestrator calls directly.
    assert "equip" in lower
    assert "tools_enabled" in lower
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
