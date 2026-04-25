"""Smoke tests for the workflow runner. No API keys required (no call_llm in tests)."""
from __future__ import annotations

from app.runner.runner import run_workflow_sync, topo_sort


def make_node(nid, code, inputs=None, outputs=None):
    return {
        "id": nid,
        "name": nid,
        "code": code,
        "inputs": inputs or [],
        "outputs": outputs or [],
        "config": {},
    }


def test_topo_sort_linear():
    nodes = [{"id": "a"}, {"id": "b"}, {"id": "c"}]
    edges = [
        {"from_node_id": "a", "to_node_id": "b", "from_output": "x", "to_input": "y"},
        {"from_node_id": "b", "to_node_id": "c", "from_output": "x", "to_input": "y"},
    ]
    assert topo_sort(nodes, edges) == ["a", "b", "c"]


def test_topo_sort_cycle_raises():
    nodes = [{"id": "a"}, {"id": "b"}]
    edges = [
        {"from_node_id": "a", "to_node_id": "b", "from_output": "x", "to_input": "y"},
        {"from_node_id": "b", "to_node_id": "a", "from_output": "x", "to_input": "y"},
    ]
    try:
        topo_sort(nodes, edges)
    except ValueError:
        return
    raise AssertionError("expected ValueError on cycle")


def test_linear_run():
    wf = {
        "id": "wf",
        "input_node_id": "a",
        "output_node_id": "b",
        "nodes": [
            make_node(
                "a",
                "def run(inputs, ctx):\n    return {'val': inputs['x'] * 2}\n",
                inputs=[{"name": "x", "required": True, "type_hint": "int"}],
                outputs=[{"name": "val", "type_hint": "int"}],
            ),
            make_node(
                "b",
                "def run(inputs, ctx):\n    return {'final': inputs['v'] + 1}\n",
                inputs=[{"name": "v", "required": True, "type_hint": "int"}],
                outputs=[{"name": "final", "type_hint": "int"}],
            ),
        ],
        "edges": [
            {"from_node_id": "a", "from_output": "val", "to_node_id": "b", "to_input": "v"},
        ],
    }
    result = run_workflow_sync(wf, {"x": 5})
    assert result["status"] == "success", result
    assert result["outputs"]["final"] == 11


def test_skip_propagation_through_null_branch():
    """Node a emits {pass: 'hi', fail: None}. Branch via fail→b→c should skip; c gets null."""
    wf = {
        "id": "wf",
        "input_node_id": "a",
        "output_node_id": "c",
        "nodes": [
            make_node(
                "a",
                "def run(inputs, ctx):\n    return {'pass': inputs.get('x'), 'fail': None}\n",
                inputs=[{"name": "x", "required": False}],
                outputs=[{"name": "pass"}, {"name": "fail"}],
            ),
            make_node(
                "b",
                "def run(inputs, ctx):\n    return {'out': inputs['v'] + '!'}\n",
                inputs=[{"name": "v", "required": True}],
                outputs=[{"name": "out"}],
            ),
            make_node(
                "c",
                "def run(inputs, ctx):\n    return {'out': inputs.get('v')}\n",
                inputs=[{"name": "v", "required": False}],
                outputs=[{"name": "out"}],
            ),
        ],
        "edges": [
            {"from_node_id": "a", "from_output": "fail", "to_node_id": "b", "to_input": "v"},
            {"from_node_id": "b", "from_output": "out", "to_node_id": "c", "to_input": "v"},
        ],
    }
    result = run_workflow_sync(wf, {"x": "hello"})
    assert result["status"] == "success", result
    nrs = {nr["node_id"]: nr for nr in result["node_runs"]}
    assert nrs["a"]["status"] == "success"
    assert nrs["b"]["status"] == "skipped"
    assert nrs["c"]["status"] == "success"
    assert nrs["c"]["outputs"]["out"] is None


def test_error_in_node():
    wf = {
        "id": "wf",
        "input_node_id": "a",
        "output_node_id": "a",
        "nodes": [
            make_node(
                "a",
                "def run(inputs, ctx):\n    raise ValueError('boom')\n",
                inputs=[],
                outputs=[{"name": "out"}],
            ),
        ],
        "edges": [],
    }
    result = run_workflow_sync(wf, {})
    assert result["status"] == "error"
    assert "boom" in (result["error"] or "")


def test_ctx_log_and_direct_tool_call():
    code = """
def run(inputs, ctx):
    ctx.log("hello")
    out = ctx.tools.shell(command="echo world")
    return {"stdout": out["stdout"].strip()}
"""
    wf = {
        "id": "wf",
        "input_node_id": "a",
        "output_node_id": "a",
        "nodes": [make_node("a", code, inputs=[], outputs=[{"name": "stdout"}])],
        "edges": [],
    }
    result = run_workflow_sync(wf, {})
    assert result["status"] == "success", result
    assert result["outputs"]["stdout"] == "world"
    nr = result["node_runs"][0]
    assert "hello" in nr["logs"]
    assert any(tc["name"] == "shell" for tc in nr["tool_calls"])
