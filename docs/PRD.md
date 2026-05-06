# PRD: orchestra (gorchestra)

## 1. Pitch
A local web app where a user describes a problem in natural language, and an **orchestrator LLM** designs a tailored Python workflow — a graph of nodes connected by edges — to solve it. The user watches the graph build live in a chat panel beside the canvas, can run the workflow with their own inputs, edit any node's code, or chat with the orchestrator to keep refining. Every node is Python with access to `ctx.call_llm` (any OpenRouter model) and a tool library (web search, web fetch, shell) the LLM can invoke from inside a node.

## 2. Users
- **Primary:** technical-ish users who want a tailored LLM workflow without hand-coding a graph framework, but who *can* read/edit Python when they want control.
- **Secondary:** developers prototyping agent topologies before hardening them in code.

Single-user, localhost-only for v1.

## 3. Core Concepts

| Concept | What it is |
|---|---|
| **Workflow** | A directed graph of Nodes + Edges, with a designated input node and output node. Also the persistence unit shown to the user as a "session." |
| **Node** | A unit of Python code with declared inputs/outputs. Has access to `ctx.call_llm` and a tool registry. |
| **Edge** | Connects one node's named output to another node's named input. |
| **Session** | One orchestrator chat conversation attached to a workflow. v1 keeps one session per workflow; the data model allows multiple. Persistent. |
| **Orchestrator** | An LLM agent that builds and refines the workflow using a fixed graph-mutation tool surface. Owns the chat side of a session. |
| **Run** | A single execution of the workflow. Triggered either by the user via the run panel or by the orchestrator via its `run_workflow` tool (same code path, same WS event stream). Each run carries a frozen `workflow_snapshot` of the graph that actually executed, so the canvas can re-render historical runs after the live graph has been mutated, and old snapshots are re-runnable with fresh inputs. |

## 4. User Flows

### 4.1 New session
1. The user lands on an empty canvas. There is no "new session" modal.
2. The user either clicks **new** in the top bar (creates a fresh empty workflow named *untitled session*) or just starts typing in the chat panel.
3. The first message lazily creates a workflow + session if none is active, and renames the workflow to a slug derived from that first message.
4. The orchestrator chat panel (left, fixed width) and the canvas (right) are visible side by side. The orchestrator streams reasoning + tool calls over Server-Sent Events; the canvas refreshes after each successful graph-mutating tool call.
5. A status pill in the top bar shows **idle / building / running / ready**.

### 4.2 Refining
- The chat panel is a persistent conversation per workflow. The user can ask: "make node X also do Y," "add a node that does Z," "this is too slow, simplify."
- The orchestrator can mutate the graph again at any time *except* while a workflow run is executing — graph mutations are blocked then; read-only inspection (`view_graph`, `view_node_details`, `view_run`) is always allowed.
- Sending a new user message while the orchestrator is mid-turn supersedes the in-flight turn (cancellation signal). There's also an explicit cancel button.
- A single user request often produces *more than one workflow*, run in sequence: a small scoping workflow whose outputs inform the design of a solve workflow, or a solve workflow followed by a verifier. `clean_canvas` is the seam between stages — it wipes the graph but preserves session, runs, and history, so each stage is its own fully-built workflow.

### 4.3 Running
- The user clicks **run**. A side panel slides in (expandable to fullscreen) with a form generated from the input node's declared inputs. Each input is a textarea — JSON is parsed if it looks like JSON, otherwise the raw string is sent. (File upload for file-typed inputs is on the roadmap; see §10.)
- Alternatively, the orchestrator triggers the run itself via `run_workflow` whenever it can supply every required input from the conversation. The agent loop emits a `run_started` chat event, the frontend attaches the run panel to the live WS (same code path as the manual button), and the orchestrator blocks until the run finishes before continuing the turn.
- Submitting kicks off a workflow run. Per-node states light up on the canvas via a WebSocket stream (`idle → running → success / error / skipped`).
- The run panel shows a live trace per node: logs, LLM calls (model + content + cost), tool calls, inputs, outputs, errors. The output node's final result renders at the bottom alongside total cost.
- The user can hit **cancel** mid-run; the runner subprocess is SIGTERM'd and a `cancelled` terminal event fires.
- Recent runs (up to 20 stored) are listed and replayable in the run panel. Each run can also be re-run from its frozen `workflow_snapshot` — useful for re-executing an older graph version with fresh inputs without restoring it.

### 4.4 Editing a node directly
- The user clicks a node → side panel opens with tabs: **code** (Monaco editor), **i/o** (read-only — topology is orchestrator-owned), **config** (model + enabled tools), **last run** (trace).
- Editing code or config and saving sets `mark_user_edited`, which timestamps `node.user_edited_at`.
- The orchestrator's per-turn graph state includes a `user_edited` boolean per node. Its system prompt instructs it to `view_node_details` first and patch surgically with `configure_node` rather than rewriting wholesale, unless the user explicitly asks for a rewrite.

## 5. Functional Requirements

### 5.1 Orchestrator
- LLM agent over OpenRouter; default model is read from the user's settings (`default_orchestrator_model`), falling back to `anthropic/claude-opus-4.7`.
- Always-on extended thinking (`reasoning.effort = "medium"`). Reasoning details are persisted alongside each assistant message and replayed verbatim on the next turn — Anthropic enforces ordering of these blocks.
- System prompt covers: graph semantics, node runtime contract, available runtime tools, null-propagation rules, required-vs-optional inputs, the distinction between graph-shaping tools (the orchestrator calls these) and node-runtime tools (it equips nodes with these), the *always build a workflow* principle, the research-via-node pattern (build a small probing node, run it, read the output back to inform design), multi-workflow staging with `clean_canvas` between stages, when to call `run_workflow` vs. leave running to the user, when to call `view_run` (default: don't — only on failure paths, research-node payloads, or stage handoffs), tone conventions, and how to handle `user_edited` nodes.
- Streams reasoning chunks, visible content chunks, tool-call start/end events, `run_started` events when `run_workflow` kicks off a run, errors, and a terminal `done` event over **Server-Sent Events** (`POST /api/sessions/{sid}/messages`).
- Per-turn it injects a fresh `[current graph state]` system message — every node's id/name/description/ports/model/tools/`user_edited` flag, every edge, and the input/output node ids. Code is intentionally omitted; the orchestrator pulls it via `view_node_details` when needed.
- Has access to live workflow state across turns and can trigger workflow runs itself via `run_workflow`. The call returns immediately with `{run_id, status: "running"}`; the agent loop emits `run_started` (frontend attaches the run panel to the live WS), then blocks on `wait_for_run` for the materialised final result before letting the LLM see the tool result. On success the LLM sees only `{run_id, status, total_cost}` — outputs are deliberately not relayed (the user reads them in the run panel); on failure the prompt directs `view_run(run_id)` to fetch error details. Only one run can be in flight per workflow.
- Per-session cancellation: a new user message supersedes the in-flight turn; an explicit `POST /api/sessions/{sid}/cancel` signals it as a clean cancel. Mid-stream cancels are detected at LLM-round, tool-call, and `wait_for_run` poll boundaries; if a tool batch was already started, cancellation results are synthesised for the remaining tool calls so message history stays well-formed. Cancelling while waiting on a run leaves the run executing in the background — the next turn can pick it up via `view_run`.
- Hard cap of 12 LLM rounds per turn.

### 5.2 Node runtime
Contract:
```python
def run(inputs: dict, ctx) -> dict:
    ...
    return {"out_name": value_or_None, ...}
```

`ctx` injects:
- `ctx.call_llm(model, prompt, tools=[...], **opts)` — runs an LLM inside the node, returning `{content, messages, tool_calls_made, usage, cost}`. Pass `model=""` to fall back to the user's `default_node_model`. Pass tool names in `tools` and the LLM decides when to invoke them.
- `ctx.tools.<name>(...)` — direct (non-LLM) access to a tool. Exists for completeness but is **discouraged** in v1 — tools are intended to be LLM-mediated only. The system prompt instructs the orchestrator never to emit a standalone `ctx.tools.X(...)` call.
- `ctx.log(msg)` — appends a visible line to the run log.
- `ctx.workdir` — `pathlib.Path` to a per-run scratch directory.

**Null-propagation / branching rules:**
- A node has named outputs. Each can be set to `None`.
- An edge carrying `None` delivers `None` to the downstream input.
- Inputs are flagged `required` or `optional` per node.
- **Skip rule:** if any *required* input on a node is `None`, the node is skipped and emits `None` on every declared output (propagation continues). Optional inputs may be `None` and the node still runs.
- This gives if/else and short-circuit without explicit conditional edges.

Execution:
- Nodes run in a single workflow-level subprocess (`python -m app.runner.child`). Independent nodes execute concurrently via a `ThreadPoolExecutor`: as each node finishes, its successors decrement their pending-input count and any whose count reaches zero are submitted next. Topology is still respected — a node only starts once every upstream node has produced its outputs (or been skipped). Within a node, `ctx.call_llm` is thread-safe and node code is encouraged to parallelise per-item LLM calls with its own pool.
- The child emits structured JSON-line events to stdout (`run_started`, `node_started`, `log`, `llm_call_started`, `llm_call_chunk`, `llm_call_finished`, `tool_call_started`, `tool_call_finished`, `node_finished`, `run_finished`). Concurrent calls are disambiguated by `call_id`. The parent appends events to an in-memory pub/sub keyed by `run_id`.
- Cancellation only — there is no per-node or workflow-level timeout enforcement; a hung node hangs the run until the user clicks **cancel** (parent SIGTERMs the child; child raises `KeyboardInterrupt` and emits a `cancelled` `run_finished`).
- Node code decides which runtime tools it uses by referencing them in its own Python (`ctx.call_llm(tools=[...])` or `ctx.tools.X(...)`); the runner forwards whatever the code passes verbatim. Unknown tool names are surfaced as errors by the registry rather than silently filtered.

### 5.3 `call_llm`
- Single function over OpenRouter.
- Signature: `call_llm(model: str, prompt: str | messages, tools: list[str] = [], **opts) -> dict`.
- When `tools` is non-empty, runs an agent loop: LLM → tool calls → tool results → LLM, until the LLM stops calling tools. There's no turn cap — a runaway loop is a cancel-button concern, same as any other hung node.
- Streams from OpenRouter token-by-token: the runner forwards content, reasoning, and tool-argument deltas as `llm_call_chunk` events tagged with the per-call `call_id`, so concurrent calls render as parallel streaming cards in the run panel. The function still *returns* the full assembled response when the agent loop terminates.
- Captures cost + token counts from OpenRouter (requests `usage.include = true` so `usage.cost` is populated).

### 5.4 Tool library (v1)

| Tool | Purpose | Auth |
|---|---|---|
| `shell` | Run a shell command (covers file I/O via `cat`, `ls`, `mv`, etc.) — returns `{stdout, stderr, returncode}`. 30s default timeout. | none — flagged dangerous in UI |
| `web_search` | Web search via parallel.ai — returns ranked URLs + excerpts for a query. | parallel.ai key |
| `web_fetch` | Read URL(s) as LLM-clean markdown via parallel.ai Extract — handles JS-rendered pages and PDFs. | parallel.ai key |

Tools live in a single Python registry (`app.runner.tools.REGISTRY`). Each is callable via `ctx.call_llm(tools=[...])` (LLM-mediated, recommended) or `ctx.tools.<name>(...)` (direct, discouraged). Adding a tool = adding a function + JSON schema to the registry; not user-extensible v1.

### 5.5 UI
- **Top bar:** product mark, current session picker (dropdown showing all workflows; in-line rename + delete on hover), status pill, **settings**, **new**, **run** buttons. No left sidebar.
- **Chat panel (left, ~420px):** orchestrator conversation. Renders one growing assistant bubble per turn that interleaves reasoning blocks (collapsible), prose paragraphs, and tool-call cards (with status: pending / ok / err). Header shows current session name + the orchestrator model in use. Send + cancel buttons.
- **Canvas (React Flow via `@xyflow/react`):** nodes draggable for position only. Edges drawn between named ports. Visual run-state dots per node (idle / running / success / error / skipped). Input/output nodes badged. **Topology mutations (add/remove nodes, add/remove edges, set input/output role) are owned exclusively by the orchestrator** — the canvas does not expose them as direct user actions. Position drags persist via `PATCH /api/nodes/{id}`.
- **Node side panel** (on click): tabs for **code** (Monaco editor), **i/o** (read-only port shape), **config** (model), **last run** (logs, LLM calls, tool calls). Saves set `mark_user_edited`.
- **Run panel** (slides in from right; expandable to fullscreen): input form generated from the input node, run / cancel buttons, live per-node trace, final output viewer with total cost, recent-runs list (last 20 stored, last 8 surfaced).
- **Settings:** OpenRouter API key, parallel.ai API key, default orchestrator model, default node model. Stored in browser `localStorage`, **not** the backend DB. Forwarded to the backend as request headers (`x-openrouter-key`, `x-parallel-key`, `x-orchestrator-model`, `x-node-model`); a per-request middleware copies them into `os.environ` for the lifetime of the request. The DB has a legacy `settings` table that acts as a backwards-compat fallback only.

### 5.6 Persistence
- SQLite for workflows, nodes, edges, sessions, messages, runs, node runs, settings (legacy). Default DB at `./workflow_builder.db`.
- Filesystem for per-run workdirs (`tempfile.mkdtemp(prefix="wfrun-")`).
- Listing surfaces the most recent 20 runs per workflow. **Automatic pruning of older runs is not yet implemented** — older rows accumulate in the DB.
- Each `Run` row carries a `workflow_snapshot` JSON column — the frozen graph (nodes + code + edges + in/out node ids) the runner actually executed. Runs created before the column landed have `null`; new runs always populate it. The runner uses the snapshot, not a re-read of the live workflow, so the row can't drift from what was executed. `POST /api/runs/{rid}/rerun` re-executes a snapshot with fresh inputs without restoring the live graph.
- Tiny ad-hoc column-add migrations live in `app.db._PENDING_COLUMNS` (idempotent against `PRAGMA table_info`); SQLAlchemy's `create_all` only adds tables.

## 6. Non-Functional
- **Local-only**, no auth, single user.
- **Cancellation:** runner subprocess is SIGTERM-able from the UI; orchestrator turns are cancellable per-session.
- **Crash isolation:** node crashes / shell tool can't take down the backend (subprocess boundary); a runner that exits without a `run_finished` event triggers a synthetic terminal one so subscribers always observe completion.
- **Streaming transports:** WebSocket for run events (`/api/runs/{rid}/events`), Server-Sent Events for orchestrator chat (`POST /api/sessions/{sid}/messages`). Both feel real-time on localhost.

## 7. Data Model

```
Workflow   { id, name, created_at, input_node_id, output_node_id }

Node       { id, workflow_id, name, description, code,
             inputs:  [{name, type_hint, required: bool}],
             outputs: [{name, type_hint, required: bool}],
             config:  { model },
             position: {x, y},
             user_edited_at: datetime? }

Edge       { id, workflow_id,
             from_node_id, from_output,
             to_node_id,   to_input }

Session    { id, workflow_id, created_at }

Message    { id, session_id, role, content, tool_calls,
             tool_call_id?, name?, reasoning_details, ts }
           # role: "user" | "assistant" | "tool" | "system"
           # reasoning_details holds Anthropic extended-thinking blocks that
           # must be echoed back unmodified on the next turn

Run        { id, workflow_id, kind, status, inputs, outputs, error,
             started_at, ended_at, total_cost,
             workflow_snapshot: { nodes[], edges[], input_node_id, output_node_id }? }
           # kind: "user" | "test"
           # status: "pending" | "running" | "success" | "error" | "cancelled"
           # workflow_snapshot: frozen at run creation; null on legacy rows

NodeRun    { id, run_id, node_id, status, inputs, outputs,
             logs, llm_calls, tool_calls, error, duration_ms, cost }

Setting    { key, value }   # legacy / fallback only — see §5.5
```

## 8. Orchestrator Tool Surface

```
# read-only inspection (always allowed, even mid-run)
view_graph()                           -> {workflow_id, name, input_node_id, output_node_id, nodes[], edges[]}
view_node_details(node_id)             -> {full node record incl. code, user_edited, position}
view_run(run_id)                       -> {run_id, status, outputs, node_errors, error, total_cost}

# graph mutation (blocked while a workflow run is in progress)
add_node(name, description, code, inputs, outputs, model) -> {node_id, node}
remove_node(node_id)
rename_node(node_id, new_name)
configure_node(node_id, **partial_fields)        # description, code, inputs, outputs, model
add_edge(from_node_id, from_output, to_node_id, to_input) -> {edge_id, edge}
remove_edge(edge_id)
set_input_node(node_id)
set_output_node(node_id)
clean_canvas()                         # wipe nodes + edges + in/out pointers; preserve session/runs/history

# run trigger (blocks until run finishes; refuses if another run is in flight)
run_workflow(inputs)                   -> {run_id, status, total_cost}   # outputs deliberately not relayed
```

`run_workflow` returns lean state — the user sees outputs in the run panel; the orchestrator should not summarise them on success. `view_run` is reserved for failure diagnosis, reading a research-node's output back into design, and stage handoffs in multi-workflow solves. `clean_canvas` is the seam between stages, not a redo button. The `generate_test_data` tool (for synthesising input fixtures) remains on the roadmap (§10).

When the user has edited a node, its `user_edited` flag is `true` in the per-turn graph-state injection. The system prompt directs the orchestrator to `view_node_details` first and patch surgically rather than overwriting, unless the user explicitly asks for a rewrite.

## 9. Tech Stack
- **Backend:** Python 3.11+, FastAPI, WebSocket (run events) + SSE (chat), SQLAlchemy + SQLite, `subprocess` for run isolation, OpenRouter via `httpx`.
- **Frontend:** React 18 + Vite, `@xyflow/react` (React Flow v12) for canvas, `@monaco-editor/react` for code editing, `react-markdown` + `remark-gfm` for chat rendering. Custom CSS (smallcaps, serif, mono utility classes); Tailwind is in deps but largely unused.
- **Packaging / dev:** backend served on `:8000`, frontend on `:5173` (Vite dev). Two terminals via `make backend` / `make frontend`. *Roadmap (§10): single-package install that serves the built frontend and the API on the same port.*

## 10. Out of Scope (v1) / Future Work
**Genuinely out of scope:**
- Multi-user / auth / collaboration
- Cloud deploy / hosted version
- Workflow / node marketplace
- Cycles / explicit conditional edges (use in-node loops + null branching)
- User-extensible tool plugins
- Workflow versioning / undo-redo
- Cost budgets, rate limits
- Sandboxed Python execution (trusted local only)

**On the roadmap, partially or wholly unimplemented:**
- **Orchestrator test-data generation.** `run_workflow` and `view_run` ship; `generate_test_data` (synthesise plausible inputs for an input node so the orchestrator can self-debug without the user supplying fixtures) is still unbuilt. `Run.kind = "test"` exists in the data model to distinguish such runs from user runs.
- **Generative UI (designer agent).** A second LLM agent — the **designer** — that emits a single self-contained HTML/CSS/JS page tailored to the workflow's input/output shape, so the workflow can be invoked from a purpose-built UI rather than the generic textarea form. Invocation paths: (a) the orchestrator calls the designer as a tool when it judges the workflow stable enough to "ship a UI for"; (b) a dedicated **Design** tab in the app where the user asks the designer directly. Output is a single HTML document (inline CSS/JS, no build step) that posts to the workflow's run endpoint and renders results — dynamic per task: a chat box for a Q&A workflow, a form + table for a data-extraction workflow, a file dropzone for a doc-processing workflow, etc. Stored alongside the workflow; regeneratable. Open questions: where the page is hosted (served from the backend at `/w/{workflow_id}` vs. exported as a standalone file), how it authenticates to the run endpoint in the local-only model, and how it handles streaming run events.
- **File-typed inputs.** Run panel currently exposes textareas only; file upload for file-typed input ports isn't built.
- **Run pruning.** Older runs aren't auto-deleted once a workflow exceeds 20.
- **Single-process packaging.** The PRD's original ambition of one `pip`-installed package serving both API and built frontend on a single port — the current dev setup runs them separately.

## 11. Risks
- **Orchestrator quality is the product.** If it can't write decent Python or recover from failures, the UX is dead. With `run_workflow` + `view_run` the orchestrator can now execute and inspect its own builds (and is prompted to do so on failure paths and after running research nodes); the remaining gap is `generate_test_data`, so it still depends on user-supplied inputs to drive a run.
- **Shell tool is dangerous.** Trusted-local mitigates; the UI flags it as dangerous in node config.
- **OpenRouter cost surprises.** Cost is shown per run; long-term consider per-run caps.
- **Subprocess + streaming plumbing for live runs** is the trickiest engineering bit — node logs, LLM-call markers, and tool-call markers must flow from a child process through a thread-safe in-memory pub/sub to a WebSocket without buffering badly.
- **Reasoning-block ordering.** Anthropic via OpenRouter requires that `reasoning_details` blocks emitted by the assistant be echoed back unmodified on the next turn alongside any tool results. The orchestrator persists these and replays them — fragile if the upstream contract changes.

## 12. Milestones
1. **Skeleton** ✅ FastAPI + React Flow + SQLite, manually-built workflows, can run a hand-coded node graph end-to-end with `call_llm` and one tool.
2. **Persistence + REST** ✅ workflows, nodes, edges, runs, settings, sessions/messages.
3. **Manual builder UI** ✅ canvas, Monaco code editor per node, port editor, model + tool config, run panel with input form and per-node trace.
4. **Live run streaming** ✅ WebSocket pub/sub, per-node states on canvas, cancellation.
5. **Orchestrator v1** ✅ chat session, SSE streaming with extended thinking, graph-mutation tool surface, `user_edited` awareness, mid-turn cancellation/supersession.
6. **Orchestrator-driven runs** 🟡 `run_workflow` triggers runs from chat (agent loop attaches the run panel and waits), `view_run` inspects results, `clean_canvas` enables multi-stage solves; runs carry a frozen `workflow_snapshot` and old snapshots are re-runnable. Remaining: `generate_test_data` so the orchestrator can self-debug without user-supplied fixtures.
7. **Generative UI / designer agent** ⏳ second agent that emits a workflow-specific HTML page; invokable as an orchestrator tool and from a dedicated Design tab.
8. **Polish** ⏳ file-typed inputs, run pruning, single-package packaging.
