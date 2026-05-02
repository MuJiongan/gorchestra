"""Ctx object injected into every node's `run(inputs, ctx)` call.

The runner can pass an `on_event` callback that fires for log lines, LLM calls,
and tool invocations as they happen — used to stream events through the
subprocess to the websocket layer.

Each ``ctx.call_llm`` invocation gets a unique ``call_id`` so the run panel can
render concurrent calls (a node spawning threads, each calling ``call_llm``)
as parallel streaming cards instead of mashing them together.
"""
from __future__ import annotations
import inspect
import itertools
import threading
from pathlib import Path
from typing import Callable

from app.runner.tools import REGISTRY
from app.runner import llm as llm_mod


EmitFn = Callable[[dict], None]


class _ToolsProxy:
    """Direct (non-LLM) access: ctx.tools.shell(command="..."), etc."""

    def __init__(self, recorder: list[dict], on_event: EmitFn, lock: threading.Lock):
        self._recorder = recorder
        self._on_event = on_event
        self._lock = lock
        # Each direct call gets a unique id so the run UI can match its
        # ``tool_call_started`` (pending state) to ``tool_call_finished``
        # (ok/err) instead of dumping everything into a flat list.
        self._call_counter = itertools.count(1)

    def __getattr__(self, name: str):
        fn = REGISTRY.get(name)
        if fn is None:
            raise AttributeError(f"no tool '{name}' in registry")

        sig = inspect.signature(fn)

        def wrapped(*args, **kwargs):
            # Normalise positional + keyword into a single dict keyed by the
            # tool's parameter names — keeps the event payload consistent
            # whether the caller wrote `ctx.tools.web_fetch(url)` or
            # `ctx.tools.web_fetch(url=url)`. Bind errors (missing required,
            # unexpected name) surface as TypeError, matching plain Python.
            bound = sig.bind(*args, **kwargs)
            bound.apply_defaults()
            call_args = dict(bound.arguments)
            tc_id = f"direct-{next(self._call_counter)}"

            self._on_event(
                {
                    "type": "tool_call_started",
                    "tool": name,
                    "args": call_args,
                    "via": "direct",
                    "call_id": tc_id,
                }
            )
            entry: dict = {"name": name, "args": call_args, "via": "direct"}
            try:
                result = fn(*args, **kwargs)
                entry["result"] = result
                with self._lock:
                    self._recorder.append(entry)
                self._on_event(
                    {
                        "type": "tool_call_finished",
                        "tool": name,
                        "args": call_args,
                        "result": result,
                        "via": "direct",
                        "call_id": tc_id,
                    }
                )
                return result
            except Exception as e:
                err = f"{type(e).__name__}: {e}"
                entry["error"] = err
                with self._lock:
                    self._recorder.append(entry)
                self._on_event(
                    {
                        "type": "tool_call_finished",
                        "tool": name,
                        "args": call_args,
                        "error": err,
                        "via": "direct",
                        "call_id": tc_id,
                    }
                )
                raise

        return wrapped


class Ctx:
    def __init__(
        self,
        workdir: Path,
        default_model: str,
        on_event: EmitFn | None = None,
    ):
        self.workdir = workdir
        self._default_model = default_model
        self._on_event: EmitFn = on_event or (lambda ev: None)
        self.logs: list[str] = []
        self.llm_calls: list[dict] = []
        self.tool_calls: list[dict] = []
        self._lock = threading.Lock()
        self._call_counter = itertools.count(1)
        self.tools = _ToolsProxy(self.tool_calls, self._on_event, self._lock)

    def _next_call_id(self) -> str:
        return f"call-{next(self._call_counter)}"

    def log(self, msg) -> None:
        s = str(msg)
        with self._lock:
            self.logs.append(s)
        self._on_event({"type": "log", "msg": s})

    def call_llm(self, model: str | None = None, prompt=None, tools=None, **opts) -> dict:
        m = model or self._default_model
        if not m:
            raise RuntimeError("call_llm: no model specified and no default configured")

        call_id = self._next_call_id()
        self._on_event(
            {
                "type": "llm_call_started",
                "call_id": call_id,
                "model": m,
                "tools": tools or [],
            }
        )
        try:
            result = llm_mod.call_llm(
                m,
                prompt,
                tools=tools,
                on_event=self._on_event,
                call_id=call_id,
                **opts,
            )
        except Exception as e:
            self._on_event(
                {
                    "type": "llm_call_finished",
                    "call_id": call_id,
                    "model": m,
                    "content": "",
                    "usage": {},
                    "cost": 0.0,
                    "error": f"{type(e).__name__}: {e}",
                }
            )
            raise

        record = {
            "call_id": call_id,
            "model": m,
            "prompt": prompt if isinstance(prompt, str) else "<messages>",
            "tools": tools or [],
            "content": result.get("content", ""),
            "tool_calls_made": result.get("tool_calls_made", []),
            "usage": result.get("usage", {}),
            "cost": result.get("cost", 0.0),
        }
        with self._lock:
            self.llm_calls.append(record)
            for tc in result.get("tool_calls_made", []):
                self.tool_calls.append(
                    {
                        "name": tc.get("name"),
                        "args": tc.get("args"),
                        "result": tc.get("result"),
                        "via": "llm",
                    }
                )

        self._on_event(
            {
                "type": "llm_call_finished",
                "call_id": call_id,
                "model": m,
                "content": record["content"],
                "usage": record["usage"],
                "cost": record["cost"],
            }
        )
        return result
