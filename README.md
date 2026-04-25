# gorchestra

Local AI workflow builder. Drop a description of a problem, get a tailored
graph of Python nodes that an orchestrator LLM has assembled, run it, and edit
any node's code or chat to refine.

See `docs/PRD.md` for the full design.

## Status

Phases 0–3 are implemented:

- **Phase 0** Backend (FastAPI) + frontend (Vite/React/React Flow/Monaco) scaffold.
- **Phase 1** Execution engine: tool registry (`shell`, `fetch`, `web_search`),
  `call_llm` over OpenRouter with agent-loop tool-calling, `ctx` injected into
  nodes, subprocess-isolated workflow runner with topo sort, null
  propagation, and required/optional input skip rule.
- **Phase 2** SQLite persistence + REST API for workflows, nodes, edges, runs,
  and settings.
- **Phase 3** Manual workflow builder UI: sidebar of workflows, drag-and-drop
  canvas, Monaco code editor per node, port editor, model + tool config, run
  panel with input form and per-node trace.

The orchestrator (Phases 5+) and live WebSocket streaming (Phase 4) are not
yet built. For now you build workflows by hand to exercise the runner.

## Run it

Requires Python 3.11+ and Node 18+.

```bash
make install       # pip install backend + npm install frontend
make test          # backend pytest suite
make backend       # http://localhost:8000  (in one terminal)
make frontend      # http://localhost:5173  (in another)
```

Open http://localhost:5173. Open Settings, paste your OpenRouter and (optionally)
parallel.ai API keys, and pick default model strings (e.g.
`anthropic/claude-sonnet-4.5`). Then create a workflow, add nodes, mark one as
input and one as output, wire them up, and hit Run.

## Node code contract

```python
def run(inputs, ctx):
    # ctx.call_llm(model=None, prompt=..., tools=["shell", "fetch", "web_search"])
    #   tools are ONLY invoked through call_llm — pass tool names in the
    #   tools=[...] list and the LLM decides when/how to call them.
    #   never write a standalone ctx.tools.X(...) line.
    # ctx.log("...")
    # ctx.workdir                        — Path to per-run scratch dir
    return {"output_name": value_or_None}
```

Returning `None` for an output kills that branch downstream: any node whose
*required* input is `None` is skipped, and its outputs are also `None` so the
skip propagates.

## Layout

```
backend/
  app/
    main.py                # FastAPI app
    db.py models.py schemas.py
    api/                   # workflows, nodes, edges, runs, settings
    runner/
      runner.py            # parent: spawn subprocess, parse result
      child.py             # child: topo + skip rule + per-node exec
      ctx.py               # injected ctx (call_llm, tools, log, workdir)
      tools.py             # tool registry + LLM-tool-calling JSON schemas
      llm.py               # call_llm via OpenRouter
  tests/test_runner.py
frontend/
  src/
    App.tsx
    api.ts types.ts
    components/Sidebar.tsx Canvas.tsx NodePanel.tsx RunPanel.tsx Settings.tsx
docs/PRD.md
```
