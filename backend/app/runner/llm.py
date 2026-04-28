"""call_llm — single function over OpenRouter with optional tool-calling agent loop."""
from __future__ import annotations
import json
import os
import httpx

from app.runner.tools import REGISTRY, TOOL_SCHEMAS

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


def call_llm(
    model: str,
    prompt,
    tools: list[str] | None = None,
    max_turns: int = 8,
    **opts,
) -> dict:
    """
    Call an LLM via OpenRouter.

    Args:
        model:    OpenRouter model id (e.g. "anthropic/claude-sonnet-4.5").
        prompt:   str or list of messages [{role, content}].
        tools:    list of tool names exposed to the LLM (subset of REGISTRY keys).
        max_turns: cap on agent-loop turns when tools are provided.
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

    with httpx.Client(timeout=None) as client:
        for _turn in range(max_turns):
            payload: dict = {
                "model": model,
                "messages": messages,
                # Opt into OpenRouter's cost accounting — without this,
                # `usage.cost` is omitted and every reported cost is $0.
                "usage": {"include": True},
            }
            if tool_schemas:
                payload["tools"] = tool_schemas
            for k, v in opts.items():
                payload[k] = v

            r = client.post(OPENROUTER_URL, headers=headers, json=payload)
            if r.status_code >= 400:
                raise RuntimeError(f"OpenRouter {r.status_code}: {r.text[:500]}")
            data = r.json()

            usage = data.get("usage") or {}
            total_usage["prompt_tokens"] += usage.get("prompt_tokens", 0) or 0
            total_usage["completion_tokens"] += usage.get("completion_tokens", 0) or 0
            cost = (usage.get("cost") or 0.0) if isinstance(usage, dict) else 0.0
            total_cost += float(cost or 0.0)

            choice = data["choices"][0]
            msg = choice.get("message") or {}
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

            for tc in tcs:
                fn_name = tc.get("function", {}).get("name", "")
                try:
                    fn_args = json.loads(tc.get("function", {}).get("arguments") or "{}")
                except Exception:
                    fn_args = {}
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

    return {
        "content": "[max turns reached]",
        "messages": messages,
        "tool_calls_made": tool_calls_made,
        "usage": total_usage,
        "cost": total_cost,
    }
