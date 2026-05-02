"""Child subprocess entrypoint.

Reads workflow JSON from stdin, executes nodes as soon as all of their inputs
are ready (concurrent across independent branches), and emits structured
JSON-line events to stdout as work progresses. Any node error cancels the
whole run.

Event types (all on a single line, JSON):

  {"type": "run_started",  "node_count": N, "order": [...]}
  {"type": "node_started", "node_id": "...", "inputs": {...}}
  {"type": "log",          "node_id": "...", "msg": "..."}
  {"type": "llm_call_started",  "node_id": "...", "call_id": "...", "model": "...", "tools": [...]}
  {"type": "llm_round_started", "node_id": "...", "call_id": "...", "round": N}
  {"type": "llm_call_chunk",    "node_id": "...", "call_id": "...", "round": N,
                                "kind": "content"|"reasoning"|"tool_args",
                                "delta": "...", "tc_index"?: N, "tool"?: "..."}
  {"type": "llm_call_finished", "node_id": "...", "call_id": "...", "model": "...",
                                "content": "...", "usage": {...}, "cost": 0.0}
  {"type": "tool_call_started",  "node_id": "...", "tool": "...", "args": {...},
                                 "via": "direct"|"llm",
                                 "call_id"?: "...", "tc_index"?: N, "round"?: N}
  {"type": "tool_call_finished", "node_id": "...", "tool": "...", "args": {...},
                                 "result": ..., "via": ...,
                                 "call_id"?: "...", "tc_index"?: N, "round"?: N}
  {"type": "node_finished", "node_id": "...", "status": "...", "inputs": {...}, "outputs": {...},
                            "logs": [...], "llm_calls": [...], "tool_calls": [...],
                            "error": null|"...", "duration_ms": N, "cost": 0.0}
  {"type": "run_finished",  "status": "...", "outputs": {...}, "error": null|"...", "total_cost": 0.0}

A node may invoke ``ctx.call_llm`` from multiple threads concurrently; each
invocation gets its own ``call_id`` and the stdout write below is locked so
the per-line JSON frames don't get interleaved.
"""
from __future__ import annotations
import json
import os
import signal
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, FIRST_COMPLETED, wait
from pathlib import Path


_emit_lock = threading.Lock()


def _emit(event: dict) -> None:
    line = json.dumps(event, default=str) + "\n"
    with _emit_lock:
        sys.stdout.write(line)
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

    successors: dict[str, set[str]] = {nid: set() for nid in nodes_by_id}
    remaining: dict[str, int] = {nid: 0 for nid in nodes_by_id}
    seen_pairs: set[tuple[str, str]] = set()
    for e in edges:
        f, t = e["from_node_id"], e["to_node_id"]
        if f in nodes_by_id and t in nodes_by_id and (f, t) not in seen_pairs:
            seen_pairs.add((f, t))
            successors[f].add(t)
            remaining[t] += 1

    _emit({"type": "run_started", "node_count": len(order), "order": order})

    node_outputs: dict[str, dict] = {}
    state_lock = threading.Lock()
    terminate_event = threading.Event()
    shared: dict = {"error": None, "cancel_reason": None, "total_cost": 0.0}

    def _run_node(node_id: str) -> None:
        if terminate_event.is_set():
            return

        node = nodes_by_id[node_id]
        input_ports = node.get("inputs") or []
        output_ports = node.get("outputs") or []
        config = node.get("config") or {}
        node_model = config.get("model") or default_model

        if node_id == input_node_id:
            node_inputs: dict = dict(user_inputs)
        else:
            node_inputs = {p["name"]: None for p in input_ports}
            with state_lock:
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
            with state_lock:
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
            return

        _emit({"type": "node_started", "node_id": node_id, "inputs": node_inputs})

        def _on_event(ev: dict, _nid: str = node_id) -> None:
            ev_payload = dict(ev)
            ev_payload.setdefault("node_id", _nid)
            _emit(ev_payload)

        ctx = Ctx(
            workdir=workdir,
            default_model=node_model,
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

            cost = sum(float(c.get("cost", 0.0) or 0.0) for c in ctx.llm_calls)
            with state_lock:
                node_outputs[node_id] = normalized
                shared["total_cost"] += cost
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
        except Exception as e:
            err = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
            null_out = {p["name"]: None for p in output_ports}
            cost = sum(float(c.get("cost", 0.0) or 0.0) for c in ctx.llm_calls)
            with state_lock:
                node_outputs[node_id] = null_out
                shared["total_cost"] += cost
                if shared["error"] is None:
                    shared["error"] = err
            terminate_event.set()
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

    max_workers = max(1, len(order))
    pool = ThreadPoolExecutor(max_workers=max_workers)
    in_flight: dict = {}

    try:
        for nid in order:
            if remaining[nid] == 0:
                in_flight[pool.submit(_run_node, nid)] = nid

        while in_flight:
            done, _ = wait(list(in_flight.keys()), return_when=FIRST_COMPLETED)
            for fut in done:
                finished_id = in_flight.pop(fut)
                exc = fut.exception()
                if exc is not None:
                    if shared["error"] is None:
                        shared["error"] = f"{type(exc).__name__}: {exc}"
                    terminate_event.set()
                    continue
                if terminate_event.is_set():
                    continue
                for s in successors[finished_id]:
                    remaining[s] -= 1
                    if remaining[s] == 0:
                        in_flight[pool.submit(_run_node, s)] = s
    except KeyboardInterrupt:
        shared["cancel_reason"] = "cancelled by user"
        terminate_event.set()

    cancelled = shared["cancel_reason"] is not None
    # On cancel, don't wait for in-flight node threads — they may be blocked
    # in `ctx.call_llm` (httpx with no timeout, deliberately, so streams don't
    # truncate). Python signals are delivered to the main thread only, so a
    # node thread won't see SIGTERM. Waiting here means the user has to click
    # cancel a second time to deliver another SIGTERM that finally kills the
    # process. Skip the wait and forcibly exit below.
    pool.shutdown(wait=not cancelled, cancel_futures=cancelled)

    final_outputs = node_outputs.get(output_node_id, {}) if output_node_id else {}

    if cancelled:
        _emit(
            {
                "type": "run_finished",
                "status": "cancelled",
                "error": shared["cancel_reason"],
                "outputs": final_outputs,
                "total_cost": shared["total_cost"],
            }
        )
        # Force-exit — any node thread still blocked in an LLM stream would
        # otherwise keep this subprocess alive and the parent would never see
        # EOF on stdout. _exit skips finalizers but stdout was just flushed
        # by _emit so the parent has the cancelled event in hand.
        os._exit(0)

    if shared["error"] is not None:
        _emit(
            {
                "type": "run_finished",
                "status": "error",
                "error": shared["error"],
                "outputs": final_outputs,
                "total_cost": shared["total_cost"],
            }
        )
        return

    _emit(
        {
            "type": "run_finished",
            "status": "success",
            "error": None,
            "outputs": final_outputs,
            "total_cost": shared["total_cost"],
        }
    )


if __name__ == "__main__":
    main()
