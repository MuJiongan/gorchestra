# gorchestra

Local AI workflow builder. Describe a problem in chat, an orchestrator LLM
assembles a tailored graph of Python nodes on the canvas, run it, and edit any
node's code or chat to refine.

See `docs/PRD.md` for the full design.

## Status

Phases 0–5 are implemented:

- **Phase 0** Backend (FastAPI) + frontend (Vite/React/React Flow/Monaco) scaffold.
- **Phase 1** Execution engine: tool registry (`shell`, `web_search`, `web_fetch`),
  `call_llm` over OpenRouter with agent-loop tool-calling, `ctx` injected into
  nodes, subprocess-isolated workflow runner with topo sort, null
  propagation, and required/optional input skip rule.
- **Phase 2** SQLite persistence + REST API for workflows, nodes, edges, runs,
  sessions, messages, and settings.
- **Phase 3** Builder UI: top bar with session picker, drag-and-drop canvas,
  Monaco code editor per node, model + tool config, run panel with input form
  and per-node trace.
- **Phase 4** Live run streaming over WebSocket — per-node state dots on the
  canvas, live logs / LLM calls / tool calls in the run panel, mid-run cancel.
- **Phase 5** Orchestrator: SSE chat session with extended-thinking, graph
  mutation tool surface (`add_node` / `add_edge` / `configure_node` / …), live
  canvas refresh, `user_edited` awareness so hand-edits to node code are
  preserved across orchestrator turns, mid-turn cancel + supersession.

Not yet built (see PRD §10 for the full list): orchestrator-driven test runs
(`run_workflow` / `get_run` / `generate_test_data`), file-typed inputs, run
pruning, single-package install.

## Run it

Requires Python 3.11+ and Node 18+.

```bash
make install       # pip install backend + npm install frontend
make test          # backend pytest suite
make backend       # http://localhost:8000  (in one terminal)
make frontend      # http://localhost:5173  (in another)
```

Open http://localhost:5173. Open **settings**, paste your OpenRouter and
(optionally) parallel.ai API keys, and pick default model strings (e.g.
`anthropic/claude-sonnet-4.5`). Keys live in your browser's `localStorage`
and are forwarded to the backend as request headers — the backend never
persists them.

Then either:

- **Talk to the orchestrator** — type into the chat panel on the left. The
  first message lazily creates a session named after it; the orchestrator
  builds the graph live on the canvas. Hit **run** when ready.
- **Build by hand** — click **new**, then ask the orchestrator to add nodes,
  or click a node to open the side panel and edit code / model / tools
  directly. (Topology — adding/removing nodes and edges, designating input/
  output — is owned by the orchestrator; you ask via chat.)

## Run as a native Mac app

Wrap the whole thing in a real `.app` bundle so it shows up in Spotlight,
Launchpad, and the Dock — no terminals, no `localhost:5173` to remember.

```bash
make app-install     # one-time: adds pywebview to the backend venv
make install-app     # build frontend + build .app + copy to /Applications
```

After `make install-app`, hit `Cmd+Space`, type `gorchestra`, press Enter.
On the very first launch, right-click the app → **Open** to bypass the
Gatekeeper "unidentified developer" warning (it's ad-hoc signed, not
notarised). After that, normal double-click works.

Other targets if you want finer control:

```bash
make app             # dev mode: launch in a window without bundling
make app-bundle      # just build gorchestra.app in the project root
```

### How it works

- `launcher.py` runs FastAPI in a daemon thread on port `8765` (pinned so
  `localStorage` settings persist across launches — that store is keyed by
  origin) and opens a native WKWebView window via `pywebview` with
  `private_mode=False` so the data store survives restarts.
- The frontend's static `dist/` is served from the same origin, so all
  existing relative API/WebSocket URLs work unchanged.
- `scripts/build_app.sh` produces the bundle. The executable in
  `Contents/MacOS/` is a tiny C wrapper compiled to native arm64 — it just
  `execv`s the project's venv Python on `launcher.py`. It has to be a real
  Mach-O binary (not a shell script) or LaunchServices misreads the
  architecture and falsely demands Rosetta. The bundle is then ad-hoc
  signed so macOS 15+ App Management lets it launch.
- Closing the window — or force-quitting the app entirely — kills any
  in-flight workflow runs by signalling their process group (the runner
  spawns its child with `start_new_session=True`). For graceful close
  (Cmd+Q, red button) the launcher's `closing` hook does it directly. For
  abrupt death (SIGKILL, force-quit) the runner child has its own
  parent-death watchdog: it holds the read end of a pipe whose write end
  the parent keeps open, gets EOF the instant parent dies, and tears down
  its own process group. So no orphaned `shell` tool subprocesses either way.
- Logs go to `$TMPDIR/gorchestra.log`.

### Caveats

- The bundle is hard-linked to this checkout — its launcher execs
  `backend/.venv/bin/python` on this project's `launcher.py`. Move the
  project directory and you'll need to `make install-app` again. For a
  fully relocatable bundle, swap the C wrapper for `py2app`.
- `make dev` runs the frontend in your browser (Chrome/Safari) and uses
  that browser's `localStorage`. The native-window launches (`make app`
  and `gorchestra.app`) both run via Homebrew's embedded Python.app and
  share a WKWebView store under `~/Library/WebKit/org.python.python/`,
  so settings carry between those two — but not from the browser.

## Node code contract

```python
def run(inputs, ctx):
    # ctx.call_llm(model="", prompt=..., tools=["shell", "web_search", "web_fetch"])
    #   tools are LLM-mediated — pass tool names in the tools=[...] list and
    #   the LLM running inside this call decides when/how to invoke them.
    #   model="" falls back to the user's default node model.
    # ctx.log("...")                     — appends a line to the run log
    # ctx.workdir                        — Path to per-run scratch dir
    return {"output_name": value_or_None}
```

`ctx.tools.X(...)` exists as a direct (non-LLM) tool call but is discouraged
in v1 — route tool invocations through `call_llm(tools=[...])`.

Returning `None` for an output kills that branch downstream: any node whose
*required* input is `None` is skipped, its declared outputs are also `None`,
and the skip propagates.

## Layout

```
backend/
  app/
    main.py                # FastAPI app + per-request settings → env middleware
    db.py models.py schemas.py
    api/                   # workflows, nodes, edges, runs, settings, orchestrator
    runner/
      runner.py            # parent: spawn child, fan events into pub/sub
      child.py             # child: topo + skip rule + per-node exec
      ctx.py               # injected ctx (call_llm, tools, log, workdir)
      tools.py             # tool registry + LLM-tool-calling JSON schemas
      llm.py               # call_llm via OpenRouter (agent loop)
      events.py            # in-memory per-run pub/sub feeding the WebSocket
    orchestrator/
      agent.py             # SSE turn loop, OpenRouter streaming, cancellation
      tools.py             # graph-mutation tool surface + per-turn snapshot
      prompt.py            # system prompt + per-turn graph state injection
  tests/
    test_runner.py
    test_orchestrator.py
frontend/
  src/
    App.tsx
    api.ts types.ts localSettings.ts
    components/
      TopBar.tsx           # session picker + new / settings / run
      ChatPanel.tsx        # orchestrator chat (SSE)
      Canvas.tsx           # React Flow graph (read-only topology)
      NodePanel.tsx        # code editor + i/o + config + last run
      RunPanel.tsx         # input form + live trace + recent runs
      Settings.tsx         # localStorage-backed key + model defaults
      JsonView.tsx Markdown.tsx
docs/PRD.md
```
