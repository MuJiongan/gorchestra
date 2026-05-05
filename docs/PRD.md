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
| **Workflow** | A directed graph of Nodes + Edges, with a designated input node and output node. Multiple workflows may be created, inspected, compared, and run from the same orchestrator turn. |
| **Node** | A unit of Python code with declared inputs/outputs. Has access to `ctx.call_llm` and a tool registry. |
| **Edge** | Connects one node's named output to another node's named input. |
| **Session** | A persistent chat transcript with the orchestrator. Sessions are not ownership boundaries for workflows; a session may reference zero, one, or many workflows. |
| **Orchestrator** | A workspace-scoped LLM agent that can create, inspect, mutate, run, and compare workflows using explicit tool calls. It is not attached to one workflow or one session. |
| **Run** | A single execution of a workflow. Runs may be user-initiated or orchestrator-initiated test runs, and the orchestrator can inspect run traces/results to refine workflows. |

## 4. User Flows

### 4.1 New orchestrator conversation
1. The user lands on an empty canvas. There is no "new session" modal.
2. The user either clicks **new** in the top bar to create a workflow manually, or just starts typing in the chat panel.
3. The first message lazily creates a chat session if none is active. The orchestrator decides whether to create a new workflow, inspect existing workflows, or create multiple candidate workflows in the same turn.
4. The orchestrator chat panel (left, fixed width) and the canvas (right) are visible side by side. The orchestrator streams reasoning + tool calls over Server-Sent Events; the canvas refreshes after each successful workflow or graph-mutating tool call.
5. A status pill in the top bar shows **idle / building / running / ready**.

### 4.2 Refining
- The chat panel is a persistent conversation over the workspace. The user can ask: "make node X also do Y," "add a node that does Z," "create two alternatives and run both," or "this is too slow, simplify."
- The orchestrator can create workflows, inspect workflows, mutate graphs, start test runs, inspect run traces, and revise workflows without requiring the user to manually run or paste errors back.
- The orchestrator can mutate a graph again at any time *except* while that specific workflow is executing — graph mutations for the active workflow are blocked then; read-only inspection (`view_graph`, `view_node_details`, `get_run`) is always allowed.
- Sending a new user message while the orchestrator is mid-turn supersedes the in-flight turn (cancellation signal). There's also an explicit cancel button.

### 4.3 Running
- The user clicks **run**. A side panel slides in (expandable to fullscreen) with a form generated from the input node's declared inputs. Each input is a textarea — JSON is parsed if it looks like JSON, otherwise the raw string is sent. (File upload for file-typed inputs is on the roadmap; see §10.)
- Submitting kicks off a workflow run. Per-node states light up on the canvas via a WebSocket stream (`idle → running → success / error / skipped`).
- The run panel shows a live trace per node: logs, LLM calls (model + content + cost), tool calls, inputs, outputs, errors. The output node's final result renders at the bottom alongside total cost.
- The user can hit **cancel** mid-run; the runner subprocess is SIGTERM'd and a `cancelled` terminal event fires.
- Recent runs (up to 20 stored) are listed and replayable in the run panel.

### 4.4 Editing a node directly
- The user clicks a node → side panel opens with tabs: **code** (Monaco editor), **i/o** (read-only — topology is orchestrator-owned), **config** (model + enabled tools), **last run** (trace).
- Editing code or config and saving sets `mark_user_edited`, which timestamps `node.user_edited_at`.
- The orchestrator's per-turn graph state includes a `user_edited` boolean per node. Its system prompt instructs it to `view_node_details` first and patch surgically with `configure_node` rather than rewriting wholesale, unless the user explicitly asks for a rewrite.

## 5. Functional Requirements

### 5.1 Orchestrator
- LLM agent over OpenRouter; default model is read from the user's settings (`default_orchestrator_model`), falling back to `anthropic/claude-opus-4.7`.
- Always-on extended thinking (`reasoning.effort = "medium"`). Reasoning details are persisted alongside each assistant message and replayed verbatim on the next turn — Anthropic enforces ordering of these blocks.
- System prompt covers: graph semantics, node runtime contract, available runtime tools, null-propagation rules, required-vs-optional inputs, the distinction between graph-shaping tools (the orchestrator calls these) and node-runtime tools (it equips nodes with these), tone conventions, and how to handle `user_edited` nodes.
- Streams reasoning chunks, visible content chunks, tool-call start/end events, errors, and a terminal `done` event over **Server-Sent Events** (`POST /api/sessions/{sid}/messages`).
- The orchestrator is **workspace-scoped**, not bound to the current workflow or a single session/workflow pair. A session is only the chat transcript; every workflow operation uses explicit workflow ids.
- In one turn, the orchestrator may create multiple workflows, inspect existing workflows, build or revise several candidate graphs, run them, compare their traces/results/costs, and choose or recommend the best one.
- Per-turn it injects a fresh `[workspace state]` system message — workflow ids/names/recent status, active canvas workflow if any, and compact summaries of relevant workflows. Full graph details and code are omitted; the orchestrator pulls them via `view_graph` / `view_node_details` when needed.
- Has tools for workflow lifecycle and self-debugging: create/list/select workflows, inspect graph/node details, run workflows with generated or user-provided inputs, fetch run traces/results, and revise graphs based on logs/errors.
- Orchestrator-initiated runs use `Run.kind = "test"` by default and are shown separately from user-triggered runs while remaining replayable in the run panel.
- Per-turn cancellation: a new user message supersedes the in-flight turn; an explicit `POST /api/sessions/{sid}/cancel` signals it as a clean cancel. Mid-stream cancels are detected at LLM-round and tool-call boundaries; if a tool batch was already started, cancellation results are synthesised for the remaining tool calls so message history stays well-formed.
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

Session    { id, created_at, active_workflow_id? }

Message    { id, session_id, role, content, tool_calls,
             tool_call_id?, name?, workflow_refs?, reasoning_details, ts }
           # role: "user" | "assistant" | "tool" | "system"
           # workflow_refs records workflows mentioned, created, inspected, or run
           # reasoning_details holds Anthropic extended-thinking blocks that
           # must be echoed back unmodified on the next turn

Run        { id, workflow_id, kind, status, inputs, outputs, error,
             started_at, ended_at, total_cost }
           # kind: "user" | "test"
           # status: "pending" | "running" | "success" | "error" | "cancelled"

NodeRun    { id, run_id, node_id, status, inputs, outputs,
             logs, llm_calls, tool_calls, error, duration_ms, cost }

Setting    { key, value }   # legacy / fallback only — see §5.5
```

## 8. Orchestrator Tool Surface

```
# workspace workflow lifecycle
create_workflow(name)                  -> {workflow_id, workflow}
list_workflows()                       -> [{workflow_id, name, recent_status, updated_at}]
select_workflow(workflow_id)           -> {active_workflow_id}

# read-only inspection (always allowed, even mid-run)
view_graph(workflow_id)                -> {workflow_id, name, input_node_id, output_node_id, nodes[], edges[]}
view_node_details(workflow_id, node_id) -> {full node record incl. code, user_edited, position}
list_runs(workflow_id, kind?)          -> [{run_id, status, kind, inputs, outputs, error, total_cost}]
get_run(run_id)                        -> {run incl. node_runs, logs, llm_calls, tool_calls, errors}

# graph mutation (blocked while a workflow run is in progress)
add_node(workflow_id, name, description, code, inputs, outputs, model) -> {node_id, node}
remove_node(workflow_id, node_id)
rename_node(workflow_id, node_id, new_name)
configure_node(workflow_id, node_id, **partial_fields)        # description, code, inputs, outputs, model
add_edge(workflow_id, from_node_id, from_output, to_node_id, to_input) -> {edge_id, edge}
remove_edge(workflow_id, edge_id)
set_input_node(workflow_id, node_id)
set_output_node(workflow_id, node_id)

# orchestrator-run loop
generate_test_data(workflow_id, scenario?) -> {inputs, rationale}
run_workflow(workflow_id, inputs, kind="test") -> {run_id, status}
```

All tool calls that act on a workflow take an explicit `workflow_id`; the orchestrator never relies on hidden session-bound workflow state. A single orchestrator turn may create several workflows, run them, inspect their traces, and continue mutating one or more of them before responding.

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
- **Workspace-scoped orchestrator.** Detach the orchestrator from any single workflow/session pair. It should create, inspect, mutate, run, and compare multiple workflows in one turn using explicit workflow ids.
- **Orchestrator-driven test runs.** `run_workflow`, `get_run`, `list_runs`, and `generate_test_data` tools so the orchestrator can run, inspect logs/errors, and self-debug during a turn. The data model already carries `Run.kind = "test"` to distinguish them.
- **Generative UI (designer agent).** A second LLM agent — the **designer** — that emits a single self-contained HTML/CSS/JS page tailored to the workflow's input/output shape, so the workflow can be invoked from a purpose-built UI rather than the generic textarea form. Invocation paths: (a) the orchestrator calls the designer as a tool when it judges the workflow stable enough to "ship a UI for"; (b) a dedicated **Design** tab in the app where the user asks the designer directly. Output is a single HTML document (inline CSS/JS, no build step) that posts to the workflow's run endpoint and renders results — dynamic per task: a chat box for a Q&A workflow, a form + table for a data-extraction workflow, a file dropzone for a doc-processing workflow, etc. Stored alongside the workflow; regeneratable. Open questions: where the page is hosted (served from the backend at `/w/{workflow_id}` vs. exported as a standalone file), how it authenticates to the run endpoint in the local-only model, and how it handles streaming run events.
- **File-typed inputs.** Run panel currently exposes textareas only; file upload for file-typed input ports isn't built.
- **Run pruning.** Older runs aren't auto-deleted once a workflow exceeds 20.
- **Single-process packaging.** The PRD's original ambition of one `pip`-installed package serving both API and built frontend on a single port — the current dev setup runs them separately.

## 11. Risks
- **Orchestrator quality is the product.** If it can't write decent Python, design useful graphs, choose when to run tests, or recover from failures, the UX is dead. The workspace-scoped orchestrator needs strong tool design, bounded self-debug loops, and clear run/result attribution across multiple workflows.
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
6. **Workspace-scoped orchestrator** ⏳ detach orchestrator turns from a single workflow/session pair; add explicit workflow lifecycle tools and allow multiple workflows per turn.
7. **Orchestrator test-run loop** ⏳ `run_workflow` / `get_run` / `list_runs` / `generate_test_data` so the orchestrator can run, inspect, and fix without the user in the loop.
8. **Generative UI / designer agent** ⏳ second agent that emits a workflow-specific HTML page; invokable as an orchestrator tool and from a dedicated Design tab.
9. **Polish** ⏳ file-typed inputs, run pruning, single-package packaging.
