"""Orchestrator agent loop — runs one user-message turn and yields events.

The loop calls the LLM, executes any returned tool calls (graph mutations),
appends the results to the conversation, and repeats until the LLM stops
calling tools or hits a max-turns cap. Each significant step is yielded as an
event dict for the SSE handler to forward to the chat UI.
"""
from __future__ import annotations
import json
import os
import threading
from typing import Any, Iterator

import httpx
from sqlalchemy.orm import Session as DbSession

from app import models
from app.orchestrator import tools as orch_tools
from app.orchestrator.prompt import SYSTEM_PROMPT, graph_state_message


OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL_FALLBACK = "anthropic/claude-opus-4.7"
MAX_TURNS = 12

REASONING_EFFORT = "medium"


# ---------------------------------------------------------------------------
# per-session turn cancellation
# ---------------------------------------------------------------------------
# When a new user message arrives for a session that already has an in-flight
# turn, we want to stop the old one — both to free resources and (more
# importantly) to avoid burning OpenRouter credits on an answer the user no
# longer cares about. We track an Event per session: a new turn signals the
# previous turn's event, then installs its own.

_TURN_CANCEL_EVENTS: dict[str, threading.Event] = {}
_TURN_LOCK = threading.Lock()


def _claim_turn(session_id: str) -> threading.Event:
    """Signal any prior turn for this session to cancel, then return a fresh
    cancellation event for the new turn."""
    with _TURN_LOCK:
        old = _TURN_CANCEL_EVENTS.get(session_id)
        if old is not None:
            old.set()
        ev = threading.Event()
        _TURN_CANCEL_EVENTS[session_id] = ev
        return ev


def _release_turn(session_id: str, ev: threading.Event) -> None:
    """Drop the event from the registry once the turn has finished, but only
    if we still own it — a newer turn may have replaced it."""
    with _TURN_LOCK:
        cur = _TURN_CANCEL_EVENTS.get(session_id)
        if cur is ev:
            del _TURN_CANCEL_EVENTS[session_id]


def _signal_cancel(session_id: str) -> bool:
    """Externally signal the in-flight turn for this session to cancel.

    Unlike :func:`_claim_turn`, this does NOT replace the registry entry —
    it just sets the existing event. The running turn detects this via
    `_was_superseded` returning False (registry identity unchanged) and
    treats it as an explicit user cancel.

    Returns True if a turn was actively running and got the signal.
    """
    with _TURN_LOCK:
        ev = _TURN_CANCEL_EVENTS.get(session_id)
        if ev is None:
            return False
        ev.set()
        return True


def _was_superseded(session_id: str, my_event: threading.Event) -> bool:
    """True if some other turn replaced our event in the registry — i.e. the
    user sent a new message instead of clicking cancel."""
    with _TURN_LOCK:
        cur = _TURN_CANCEL_EVENTS.get(session_id)
        return cur is not None and cur is not my_event


# ---------------------------------------------------------------------------
# message persistence helpers
# ---------------------------------------------------------------------------


def _persist_user(db: DbSession, sid: str, text: str) -> models.Message:
    m = models.Message(session_id=sid, role="user", content=text)
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


def _persist_assistant(
    db: DbSession,
    sid: str,
    content: str,
    tool_calls: list[dict] | None,
    reasoning_details: list[dict] | None = None,
) -> models.Message:
    m = models.Message(
        session_id=sid,
        role="assistant",
        content=content or "",
        tool_calls=tool_calls or [],
        reasoning_details=reasoning_details or [],
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


def _persist_tool_result(
    db: DbSession,
    sid: str,
    tool_call_id: str,
    name: str,
    result: Any,
) -> models.Message:
    m = models.Message(
        session_id=sid,
        role="tool",
        content=json.dumps(result, default=str),
        tool_call_id=tool_call_id,
        name=name,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


def _history_messages(db: DbSession, sid: str) -> list[dict]:
    """Replay persisted messages back in OpenRouter chat shape."""
    rows = (
        db.query(models.Message)
        .filter_by(session_id=sid)
        .order_by(models.Message.ts.asc(), models.Message.id.asc())
        .all()
    )
    out: list[dict] = []
    for r in rows:
        if r.role == "tool":
            out.append(
                {
                    "role": "tool",
                    "tool_call_id": r.tool_call_id or "",
                    "name": r.name or "",
                    "content": r.content or "",
                }
            )
        elif r.role == "assistant":
            msg: dict = {"role": "assistant", "content": r.content or ""}
            if r.tool_calls:
                msg["tool_calls"] = r.tool_calls
            # Anthropic / OpenRouter require the original reasoning blocks to
            # be echoed back unmodified before any tool result message — they
            # enforce ordering of the assistant's content blocks across turns.
            if r.reasoning_details:
                msg["reasoning_details"] = r.reasoning_details
            out.append(msg)
        elif r.role == "user":
            out.append({"role": "user", "content": r.content or ""})
        elif r.role == "system":
            out.append({"role": "system", "content": r.content or ""})
    return out


# ---------------------------------------------------------------------------
# tool-call helpers
# ---------------------------------------------------------------------------


def _format_args_summary(args: dict) -> str:
    """A short, human-readable summary of a tool call's arguments for the chat
    panel (the full args go to the LLM regardless)."""
    parts: list[str] = []
    for k, v in (args or {}).items():
        if k == "code":
            n = (v or "").count("\n") + 1
            parts.append(f'code=<{n} lines>')
            continue
        if k == "description":
            short = (v or "").strip().splitlines()[0] if v else ""
            if len(short) > 40:
                short = short[:37] + "…"
            parts.append(f'description="{short}"')
            continue
        if isinstance(v, str):
            short = v if len(v) <= 40 else v[:37] + "…"
            parts.append(f'{k}="{short}"')
        elif isinstance(v, (list, tuple)):
            if not v:
                parts.append(f"{k}=[]")
            else:
                parts.append(f"{k}=[{len(v)}]")
        elif isinstance(v, dict):
            parts.append(f"{k}={{...}}")
        else:
            parts.append(f"{k}={v}")
    return ", ".join(parts)


# ---------------------------------------------------------------------------
# OpenRouter streaming call
# ---------------------------------------------------------------------------


def _parse_sse_chunks(lines: Iterator[str]) -> Iterator[tuple[str, Any]]:
    """Parse OpenAI/OpenRouter-compatible streaming SSE lines.

    Yields:
      ``("text", delta_str)`` for each visible text delta,
      ``("thinking", delta_str)`` for each reasoning text delta,
      ``("done", {"message": <full assistant msg>, "usage": <dict>})`` once
      the stream terminates (with ``data: [DONE]`` or natural EOF).

    The final assistant message includes ``reasoning_details`` (the full
    structured array we received) so callers can persist + echo it back on
    subsequent turns — Anthropic enforces ordering of these blocks.

    Pulled out as a pure generator over lines so it can be unit-tested without
    spinning up an HTTP server.
    """
    content_parts: list[str] = []
    # tool_calls arrive as deltas indexed by `index`; assemble each one piecewise.
    tool_calls_by_index: dict[int, dict] = {}
    # reasoning_details also arrive as a list of objects per-chunk. We keep
    # them in their final-position order. Multiple objects may share an `id`
    # and `type`; we concatenate `text` deltas onto the matching block, and
    # treat any new id/index as a fresh block.
    reasoning_blocks: list[dict] = []
    usage: dict = {}

    def _merge_reasoning(rd: dict) -> str:
        """Fold one streaming reasoning_details delta into reasoning_blocks.
        Returns the text portion of this delta (may be empty)."""
        delta_text = rd.get("text") or ""
        # Match by id when available, else by index, else append.
        rd_id = rd.get("id")
        rd_index = rd.get("index")
        target = None
        for b in reasoning_blocks:
            if rd_id and b.get("id") == rd_id:
                target = b
                break
            if rd_index is not None and b.get("index") == rd_index and not rd_id:
                target = b
                break
        if target is None:
            target = {
                "type": rd.get("type") or "reasoning.text",
                "text": "",
                "id": rd_id,
                "format": rd.get("format"),
                "index": rd_index,
            }
            # Drop None values to keep the block close to what the server sent.
            target = {k: v for k, v in target.items() if v is not None}
            reasoning_blocks.append(target)
        if delta_text:
            target["text"] = (target.get("text") or "") + delta_text
        # Carry through other metadata that may arrive on subsequent chunks.
        for k in ("signature", "format", "type"):
            v = rd.get(k)
            if v is not None:
                target[k] = v
        return delta_text

    for line in lines:
        if not line:
            continue
        # SSE frames may carry comments (`:` prefix) or `event:`/`id:` lines —
        # we only care about `data:`.
        if not line.startswith("data:"):
            continue
        data_str = line[len("data:"):].strip()
        if data_str == "[DONE]":
            break
        try:
            chunk = json.loads(data_str)
        except Exception:
            continue

        # OpenRouter sometimes piggybacks usage at the tail of the stream.
        u = chunk.get("usage")
        if u:
            usage = u

        choices = chunk.get("choices") or []
        if not choices:
            continue
        delta = choices[0].get("delta") or {}

        # Reasoning chunks. Some providers also surface a flat `reasoning`
        # text delta; we treat that as a fallback when no structured details
        # are provided.
        for rd in (delta.get("reasoning_details") or []):
            t = _merge_reasoning(rd)
            if t:
                yield ("thinking", t)
        if not delta.get("reasoning_details"):
            flat_reasoning = delta.get("reasoning")
            if flat_reasoning:
                _merge_reasoning({"type": "reasoning.text", "text": flat_reasoning})
                yield ("thinking", flat_reasoning)

        content_delta = delta.get("content")
        if content_delta:
            content_parts.append(content_delta)
            yield ("text", content_delta)

        for tc_delta in (delta.get("tool_calls") or []):
            idx = tc_delta.get("index", 0)
            cur = tool_calls_by_index.setdefault(
                idx,
                {
                    "id": "",
                    "type": "function",
                    "function": {"name": "", "arguments": ""},
                },
            )
            if tc_delta.get("id"):
                cur["id"] = tc_delta["id"]
            if tc_delta.get("type"):
                cur["type"] = tc_delta["type"]
            fn_delta = tc_delta.get("function") or {}
            if fn_delta.get("name"):
                cur["function"]["name"] = fn_delta["name"]
            if fn_delta.get("arguments") is not None:
                cur["function"]["arguments"] += fn_delta.get("arguments", "")

    full_content = "".join(content_parts)
    tool_calls = (
        [tool_calls_by_index[i] for i in sorted(tool_calls_by_index.keys())]
        if tool_calls_by_index
        else []
    )
    msg: dict = {"role": "assistant", "content": full_content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    if reasoning_blocks:
        msg["reasoning_details"] = reasoning_blocks
    yield ("done", {"message": msg, "usage": usage})


def _call_openrouter_stream(
    model: str,
    messages: list[dict],
    tool_specs: list[dict],
    cancel_event: threading.Event | None = None,
) -> Iterator[tuple[str, Any]]:
    """Open a streaming chat completion against OpenRouter and yield parsed
    chunks via :func:`_parse_sse_chunks`.

    If ``cancel_event`` is provided and gets set during streaming, the SSE
    read terminates between chunks and the parser emits a final ``done``
    with whatever partial text was assembled — letting the agent loop bail
    immediately instead of waiting for the LLM to finish."""
    api_key = os.getenv("OPENROUTER_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY not set")
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "messages": messages,
        "tools": tool_specs,
        "stream": True,
        "reasoning": {"effort": REASONING_EFFORT},
        # Opt into OpenRouter's cost accounting — without this, `usage.cost`
        # is omitted from the final stream chunk and orchestrator cost is $0.
        "usage": {"include": True},
    }
    with httpx.Client(timeout=None) as client:
        with client.stream("POST", OPENROUTER_URL, headers=headers, json=payload) as r:
            if r.status_code >= 400:
                body = r.read().decode(errors="replace")[:500]
                raise RuntimeError(f"OpenRouter {r.status_code}: {body}")

            def cancellable_lines():
                for line in r.iter_lines():
                    if cancel_event is not None and cancel_event.is_set():
                        return
                    yield line

            yield from _parse_sse_chunks(cancellable_lines())


# ---------------------------------------------------------------------------
# agent loop
# ---------------------------------------------------------------------------


def _resolve_model(db: DbSession) -> str:
    # localStorage (forwarded as a header by the frontend, applied to env in
    # main.middleware) wins; the DB row is only a backwards-compat fallback.
    env_val = os.getenv("DEFAULT_ORCHESTRATOR_MODEL", "")
    if env_val:
        return env_val
    s = db.query(models.Setting).filter_by(key="default_orchestrator_model").first()
    if s and s.value:
        return s.value
    return DEFAULT_MODEL_FALLBACK


def run_turn(db: DbSession, session_id: str, user_text: str) -> Iterator[dict]:
    """Run one user-message turn end-to-end. Yields event dicts:

      {kind: "user_message",            ...}    — echo of the persisted user msg
      {kind: "assistant_thinking_chunk", text}  — reasoning-token delta
      {kind: "assistant_text_chunk",     text}  — visible-content delta
      {kind: "tool_call_start", tool, args, args_summary}
      {kind: "tool_call_end",   tool, args_summary, status, result}
      {kind: "error", message}
      {kind: "done"}
    """
    sess = db.get(models.Session, session_id)
    if not sess:
        yield {"kind": "error", "message": f"session {session_id} not found"}
        return
    workflow_id = sess.workflow_id

    # 1) persist + announce the user message
    user_msg = _persist_user(db, session_id, user_text)
    yield {"kind": "user_message", "id": user_msg.id, "text": user_text}

    # Claim this session's turn slot. If a prior turn was running, this signals
    # it to wind down (the prior generator will bail at its next checkpoint).
    cancel_event = _claim_turn(session_id)

    model = _resolve_model(db)
    tool_specs = orch_tools.llm_tool_specs()

    def _cancellation_events():
        """Yield the right tail-events when a cancel is observed: a noisy
        error banner if we were superseded by a newer message, nothing if the
        user just clicked cancel — followed always by ``done``."""
        if _was_superseded(session_id, cancel_event):
            yield {"kind": "error", "message": "superseded by a newer message"}
        yield {"kind": "done"}

    try:
        for _turn_idx in range(MAX_TURNS):
            # Bail between LLM turns.
            if cancel_event.is_set():
                yield from _cancellation_events()
                return

            # Refresh history every turn — including a fresh system snapshot of
            # the graph as it stands. We DON'T persist these system messages.
            history = _history_messages(db, session_id)
            messages = (
                [{"role": "system", "content": SYSTEM_PROMPT}]
                + [graph_state_message(db, workflow_id)]
                + history
            )

            # Stream the LLM response, forwarding each text delta to the chat.
            # The final assembled message (with tool_calls if any) lands at
            # the "done" marker; we only persist *once* per round.
            assembled_msg: dict | None = None
            for kind, payload in _call_openrouter_stream(
                model, messages, tool_specs, cancel_event
            ):
                if kind == "text":
                    yield {"kind": "assistant_text_chunk", "text": payload}
                elif kind == "thinking":
                    yield {"kind": "assistant_thinking_chunk", "text": payload}
                elif kind == "done":
                    assembled_msg = payload.get("message") or {}
                    break

            # Cancelled mid-stream: don't persist a partial assistant message
            # (especially one with half-formed tool_calls — that would corrupt
            # subsequent history). Just exit cleanly. The user's message is
            # still in history; on the next turn the LLM picks up fresh.
            if cancel_event.is_set():
                yield from _cancellation_events()
                return

            if assembled_msg is None:
                # Empty stream — synthesise an empty assistant turn so we
                # exit cleanly rather than looping.
                assembled_msg = {"role": "assistant", "content": ""}

            text = assembled_msg.get("content") or ""
            tcs = assembled_msg.get("tool_calls") or []
            rds = assembled_msg.get("reasoning_details") or []

            # Persist the assistant turn now so subsequent tool messages can
            # reference its tool_calls (OpenRouter wants the assistant message
            # with tool_calls to appear before its tool results). The
            # reasoning_details array is preserved verbatim so the next turn
            # can echo it back — Anthropic enforces ordering of these blocks.
            _persist_assistant(
                db,
                session_id,
                text,
                tcs if tcs else None,
                reasoning_details=rds if rds else None,
            )

            if not tcs:
                yield {"kind": "done"}
                return

            # Execute each tool call sequentially; persist its result; emit
            # start/end events. We check the cancel event between calls — once
            # the assistant message is persisted with its tool_calls, we must
            # also persist a tool result for *every* one of them, otherwise the
            # next turn's history would be malformed (OpenRouter rejects an
            # assistant tool_call without a paired tool message). So once
            # cancelled, we synthesise cancellation results for the remaining
            # tool calls and exit cleanly.
            cancelled_mid_turn = False
            for tc in tcs:
                tc_id = tc.get("id") or ""
                fn = (tc.get("function") or {})
                name = fn.get("name") or ""
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    args = {}
                args_summary = _format_args_summary(args)

                if cancelled_mid_turn or cancel_event.is_set():
                    cancelled_mid_turn = True
                    result = {"error": "cancelled — orchestrator turn was stopped"}
                    _persist_tool_result(db, session_id, tc_id, name, result)
                    yield {
                        "kind": "tool_call_end",
                        "tool": name,
                        "args": args_summary,
                        "status": "err",
                        "result": result,
                    }
                    continue

                yield {
                    "kind": "tool_call_start",
                    "tool": name,
                    "args": args_summary,
                    "args_full": args,
                }

                result = orch_tools.execute(db, workflow_id, name, args)
                ok = "error" not in (result or {})

                _persist_tool_result(db, session_id, tc_id, name, result)

                yield {
                    "kind": "tool_call_end",
                    "tool": name,
                    "args": args_summary,
                    "status": "ok" if ok else "err",
                    "result": result,
                }

            if cancelled_mid_turn:
                yield from _cancellation_events()
                return
        # max turns reached
        yield {"kind": "error", "message": "orchestrator hit max-turns cap"}
        yield {"kind": "done"}
    except Exception as e:  # pragma: no cover — defensive
        yield {"kind": "error", "message": f"{type(e).__name__}: {e}"}
        yield {"kind": "done"}
    finally:
        _release_turn(session_id, cancel_event)


# ---------------------------------------------------------------------------
# history → chat-bubble flattener (used by GET /sessions/:id/messages)
# ---------------------------------------------------------------------------


def render_history(db: DbSession, session_id: str) -> list[dict]:
    """Collapse persisted Messages into chat-panel render units.

    Each user Message → one user bubble. Each assistant Message + its
    immediately-following tool result Messages → one assistant bubble whose
    content interleaves a paragraph block with one tool-card block per call.
    """
    rows = (
        db.query(models.Message)
        .filter_by(session_id=session_id)
        .order_by(models.Message.ts.asc(), models.Message.id.asc())
        .all()
    )

    # Index tool results by tool_call_id for quick lookup.
    tool_results: dict[str, dict] = {}
    for r in rows:
        if r.role == "tool" and r.tool_call_id:
            try:
                payload = json.loads(r.content) if r.content else {}
            except Exception:
                payload = {"raw": r.content}
            tool_results[r.tool_call_id] = {"name": r.name, "result": payload}

    bubbles: list[dict] = []
    for r in rows:
        if r.role == "user":
            bubbles.append({"role": "user", "text": r.content or ""})
        elif r.role == "assistant":
            content: list[dict] = []
            # Re-assemble the visible reasoning text from reasoning_details
            # blocks. Multiple blocks are concatenated with double-newlines so
            # the panel can render them as paragraphs inside one collapsible.
            rds = r.reasoning_details or []
            thinking_text = "\n\n".join(
                (b.get("text") or "").strip()
                for b in rds
                if isinstance(b, dict) and (b.get("text") or "").strip()
            )
            if thinking_text:
                content.append({"t": "thinking", "text": thinking_text})
            if r.content:
                content.append({"t": "p", "text": r.content})
            for tc in (r.tool_calls or []):
                tc_id = tc.get("id") or ""
                fn = tc.get("function") or {}
                name = fn.get("name") or ""
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    args = {}
                summary = _format_args_summary(args)
                tr = tool_results.get(tc_id)
                ok = bool(tr) and "error" not in (tr.get("result") or {})
                content.append(
                    {
                        "t": "tool",
                        "tool": name,
                        "args": summary,
                        "status": "ok" if ok else ("err" if tr else "pending"),
                    }
                )
            bubbles.append({"role": "assistant", "content": content})
        # skip tool / system rows in user-facing render
    return bubbles
