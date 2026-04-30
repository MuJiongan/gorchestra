"""call_llm — single function over OpenRouter with optional tool-calling agent loop.

When an ``on_event`` callback is provided, the call streams the response from
OpenRouter and emits per-token events tagged with ``call_id`` so the run panel
can render live content/reasoning/tool-arg deltas. Multiple ``ctx.call_llm``
invocations within the same node are disambiguated by their ``call_id``.

Without ``on_event`` it falls back to a non-streaming POST — kept for any
caller that doesn't need live progress.
"""
from __future__ import annotations
import itertools
import json
import os
from typing import Callable, Iterator
import httpx

from app.runner.tools import REGISTRY, TOOL_SCHEMAS

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


def _parse_sse_lines(lines: Iterator[str]) -> Iterator[tuple]:
    """Parse OpenRouter-compatible SSE chat-completion deltas.

    Yields:
      ("text", delta_str)
      ("thinking", delta_str)
      ("tool_args", tc_index, name_so_far, args_delta)
      ("done", {"message": full_msg, "usage": usage_dict})

    The final ``message`` includes any assembled ``tool_calls`` so the agent
    loop can execute them.
    """
    content_parts: list[str] = []
    tool_calls_by_index: dict[int, dict] = {}
    usage: dict = {}

    for line in lines:
        if not line:
            continue
        if not line.startswith("data:"):
            continue
        data_str = line[len("data:"):].strip()
        if data_str == "[DONE]":
            break
        try:
            chunk = json.loads(data_str)
        except Exception:
            continue

        u = chunk.get("usage")
        if u:
            usage = u

        choices = chunk.get("choices") or []
        if not choices:
            continue
        delta = choices[0].get("delta") or {}

        # Reasoning — structured deltas first, flat string fallback.
        rds = delta.get("reasoning_details") or []
        for rd in rds:
            t = rd.get("text") or ""
            if t:
                yield ("thinking", t)
        if not rds:
            r = delta.get("reasoning")
            if r:
                yield ("thinking", r)

        # Visible content.
        c = delta.get("content")
        if c:
            content_parts.append(c)
            yield ("text", c)

        # Tool calls — assemble per-index, stream argument deltas live.
        for tc_delta in (delta.get("tool_calls") or []):
            idx = tc_delta.get("index", 0)
            cur = tool_calls_by_index.setdefault(
                idx,
                {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
            )
            if tc_delta.get("id"):
                cur["id"] = tc_delta["id"]
            if tc_delta.get("type"):
                cur["type"] = tc_delta["type"]
            fn_delta = tc_delta.get("function") or {}
            if fn_delta.get("name"):
                cur["function"]["name"] = fn_delta["name"]
            args_delta = fn_delta.get("arguments")
            if args_delta is not None:
                cur["function"]["arguments"] += args_delta
                if args_delta:
                    yield ("tool_args", idx, cur["function"]["name"], args_delta)

    full_content = "".join(content_parts)
    tool_calls = (
        [tool_calls_by_index[i] for i in sorted(tool_calls_by_index.keys())]
        if tool_calls_by_index
        else []
    )
    msg: dict = {"role": "assistant", "content": full_content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    yield ("done", {"message": msg, "usage": usage})


def call_llm(
    model: str,
    prompt,
    tools: list[str] | None = None,
    on_event: Callable[[dict], None] | None = None,
    call_id: str | None = None,
    **opts,
) -> dict:
    """
    Call an LLM via OpenRouter.

    Args:
        model:    OpenRouter model id (e.g. "anthropic/claude-sonnet-4.5").
        prompt:   str or list of messages [{role, content}].
        tools:    list of tool names exposed to the LLM (subset of REGISTRY keys).
        on_event: optional callback for streaming events. When provided, the
                  call streams from OpenRouter and emits ``llm_call_chunk`` and
                  ``tool_call_started``/``tool_call_finished`` events tagged
                  with ``call_id``.
        call_id:  unique id for this call, included on every emitted event so
                  concurrent calls within one node can be disambiguated.
        **opts:   forwarded as additional fields in the OpenRouter request body.

    Returns:
        {content, messages, tool_calls_made, usage, cost}
    """
    api_key = os.getenv("OPENROUTER_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY not set")

    if isinstance(prompt, str):
        messages: list[dict] = [{"role": "user", "content": prompt}]
    else:
        messages = list(prompt)

    tools = tools or []
    tool_schemas = [TOOL_SCHEMAS[t] for t in tools if t in TOOL_SCHEMAS]

    tool_calls_made: list[dict] = []
    total_cost = 0.0
    total_usage = {"prompt_tokens": 0, "completion_tokens": 0}

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    streaming = on_event is not None

    def _emit(ev: dict) -> None:
        if on_event is None:
            return
        if call_id is not None and "call_id" not in ev:
            ev = {**ev, "call_id": call_id}
        on_event(ev)

    with httpx.Client(timeout=None) as client:
        # No turn cap — the agent loop runs until the LLM produces a final
        # message with no tool calls. A node code that hangs is the user's
        # cancel button to address; matches the orchestrator runtime model
        # (see app/runner/child.py for the SIGTERM → KeyboardInterrupt path).
        for round_idx in itertools.count():
            payload: dict = {
                "model": model,
                "messages": messages,
                # Opt into OpenRouter's cost accounting — without this,
                # `usage.cost` is omitted and every reported cost is $0.
                "usage": {"include": True},
            }
            if tool_schemas:
                payload["tools"] = tool_schemas
            if streaming:
                payload["stream"] = True
            for k, v in opts.items():
                payload[k] = v

            if streaming:
                _emit({"type": "llm_round_started", "round": round_idx})
                assembled_msg: dict | None = None
                round_usage: dict = {}
                with client.stream(
                    "POST", OPENROUTER_URL, headers=headers, json=payload
                ) as r:
                    if r.status_code >= 400:
                        body = r.read().decode(errors="replace")[:500]
                        raise RuntimeError(f"OpenRouter {r.status_code}: {body}")
                    for item in _parse_sse_lines(r.iter_lines()):
                        kind = item[0]
                        if kind == "text":
                            _emit(
                                {
                                    "type": "llm_call_chunk",
                                    "kind": "content",
                                    "round": round_idx,
                                    "delta": item[1],
                                }
                            )
                        elif kind == "thinking":
                            _emit(
                                {
                                    "type": "llm_call_chunk",
                                    "kind": "reasoning",
                                    "round": round_idx,
                                    "delta": item[1],
                                }
                            )
                        elif kind == "tool_args":
                            _, tc_idx, tc_name, tc_delta = item
                            _emit(
                                {
                                    "type": "llm_call_chunk",
                                    "kind": "tool_args",
                                    "round": round_idx,
                                    "tc_index": tc_idx,
                                    "tool": tc_name,
                                    "delta": tc_delta,
                                }
                            )
                        elif kind == "done":
                            info = item[1]
                            assembled_msg = info["message"]
                            round_usage = info.get("usage") or {}
                            break
                if assembled_msg is None:
                    assembled_msg = {"role": "assistant", "content": ""}
                usage = round_usage
                msg = assembled_msg
            else:
                r = client.post(OPENROUTER_URL, headers=headers, json=payload)
                if r.status_code >= 400:
                    raise RuntimeError(f"OpenRouter {r.status_code}: {r.text[:500]}")
                data = r.json()
                usage = data.get("usage") or {}
                choice = data["choices"][0]
                msg = choice.get("message") or {}

            total_usage["prompt_tokens"] += usage.get("prompt_tokens", 0) or 0
            total_usage["completion_tokens"] += usage.get("completion_tokens", 0) or 0
            cost = (usage.get("cost") or 0.0) if isinstance(usage, dict) else 0.0
            total_cost += float(cost or 0.0)

            messages.append(msg)
            tcs = msg.get("tool_calls") or []
            if not tcs:
                return {
                    "content": msg.get("content", "") or "",
                    "messages": messages,
                    "tool_calls_made": tool_calls_made,
                    "usage": total_usage,
                    "cost": total_cost,
                }

            for tc_idx, tc in enumerate(tcs):
                fn_name = tc.get("function", {}).get("name", "")
                try:
                    fn_args = json.loads(tc.get("function", {}).get("arguments") or "{}")
                except Exception:
                    fn_args = {}
                _emit(
                    {
                        "type": "tool_call_started",
                        "tool": fn_name,
                        "args": fn_args,
                        "via": "llm",
                        "tc_index": tc_idx,
                        "round": round_idx,
                    }
                )
                fn = REGISTRY.get(fn_name)
                if fn is None:
                    result = {"error": f"unknown tool {fn_name}"}
                else:
                    try:
                        result = fn(**fn_args)
                    except Exception as e:
                        result = {"error": f"{type(e).__name__}: {e}"}
                tool_calls_made.append({"name": fn_name, "args": fn_args, "result": result})
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.get("id"),
                        "content": json.dumps(result, default=str),
                    }
                )
                _emit(
                    {
                        "type": "tool_call_finished",
                        "tool": fn_name,
                        "args": fn_args,
                        "result": result,
                        "via": "llm",
                        "tc_index": tc_idx,
                        "round": round_idx,
                    }
                )
