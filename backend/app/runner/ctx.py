"""Ctx object injected into every node's `run(inputs, ctx)` call.

The runner can pass an `on_event` callback that fires for log lines, LLM calls,
and tool invocations as they happen — used to stream events through the
subprocess to the websocket layer.
"""
from __future__ import annotations
from pathlib import Path
from typing import Callable

from app.runner.tools import REGISTRY
from app.runner import llm as llm_mod


EmitFn = Callable[[dict], None]


class _ToolsProxy:
    """Direct (non-LLM) access: ctx.tools.shell(command="..."), etc."""

    def __init__(self, recorder: list[dict], on_event: EmitFn):
        self._recorder = recorder
        self._on_event = on_event

    def __getattr__(self, name: str):
        fn = REGISTRY.get(name)
        if fn is None:
            raise AttributeError(f"no tool '{name}' in registry")

        def wrapped(**kwargs):
            self._on_event({"type": "tool_call_started", "tool": name, "args": kwargs, "via": "direct"})
            entry: dict = {"name": name, "args": kwargs, "via": "direct"}
            try:
                result = fn(**kwargs)
                entry["result"] = result
                self._recorder.append(entry)
                self._on_event(
                    {
                        "type": "tool_call_finished",
                        "tool": name,
                        "args": kwargs,
                        "result": result,
                        "via": "direct",
                    }
                )
                return result
            except Exception as e:
                err = f"{type(e).__name__}: {e}"
                entry["error"] = err
                self._recorder.append(entry)
                self._on_event(
                    {
                        "type": "tool_call_finished",
                        "tool": name,
                        "args": kwargs,
                        "error": err,
                        "via": "direct",
                    }
                )
                raise

        return wrapped


class Ctx:
    def __init__(
        self,
        workdir: Path,
        default_model: str,
        allowed_tools: list[str] | None = None,
        on_event: EmitFn | None = None,
    ):
        self.workdir = workdir
        self._default_model = default_model
        self._allowed_tools = allowed_tools  # None = all tools allowed
        self._on_event: EmitFn = on_event or (lambda ev: None)
        self.logs: list[str] = []
        self.llm_calls: list[dict] = []
        self.tool_calls: list[dict] = []
        self.tools = _ToolsProxy(self.tool_calls, self._on_event)

    def log(self, msg) -> None:
        s = str(msg)
        self.logs.append(s)
        self._on_event({"type": "log", "msg": s})

    def call_llm(self, model: str | None = None, prompt=None, tools=None, **opts) -> dict:
        m = model or self._default_model
        if not m:
            raise RuntimeError("call_llm: no model specified and no default configured")
        if self._allowed_tools is not None and tools:
            tools = [t for t in tools if t in self._allowed_tools]

        self._on_event({"type": "llm_call_started", "model": m, "tools": tools or []})
        result = llm_mod.call_llm(m, prompt, tools=tools, **opts)

        record = {
            "model": m,
            "prompt": prompt if isinstance(prompt, str) else "<messages>",
            "tools": tools or [],
            "content": result.get("content", ""),
            "tool_calls_made": result.get("tool_calls_made", []),
            "usage": result.get("usage", {}),
            "cost": result.get("cost", 0.0),
        }
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
                    "type": "tool_call_finished",
                    "tool": tc.get("name"),
                    "args": tc.get("args"),
                    "result": tc.get("result"),
                    "via": "llm",
                }
            )

        self._on_event(
            {
                "type": "llm_call_finished",
                "model": m,
                "content": record["content"],
                "usage": record["usage"],
                "cost": record["cost"],
            }
        )
        return result
