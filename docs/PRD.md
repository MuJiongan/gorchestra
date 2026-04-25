# PRD: Local AI Workflow Builder

## 1. Pitch
A local web app where a user describes a problem in natural language, and an **orchestrator LLM** designs a tailored Python workflow — a graph of nodes connected by edges — to solve it. The user watches the graph build live, the orchestrator test-runs and self-debugs until satisfied, and the user can then run the workflow with their own inputs, edit any node's code, or chat with the orchestrator to keep refining. Every node is Python with access to `call_llm` (any OpenRouter model) and a tool library (web search, HTTP fetch, shell).

## 2. Users
- **Primary:** technical-ish users who want a tailored LLM workflow without hand-coding LangGraph, but who *can* read/edit Python when they want control.
- **Secondary:** developers prototyping agent topologies before hardening them in code.

Single-user, localhost-only for v1.

## 3. Core Concepts

| Concept | What it is |
|---|---|
| **Workflow** | A directed graph of Nodes + Edges, with a designated input node and output node. |
| **Node** | A unit of Python code with declared inputs/outputs. Has access to `call_llm` and tools. |
| **Edge** | Connects one node's named output to another node's named input. |
| **Session** | One workflow + its full chat history with the orchestrator. Persistent. |
| **Orchestrator** | An LLM agent that builds and refines the workflow using a fixed tool surface. Owns the chat side of a session. |
| **Run** | A single execution of the workflow, kind = `test` (orchestrator-initiated) or `user`. |

## 4. User Flows

### 4.1 New session
1. User clicks "New Session."
2. Modal: "What's your problem?" → user types free-form description.
3. Backend opens a session, starts the orchestrator with the description as the first message.
4. Orchestrator chat panel + canvas appear side by side. Orchestrator streams reasoning and calls graph-mutation + test-run tools live; canvas updates in real time.
5. Orchestrator decides it's done → posts a "ready to run" message.

### 4.2 Refining
- After the modal closes, the chat panel becomes a persistent conversation. User can ask: "make node X also do Y," "add a node that does Z," "this is too slow, simplify."
- Orchestrator can mutate the graph again (only when not actively running) and trigger more test runs.

### 4.3 Running
- User clicks **Run**. A form is generated from the input node's declared inputs (string fields, file upload for file-typed inputs).
- User submits → workflow executes in a subprocess. Per-node states light up on canvas (idle → running → success/error/skipped). LLM token streams render inside node panels.
- When done, the output node's result is shown in a results panel.
- User can hit **Cancel** mid-run.

### 4.4 Editing a node directly
- User clicks a node → side panel opens (Monaco editor with the Python, plus inputs/outputs/model/tools config).
- User edits and saves. The next time the orchestrator is invoked, its system context includes the current code so it edits in place rather than rewriting from scratch. Orchestrator may still overwrite if the user asks for changes.

## 5. Functional Requirements

### 5.1 Orchestrator
- LLM agent (OpenRouter model picked in settings; default Claude Sonnet) with the tool surface in §8.
- System prompt explains: graph semantics, node runtime contract, available tools, null-propagation rules, required-vs-optional inputs.
- Streams reasoning + tool calls to the chat panel via WebSocket.
- Has access to current graph state and the latest run's per-node logs/errors when iterating.
- Cannot mutate the graph while a run is in progress.

### 5.2 Node runtime
Contract:
```python
def run(inputs: dict, ctx) -> dict:
    ...
    return {"out_name": value_or_None, ...}
```

`ctx` injects:
- `call_llm(model, prompt, tools=[...], **opts)`
- `tools.<name>(...)` — direct access to the tool registry
- `log(msg)`
- `workdir` — per-run scratch directory (Path)

**Null-propagation / branching rules:**
- A node has named outputs. Each can be set to `None`.
- An edge carrying `None` delivers `None` to the downstream input.
- Inputs are flagged `required` or `optional` per node.
- **Skip rule:** if any *required* input on a node is `None`, the node is skipped and emits `None` on every output (propagation continues). Optional inputs may be `None` and the node still runs.
- This gives if/else and short-circuit without explicit conditional edges.

Execution:
- Nodes run in topo order in a single workflow-level subprocess. Single-threaded, sequential. No parallel fan-out v1.
- Cancellation only — there is no per-node or workflow-level timeout enforcement; a hung node hangs the run until the user clicks **Cancel**.

### 5.3 `call_llm`
- Single function, all providers via OpenRouter.
- Signature: `call_llm(model: str, prompt: str | messages, tools: list[str] = [], **opts) -> response`.
- When `tools` is non-empty, runs an agent loop: LLM → tool calls → tool results → LLM, until the LLM stops calling tools or hits a max-turns cap.
- Streams tokens to the active run trace (visible in node panel during run).
- Captures cost + token counts from OpenRouter response headers.

### 5.4 Tool library (v1)

| Tool | Purpose | Auth |
|---|---|---|
| `web_search` | Web search | parallel.ai key |
| `fetch` | HTTP GET/POST | none |
| `shell` | Run shell command (covers file I/O via `cat`, `ls`, `mv`, etc.) | none — flagged dangerous in UI |

Tools live in a single Python registry. Each is callable both directly from node code (`ctx.tools.shell(...)`) and via `call_llm(tools=[...])`. Adding a tool = adding a function to the registry; not user-extensible v1.

### 5.5 UI
- **Sidebar:** sessions list, "New Session" button, settings.
- **Canvas (React Flow):** nodes draggable, edges drawn between named ports. Visual run states (idle/running/success/error/skipped). Input/output nodes badged.
- **Chat panel:** orchestrator conversation, with collapsible tool-call cards showing each `add_node` / `run_workflow` / etc.
- **Node side panel** (on click): Monaco code editor, inputs/outputs config, model + tools config, last-run trace (logs, LLM calls with prompt+response+cost, tool calls).
- **Run panel:** input form (generated from input node), run button, cancel button, run history (last 20 per workflow), final output viewer.
- **Settings:** OpenRouter API key, parallel.ai API key, default orchestrator model, default node model.

### 5.6 Persistence
- SQLite for workflows, sessions, messages, runs, run traces.
- Filesystem for run workdirs (artifacts, files generated by orchestrator/nodes).
- Last 20 runs per workflow retained; older pruned automatically.

## 6. Non-Functional
- **Local-only**, no auth, single user.
- **Cancellation:** run subprocess is SIGTERM-able from UI.
- **Crash isolation:** node crashes / shell tool can't take down the backend (subprocess boundary).
- **Latency target:** chat and canvas updates feel real-time (<200ms round-trip on localhost via WS).

## 7. Data Model

```
Workflow   { id, name, created_at, input_node_id, output_node_id }

Node       { id, workflow_id, name, description, code,
             inputs:  [{name, type_hint, required: bool}],
             outputs: [{name, type_hint}],
             config: { model, tools_enabled: [str] },
             position: {x, y} }

Edge       { id, workflow_id,
             from: {node_id, output_name},
             to:   {node_id, input_name} }

Session    { id, workflow_id, created_at }

Message    { id, session_id, role, content, tool_calls, tool_results, ts }

Run        { id, workflow_id, kind: "test"|"user", status, inputs, outputs,
             started_at, ended_at, total_cost }

NodeRun    { id, run_id, node_id, status, inputs, outputs,
             logs, llm_calls, tool_calls, error?, duration_ms, cost }
```

## 8. Orchestrator Tool Surface

```
add_node(name, description, code, inputs, outputs, model, tools_enabled) -> node_id
remove_node(node_id)
rename_node(node_id, new_name)
configure_node(node_id, **partial_fields)
add_edge(from_node, from_output, to_node, to_input) -> edge_id
remove_edge(edge_id)
set_input_node(node_id)
set_output_node(node_id)
run_workflow(inputs: dict) -> run_id        # test run
get_run(run_id) -> {status, node_runs, error?, ...}
generate_test_data(schema_or_description) -> dict | file_path
```

When the user has edited a node's code, the orchestrator's context window includes a `user_edited: true` flag and the current code for that node so it can preserve user intent while still being free to overwrite if asked.

## 9. Tech Stack
- **Backend:** Python 3.11, FastAPI, WebSockets, SQLAlchemy + SQLite, `subprocess` for run isolation, OpenRouter HTTP client.
- **Frontend:** React + Vite, React Flow for canvas, Monaco for code editing, Tailwind, WS client.
- **Packaging:** single `uv`/`pip`-installed Python package that serves the built React app and the API on the same port.

## 10. Out of Scope (v1)
- Multi-user / auth / collab
- Cloud deploy / hosted version
- Workflow / node marketplace
- Cycles / explicit conditional edges (use in-node loops + null branching)
- Parallel fan-out execution
- User-extensible tool plugins
- Workflow versioning / undo-redo
- Cost budgets, rate limits
- Sandboxed Python execution (trusted local only)

## 11. Risks
- **Orchestrator quality is the product.** If it can't write decent Python or recover from test-run failures, the UX is dead. Need a strong system prompt and probably several iterations on tool design.
- **Shell tool is dangerous.** Trusted-local mitigates; warn loudly in UI and docs.
- **OpenRouter cost surprises.** Show running cost on every run; long-term consider per-run caps.
- **Subprocess + WebSocket plumbing for live streams** is the trickiest engineering bit — node logs and LLM token streams must flow from a child process through the backend to the frontend without buffering badly.

## 12. Milestones (rough)
1. **Skeleton:** FastAPI + React Flow + SQLite, manually-built workflows, can run a hand-coded node graph end-to-end with `call_llm` and one tool.
2. **Orchestrator v0:** tool surface wired up, can build a simple 3-node graph from a prompt without test runs.
3. **Test-run loop:** orchestrator can run, inspect, and fix.
4. **Polish:** chat refinement, code editing, run history, cost display, cancel.
5. **Tool library completion:** all three tools, settings page, real auth keys.
