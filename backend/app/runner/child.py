"""Child subprocess entrypoint.

Reads workflow JSON from stdin, executes nodes in topo order applying the skip
rule, and emits structured JSON-line events to stdout as work progresses.

Event types (all on a single line, JSON):

  {"type": "run_started",  "node_count": N, "order": [...]}
  {"type": "node_started", "node_id": "...", "inputs": {...}}
  {"type": "log",          "node_id": "...", "msg": "..."}
  {"type": "llm_call_started",  "node_id": "...", "model": "...", "tools": [...]}
  {"type": "llm_call_finished", "node_id": "...", "model": "...", "content": "...", "usage": {...}, "cost": 0.0}
  {"type": "tool_call_started",  "node_id": "...", "tool": "...", "args": {...}, "via": "direct"|"llm"}
  {"type": "tool_call_finished", "node_id": "...", "tool": "...", "args": {...}, "result": ..., "via": ...}
  {"type": "node_finished", "node_id": "...", "status": "...", "inputs": {...}, "outputs": {...},
                            "logs": [...], "llm_calls": [...], "tool_calls": [...],
                            "error": null|"...", "duration_ms": N, "cost": 0.0}
  {"type": "run_finished",  "status": "...", "outputs": {...}, "error": null|"...", "total_cost": 0.0}
"""
from __future__ import annotations
import json
import os
import signal
import sys
import time
import traceback
from pathlib import Path


def _emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event, default=str) + "\n")
    sys.stdout.flush()


def _install_sigterm_handler() -> None:
    """Make SIGTERM raise KeyboardInterrupt so we can emit a clean cancelled event."""
    def _handler(signum, frame):
        raise KeyboardInterrupt("cancelled")
    try:
        signal.signal(signal.SIGTERM, _handler)
    except Exception:
        pass


def main() -> None:
    _install_sigterm_handler()
    raw = sys.stdin.read()
    payload = json.loads(raw)

    for k, v in (payload.get("env") or {}).items():
        if v:
            os.environ[k] = v

    from app.runner.runner import topo_sort
    from app.runner.ctx import Ctx

    workflow = payload["workflow"]
    user_inputs = payload.get("inputs") or {}
    default_model = payload.get("default_model") or ""
    workdir = Path(payload["workdir"])
    workdir.mkdir(parents=True, exist_ok=True)

    nodes = workflow.get("nodes") or []
    edges = workflow.get("edges") or []
    input_node_id = workflow.get("input_node_id")
    output_node_id = workflow.get("output_node_id")

    nodes_by_id = {n["id"]: n for n in nodes}
    incoming: dict[str, list[dict]] = {}
    for e in edges:
        incoming.setdefault(e["to_node_id"], []).append(e)

    try:
        order = topo_sort(nodes, edges)
    except Exception as e:
        _emit(
            {
                "type": "run_finished",
                "status": "error",
                "error": str(e),
                "outputs": {},
                "total_cost": 0.0,
            }
        )
        return

    _emit({"type": "run_started", "node_count": len(order), "order": order})

    node_outputs: dict[str, dict] = {}
    overall_status = "success"
    overall_error: str | None = None
    total_cost = 0.0

    try:
        for node_id in order:
            node = nodes_by_id[node_id]
            input_ports = node.get("inputs") or []
            output_ports = node.get("outputs") or []
            config = node.get("config") or {}
            node_model = config.get("model") or default_model
            allowed_tools = config.get("tools_enabled") or None

            if node_id == input_node_id:
                node_inputs: dict = dict(user_inputs)
            else:
                node_inputs = {p["name"]: None for p in input_ports}
                for e in incoming.get(node_id, []):
                    up = node_outputs.get(e["from_node_id"])
                    val = None if up is None else up.get(e["from_output"])
                    node_inputs[e["to_input"]] = val

            skip = any(
                p.get("required", True) and node_inputs.get(p["name"]) is None
                for p in input_ports
            )

            if skip:
                null_out = {p["name"]: None for p in output_ports}
                node_outputs[node_id] = null_out
                _emit(
                    {
                        "type": "node_finished",
                        "node_id": node_id,
                        "status": "skipped",
                        "inputs": node_inputs,
                        "outputs": null_out,
                        "logs": [],
                        "llm_calls": [],
                        "tool_calls": [],
                        "error": None,
                        "duration_ms": 0,
                        "cost": 0.0,
                    }
                )
                continue

            _emit({"type": "node_started", "node_id": node_id, "inputs": node_inputs})

            def _on_event(ev: dict, _nid: str = node_id) -> None:
                payload = dict(ev)
                payload.setdefault("node_id", _nid)
                _emit(payload)

            ctx = Ctx(
                workdir=workdir,
                default_model=node_model,
                allowed_tools=allowed_tools,
                on_event=_on_event,
            )
            start = time.time()
            try:
                ns: dict = {}
                exec(node.get("code") or "", ns, ns)
                run_fn = ns.get("run")
                if not callable(run_fn):
                    raise RuntimeError("node code must define `run(inputs, ctx)` function")
                result = run_fn(node_inputs, ctx)
                if not isinstance(result, dict):
                    raise RuntimeError(
                        f"node returned {type(result).__name__}, expected dict"
                    )

                if output_ports:
                    normalized = {p["name"]: result.get(p["name"]) for p in output_ports}
                else:
                    normalized = result

                node_outputs[node_id] = normalized
                cost = sum(float(c.get("cost", 0.0) or 0.0) for c in ctx.llm_calls)
                total_cost += cost
                _emit(
                    {
                        "type": "node_finished",
                        "node_id": node_id,
                        "status": "success",
                        "inputs": node_inputs,
                        "outputs": normalized,
                        "logs": ctx.logs,
                        "llm_calls": ctx.llm_calls,
                        "tool_calls": ctx.tool_calls,
                        "error": None,
                        "duration_ms": int((time.time() - start) * 1000),
                        "cost": cost,
                    }
                )
            except KeyboardInterrupt:
                # Cancellation propagates out so the outer except can emit run_finished.
                raise
            except Exception as e:
                err = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
                null_out = {p["name"]: None for p in output_ports}
                node_outputs[node_id] = null_out
                cost = sum(float(c.get("cost", 0.0) or 0.0) for c in ctx.llm_calls)
                total_cost += cost
                _emit(
                    {
                        "type": "node_finished",
                        "node_id": node_id,
                        "status": "error",
                        "inputs": node_inputs,
                        "outputs": null_out,
                        "logs": ctx.logs,
                        "llm_calls": ctx.llm_calls,
                        "tool_calls": ctx.tool_calls,
                        "error": err,
                        "duration_ms": int((time.time() - start) * 1000),
                        "cost": cost,
                    }
                )
                overall_status = "error"
                overall_error = err
    except KeyboardInterrupt:
        final_outputs = node_outputs.get(output_node_id, {}) if output_node_id else {}
        _emit(
            {
                "type": "run_finished",
                "status": "cancelled",
                "error": "cancelled by user",
                "outputs": final_outputs,
                "total_cost": total_cost,
            }
        )
        return

    final_outputs = node_outputs.get(output_node_id, {}) if output_node_id else {}
    _emit(
        {
            "type": "run_finished",
            "status": overall_status,
            "error": overall_error,
            "outputs": final_outputs,
            "total_cost": total_cost,
        }
    )


if __name__ == "__main__":
    main()
