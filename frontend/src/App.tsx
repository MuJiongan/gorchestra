import { useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from './components/TopBar';
import { Canvas } from './components/Canvas';
import { ChatPanel, type ChatMessage, type AssistantMessage, type ChatBlock } from './components/ChatPanel';
import { NodePanel } from './components/NodePanel';
import { RunPanel } from './components/RunPanel';
import { PortRow } from './components/ValueViewer';
import { SettingsPanel } from './components/Settings';
import { api } from './api';
import { loadSettings, SETTINGS_CHANGED_EVENT } from './localSettings';
import { ensureNotificationPermission, notifyRunFinished } from './notify';
import type {
  Workflow, WorkflowDetail, CurrentRun, RunEvent, RunStatus, NodeRunStatus,
  OrchestratorEvent, ChatHistoryMessage, Run,
} from './types';

type View = 'workflow' | 'settings';

const DEFAULT_WORKFLOW_NAME = 'untitled session';

// Tools that mutate the graph — when we see one of these complete, refresh
// the canvas detail.
const GRAPH_MUTATING_TOOLS = new Set([
  'add_node',
  'remove_node',
  'rename_node',
  'configure_node',
  'add_edge',
  'remove_edge',
  'set_input_node',
  'set_output_node',
  'clean_canvas',
]);

/** Coerce a Run's `workflow_snapshot` into a WorkflowDetail so the Canvas can
 * render it the same way it renders the live graph. The snapshot omits the
 * Workflow's user-visible `name` field; we synthesise one from the run id. */
function snapshotToDetail(run: Run): WorkflowDetail | null {
  const s = run.workflow_snapshot;
  if (!s) return null;
  return {
    id: s.id,
    name: `run ${run.id.slice(0, 8)}`,
    input_node_id: s.input_node_id,
    output_node_id: s.output_node_id,
    nodes: s.nodes.map((n) => ({
      id: n.id,
      workflow_id: s.id,
      name: n.name,
      description: n.description ?? '',
      code: n.code,
      inputs: n.inputs,
      outputs: n.outputs,
      config: n.config,
      position: n.position ?? { x: 0, y: 0 },
    })),
    edges: s.edges.map((e) => ({
      id: e.id,
      workflow_id: s.id,
      from_node_id: e.from_node_id,
      from_output: e.from_output,
      to_node_id: e.to_node_id,
      to_input: e.to_input,
    })),
  };
}

function historyToChatMessages(history: ChatHistoryMessage[]): ChatMessage[] {
  return history.map((m) => {
    if (m.role === 'user') return { role: 'user', text: m.text ?? '' };
    return {
      role: 'assistant',
      content: (m.content ?? []).map((b): ChatBlock => {
        if (b.t === 'thinking') return { t: 'thinking', text: b.text };
        if (b.t === 'p') return { t: 'p', text: b.text };
        return {
          t: 'tool',
          tool: b.tool,
          args: b.args,
          status: b.status === 'pending' ? 'pending' : b.status,
          result: b.result,
        };
      }),
    };
  });
}

/** Pick a session-name from the user's first message — same heuristic the modal used. */
function deriveSessionName(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return DEFAULT_WORKFLOW_NAME;
  return trimmed.length > 80 ? trimmed.slice(0, 77) + '…' : trimmed;
}

export default function App() {
  const [view, setView] = useState<View>('workflow');
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(true);

  // Mirror of `activeId` so async callbacks (SSE handlers, refreshDetail)
  // can read the latest value without being trapped by render-time closures.
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Workflow id → session id (one session per workflow for v0).
  const [sessionByWorkflow, setSessionByWorkflow] = useState<Record<string, string>>({});
  const [chatByWorkflow, setChatByWorkflow] = useState<Record<string, ChatMessage[]>>({});
  // Workflows whose orchestrator is currently streaming.
  const [orchestratingIds, setOrchestratingIds] = useState<Set<string>>(new Set());
  // Abort controllers for in-flight orchestrator streams, keyed by workflow id.
  const abortRefs = useRef<Record<string, AbortController>>({});

  // Live run state (Phase 4 streaming).
  const [currentRun, setCurrentRun] = useState<CurrentRun | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // When non-null, the canvas renders this run's frozen `workflow_snapshot`
  // instead of the live graph. NodePanel still works (read-only) so the user
  // can drill into a snapshot node's code and that node's run trace; the
  // live RunPanel is hidden.
  const [viewingRun, setViewingRun] = useState<Run | null>(null);
  // Selection is tracked separately for snapshot view so it doesn't leak
  // into the live canvas's selection state when the user toggles back.
  const [selectedSnapshotNodeId, setSelectedSnapshotNodeId] = useState<string | null>(null);
  const enterSnapshotView = async (runId: string) => {
    try {
      const run = await api.getRun(runId);
      if (!run.workflow_snapshot) return;
      setViewingRun(run);
      setSelectedSnapshotNodeId(null);
      setSelectedNodeId(null);
      // For runs still executing, attach to the live WS so node-state dots
      // animate on the snapshot canvas (snapshotNodeStates prefers
      // currentRun.nodeStates when its id matches viewingRun.id) and the
      // node panel's trace tab streams events. For terminal runs, the
      // historical NodeRun rows are enough — no WS needed.
      const isRunning = run.status === 'running' || run.status === 'pending';
      if (isRunning && (!currentRun || currentRun.id !== run.id)) {
        // We don't know whether this run executes on live or on a divergent
        // snapshot (the click came from the recent-runs list, which doesn't
        // distinguish). Mark it `executesOnSnapshot` so leaving snapshot
        // view to live doesn't overlay potentially-mismatched dots there;
        // snapshot view itself overlays correctly via id lookup.
        attachToRunRef.current(run.id, run.workflow_id, run.status, /* executesOnSnapshot */ true);
      }
    } catch {
      /* fetch failure: leave view as-is */
    }
  };
  const exitSnapshotView = () => {
    setViewingRun(null);
    setSelectedSnapshotNodeId(null);
  };
  // Switching workflows must drop snapshot view — the snapshot belongs to
  // whatever workflow's runs the user was browsing before.
  useEffect(() => {
    setViewingRun(null);
    setSelectedSnapshotNodeId(null);
  }, [activeId]);

  // Mirror localStorage's orchestrator-model setting so the chat header reflects
  // what's actually being sent over the wire. Refreshed on save (custom event)
  // and on cross-tab edits (`storage`).
  const [orchestratorModel, setOrchestratorModel] = useState<string>(
    () => loadSettings().default_orchestrator_model,
  );
  const [hasApiKey, setHasApiKey] = useState<boolean>(
    () => !!loadSettings().openrouter_api_key,
  );
  useEffect(() => {
    const sync = () => {
      const s = loadSettings();
      setOrchestratorModel(s.default_orchestrator_model);
      setHasApiKey(!!s.openrouter_api_key);
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const refreshWorkflows = async () => {
    const list = await api.listWorkflows();
    setWorkflows(list);
    setActiveId((cur) => cur ?? (list.length ? list[0].id : null));
    return list;
  };

  const refreshDetail = async (wid?: string) => {
    const target = wid ?? activeIdRef.current;
    if (!target) {
      if (activeIdRef.current === null) setDetail(null);
      return;
    }
    try {
      const d = await api.getWorkflow(target);
      // Race guard: if the user switched workflows while we were fetching,
      // drop the result so we don't clobber the new workflow's detail.
      if (activeIdRef.current === target) setDetail(d);
    } catch {
      if (activeIdRef.current === target) setDetail(null);
    }
  };

  // On every workflow switch, hydrate its session + chat history if we have one.
  const hydrateSession = async (wid: string) => {
    if (sessionByWorkflow[wid]) return;
    try {
      const sessions = await api.listSessions(wid);
      if (sessions.length === 0) return;
      const sid = sessions[0].id;
      const history = await api.getSessionMessages(sid);
      const bubbles = historyToChatMessages(history.messages);
      // Race: if the user typed into a brand-new workflow, handleSend may have
      // already created a session and started a stream while we were fetching.
      // Trampling the optimistic [user, placeholder] would orphan the
      // in-flight SSE updates (updateAssistant bails when the last bubble is
      // no longer a streaming assistant) — the user then sees nothing until
      // they refresh. Skip the write when newer in-memory state exists.
      setSessionByWorkflow((prev) => (prev[wid] ? prev : { ...prev, [wid]: sid }));
      setChatByWorkflow((prev) =>
        (prev[wid] && prev[wid].length > 0) ? prev : { ...prev, [wid]: bubbles },
      );
    } catch {
      /* ignore — leave panel empty */
    }
  };

  useEffect(() => {
    refreshWorkflows();
  }, []);

  useEffect(() => {
    refreshDetail();
    if (activeId) hydrateSession(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [activeId]);

  // Cancel any in-flight orchestrator streams on unmount.
  useEffect(() => () => {
    for (const ctrl of Object.values(abortRefs.current)) ctrl.abort();
    abortRefs.current = {};
  }, []);

  const activeWorkflow = workflows.find((w) => w.id === activeId) ?? null;
  const messages = activeId ? chatByWorkflow[activeId] ?? [] : [];

  // ---- orchestrator streaming -------------------------------------------

  /**
   * Stream a user message to a session. Maintains one growing assistant
   * bubble in `chatByWorkflow[wid]` and updates the canvas live as graph
   * mutators land.
   */
  const streamToOrchestrator = async (wid: string, sid: string, text: string) => {
    abortRefs.current[wid]?.abort();
    const ctrl = new AbortController();
    abortRefs.current[wid] = ctrl;

    setOrchestratingIds((prev) => {
      const s = new Set(prev);
      s.add(wid);
      return s;
    });

    // Optimistically add the user bubble + a streaming assistant placeholder.
    const placeholder: AssistantMessage = { role: 'assistant', content: [], streaming: true };
    setChatByWorkflow((prev) => ({
      ...prev,
      [wid]: [...(prev[wid] ?? []), { role: 'user', text }, placeholder],
    }));

    const updateAssistant = (mut: (a: AssistantMessage) => AssistantMessage) => {
      setChatByWorkflow((prev) => {
        const cur = prev[wid] ?? [];
        if (cur.length === 0) return prev;
        const last = cur[cur.length - 1];
        if (last.role !== 'assistant') return prev;
        const next: ChatMessage[] = [...cur.slice(0, -1), mut(last)];
        return { ...prev, [wid]: next };
      });
    };

    const handleEvent = (ev: OrchestratorEvent) => {
      if (ev.kind === 'assistant_thinking_chunk' && ev.text) {
        // Reasoning streams before visible content. Append to the trailing
        // thinking block when it's still live (no p/tool block has appeared
        // since); otherwise start a fresh thinking block — the model is
        // taking a second think mid-turn.
        updateAssistant((a) => {
          const content = [...a.content];
          const last = content[content.length - 1];
          if (last && last.t === 'thinking') {
            content[content.length - 1] = { ...last, text: last.text + ev.text };
          } else {
            content.push({ t: 'thinking', text: ev.text });
          }
          return { ...a, content };
        });
      } else if (ev.kind === 'assistant_text_chunk' && ev.text) {
        updateAssistant((a) => {
          const content = [...a.content];
          const last = content[content.length - 1];
          if (last && last.t === 'p') {
            content[content.length - 1] = { ...last, text: last.text + ev.text };
          } else {
            content.push({ t: 'p', text: ev.text });
          }
          return { ...a, content };
        });
      } else if (ev.kind === 'assistant_text' && ev.text) {
        updateAssistant((a) => {
          const last = a.content[a.content.length - 1];
          if (last && last.t === 'p' && last.text) return a;
          return { ...a, content: [...a.content, { t: 'p', text: ev.text }] };
        });
      } else if (ev.kind === 'tool_call_start') {
        updateAssistant((a) => ({
          ...a,
          content: [...a.content, { t: 'tool', tool: ev.tool, args: ev.args, status: 'pending' }],
        }));
      } else if (ev.kind === 'tool_call_end') {
        updateAssistant((a) => {
          const content = [...a.content];
          for (let i = content.length - 1; i >= 0; i--) {
            const b = content[i];
            if (b.t === 'tool' && b.tool === ev.tool && b.status === 'pending') {
              content[i] = { ...b, status: ev.status, result: ev.result };
              break;
            }
          }
          return { ...a, content };
        });
        if (ev.status === 'ok' && GRAPH_MUTATING_TOOLS.has(ev.tool)) {
          refreshDetail(wid);
        }
      } else if (ev.kind === 'run_started') {
        // Orchestrator kicked off a run via `run_workflow`. Attach the run
        // panel to it via the same code path the Run button uses, so the
        // user gets live progress while the orchestrator turn awaits the
        // result.
        attachToRunRef.current(ev.run_id, ev.workflow_id);
      } else if (ev.kind === 'error') {
        updateAssistant((a) => ({
          ...a,
          content: [...a.content, { t: 'p', text: `*[error]* ${ev.message}` }],
        }));
      } else if (ev.kind === 'done') {
        updateAssistant((a) => ({ ...a, streaming: false }));
      }
    };

    try {
      await api.streamUserMessage(sid, text, handleEvent, ctrl.signal);
    } catch (e) {
      if (ctrl.signal.aborted) {
        updateAssistant((a) => ({ ...a, streaming: false }));
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        updateAssistant((a) => ({
          ...a,
          streaming: false,
          content: [...a.content, { t: 'p', text: `*[stream failed]* ${msg}` }],
        }));
      }
    } finally {
      refreshDetail(wid);
      setOrchestratingIds((prev) => {
        const s = new Set(prev);
        s.delete(wid);
        return s;
      });
      if (abortRefs.current[wid] === ctrl) delete abortRefs.current[wid];
    }
  };

  /**
   * Send a user message. Lazily creates a workflow / session if one doesn't
   * exist yet, so the user can land on the workspace and just start typing.
   * The first message also becomes the workflow's name (when it's still the
   * "untitled session" placeholder).
   */
  const handleSend = async (text: string) => {
    let wid = activeId;
    let isFirstMessage = false;

    if (!wid) {
      // No active session — create one named after this message.
      const w = await api.createWorkflow(deriveSessionName(text));
      wid = w.id;
      isFirstMessage = true;
      setWorkflows((prev) => (prev.find((p) => p.id === w.id) ? prev : [w, ...prev]));
      setActiveId(w.id);
      setSelectedNodeId(null);
    }

    let sid = sessionByWorkflow[wid];
    if (!sid) {
      const session = await api.createSession(wid);
      sid = session.id;
      setSessionByWorkflow((prev) => ({ ...prev, [wid!]: session.id }));
      setChatByWorkflow((prev) => (prev[wid!] ? prev : { ...prev, [wid!]: [] }));
    }

    // If the workflow is still the placeholder name, rename it now.
    const cur = workflows.find((w) => w.id === wid);
    if (!isFirstMessage && cur && cur.name === DEFAULT_WORKFLOW_NAME) {
      const nextName = deriveSessionName(text);
      api.patchWorkflow(wid, { name: nextName }).then(() => refreshWorkflows()).catch(() => {});
    }

    streamToOrchestrator(wid, sid, text);
  };

  const cancelOrchestrator = async () => {
    if (!activeId) return;
    const sid = sessionByWorkflow[activeId];
    if (!sid) return;
    try { await api.cancelOrchestratorTurn(sid); } catch { /* ignore */ }
    abortRefs.current[activeId]?.abort();
  };

  /** "new" button — spawn a fresh empty session and focus it. */
  const handleNew = async () => {
    const w = await api.createWorkflow(DEFAULT_WORKFLOW_NAME);
    setWorkflows((prev) => [w, ...prev.filter((p) => p.id !== w.id)]);
    setActiveId(w.id);
    setView('workflow');
    setSelectedNodeId(null);
    setCurrentRun(null);
    setChatByWorkflow((prev) => ({ ...prev, [w.id]: [] }));
  };

  const handleDelete = async (id: string) => {
    await api.deleteWorkflow(id);
    if (id === activeId) {
      setActiveId(null);
      setDetail(null);
      setCurrentRun(null);
    }
    setChatByWorkflow((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
    setSessionByWorkflow((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
    abortRefs.current[id]?.abort();
    delete abortRefs.current[id];
    await refreshWorkflows();
  };

  const handleRename = async (id: string, name: string) => {
    await api.patchWorkflow(id, { name });
    await refreshWorkflows();
    if (id === activeId) await refreshDetail();
  };

  /** Open the run panel and attach a WS to the given run id. Used both by
   *  the manual Run button (after its POST resolves) and by the chat handler
   *  when the orchestrator emits a `run_started` event for a run it kicked off. */
  const attachToRun = (
    runId: string,
    workflowId: string,
    initialStatus: RunStatus = 'running',
    executesOnSnapshot: boolean = false,
  ) => {
    ensureNotificationPermission();
    const workflowName =
      workflows.find((w) => w.id === workflowId)?.name ?? 'workflow';
    const startedAt = Date.now();
    setCurrentRun({
      id: runId,
      workflow_id: workflowId,
      status: initialStatus,
      startedAt,
      events: [],
      nodeStates: {},
      finalOutputs: null,
      error: null,
      totalCost: 0,
      executesOnSnapshot,
    });
    wsRef.current?.close();
    const ws = new WebSocket(api.runEventsUrl(runId));
    wsRef.current = ws;
    ws.onmessage = (e) => {
      let ev: RunEvent;
      try { ev = JSON.parse(e.data) as RunEvent; } catch { return; }
      if (ev.type === 'run_finished') {
        notifyRunFinished({
          runId,
          workflowName,
          status: ev.status,
          error: ev.error,
          outputs: ev.outputs,
          totalCost: ev.total_cost,
          durationMs: Date.now() - startedAt,
        });
      }
      setCurrentRun((cur) => {
        if (!cur || cur.id !== runId) return cur;
        const nextStates = { ...cur.nodeStates };
        let nextStatus = cur.status;
        let finalOutputs = cur.finalOutputs;
        let error = cur.error;
        let totalCost = cur.totalCost;
        if (ev.type === 'node_started') nextStates[ev.node_id] = 'running';
        else if (ev.type === 'node_finished') nextStates[ev.node_id] = ev.status;
        else if (ev.type === 'run_finished') {
          nextStatus = ev.status;
          finalOutputs = ev.outputs;
          error = ev.error;
          totalCost = ev.total_cost;
          // Defensive sweep: if the runner ever fails to emit node_finished
          // for a node (escaped exception, dropped event, cancel mid-flight),
          // the dot would be stuck on running/pending forever. Once
          // run_finished arrives the runner is done — force any non-terminal
          // state to a sensible terminal one. "running" → "error" (the node
          // started but never resolved); "pending" → "skipped" (never
          // started). On a cancelled run prefer "skipped" for both — those
          // nodes didn't fail, they just got interrupted.
          for (const nid of Object.keys(nextStates)) {
            const s = nextStates[nid];
            if (s === 'running') {
              nextStates[nid] = ev.status === 'cancelled' ? 'skipped' : 'error';
            } else if (s === 'pending') {
              nextStates[nid] = 'skipped';
            }
          }
        }
        return {
          ...cur,
          events: [...cur.events, ev],
          nodeStates: nextStates,
          status: nextStatus,
          finalOutputs,
          error,
          totalCost,
        };
      });
    };
    ws.onerror = () => { /* keep state; close handler will fire */ };
    ws.onclose = () => { if (wsRef.current === ws) wsRef.current = null; };
  };

  const startRun = async (inputs: Record<string, unknown>) => {
    if (!detail) return;
    const run = await api.startRun(detail.id, inputs);
    attachToRun(run.id, detail.id, run.status);
  };

  const attachToRunRef = useRef(attachToRun);
  useEffect(() => { attachToRunRef.current = attachToRun; });

  const cancelRun = async () => {
    if (!currentRun) return;
    try { await api.cancelRun(currentRun.id); } catch { /* ignore */ }
  };

  /** Forward an error from a run/node into the orchestrator chat as a user message. */
  const sendErrorToOrchestrator = (message: string) => {
    setChatOpen(true);
    handleSend(message);
  };

  const selectedNode = detail?.nodes.find((n) => n.id === selectedNodeId);
  const isOrchestrating = !!activeId && orchestratingIds.has(activeId);

  const topBarStatus: 'idle' | 'building' | 'running' | 'ready' = isOrchestrating
    ? 'building'
    : currentRun?.status === 'running' || currentRun?.status === 'pending'
      ? 'running'
      : currentRun?.status === 'success'
        ? 'ready'
        : 'idle';

  // Per-node state dots for snapshot view. When the viewed run is the
  // currently-attached one (rerun-from-snapshot, mid-execution), use live
  // states from the WS so the dots animate on the snapshot canvas.
  // Otherwise use the historical NodeRun rows (frozen post-completion).
  // The live canvas has its own overlay below — this one's just for
  // snapshot view.
  const snapshotNodeStates: Record<string, NodeRunStatus> = viewingRun
    ? currentRun && currentRun.id === viewingRun.id
      ? currentRun.nodeStates
      : Object.fromEntries(
          viewingRun.node_runs.map((nr) => [nr.node_id, nr.status]),
        )
    : {};

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        position: 'relative',
        background: 'var(--paper)',
        color: 'var(--ink)',
      }}
    >
      <TopBar
        workflows={workflows}
        activeWorkflow={activeWorkflow}
        onSelect={(id) => {
          setActiveId(id);
          setView('workflow');
          setSelectedNodeId(null);
          setCurrentRun(null);
        }}
        onNew={handleNew}
        onRename={handleRename}
        onDelete={handleDelete}
        onOpenSettings={() => setView('settings')}
        onOpenRun={() => {
          // RunPanel is the default right-side surface — "Run" in the
          // top bar is now just a deselect shortcut so it returns to view.
          setSelectedNodeId(null);
        }}
        runDisabled={!detail}
        status={topBarStatus}
      />

      <main style={{ height: 'calc(100vh - 54px)', position: 'relative' }}>
        {view === 'settings' && <SettingsPanel onClose={() => setView('workflow')} />}

        {view === 'workflow' &&
          (!detail || (detail.nodes.length === 0 && messages.length === 0)) && (
            <Hero
              hasApiKey={hasApiKey}
              disabled={isOrchestrating}
              onSend={(text) => {
                setChatOpen(true);
                handleSend(text);
              }}
              onOpenSettings={() => setView('settings')}
            />
          )}

        {view === 'workflow' && detail && !(detail.nodes.length === 0 && messages.length === 0) && (
          <>
            <div style={{ display: 'flex', height: '100%' }}>
              {/* left 2/5 — canvas */}
              <div
                style={{
                  flex: 2,
                  display: 'flex',
                  flexDirection: 'column',
                  borderRight: '1px solid var(--rule)',
                  minWidth: 0,
                }}
              >
                {viewingRun && (
                  <SnapshotBanner run={viewingRun} onExit={exitSnapshotView} />
                )}
                {/* Canvas (and the empty-canvas placeholder) need
                 * `position: relative` to host React Flow's absolute layout.
                 * Banner stacks above via flex; this wrapper takes the rest. */}
                <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
                {viewingRun ? (
                  // Viewing a run's frozen snapshot. Selection is enabled so
                  // the user can drill into a node's code + run trace, but
                  // editing is disabled (NodePanel renders read-only).
                  (() => {
                    const snapDetail = snapshotToDetail(viewingRun);
                    return snapDetail ? (
                      <Canvas
                        detail={snapDetail}
                        selectedNodeId={selectedSnapshotNodeId}
                        onSelectNode={(id) => setSelectedSnapshotNodeId(id)}
                        nodeStates={snapshotNodeStates}
                      />
                    ) : null;
                  })()
                ) : detail ? (
                  <Canvas
                    detail={detail}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={(id) => setSelectedNodeId(id)}
                    // Overlay live node states for runs that execute on the
                    // live graph (manual run, orchestrator-triggered run).
                    // Skip for snapshot reruns — their snapshot can diverge
                    // from live, so dots may apply to wrong nodes or miss
                    // entirely. Snapshot view is the right place to watch
                    // those; the rerun handler keeps the user there.
                    nodeStates={
                      currentRun &&
                      currentRun.workflow_id === detail.id &&
                      !currentRun.executesOnSnapshot
                        ? currentRun.nodeStates
                        : undefined
                    }
                  />
                ) : (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 10,
                      color: 'var(--ink-4)',
                      padding: 24,
                    }}
                    className="dotgrid"
                  >
                    <div className="serif" style={{ fontStyle: 'italic', fontSize: 22, color: 'var(--ink-3)' }}>
                      an empty canvas.
                    </div>
                    <div style={{ fontSize: 13, maxWidth: 320, textAlign: 'center', lineHeight: 1.6 }}>
                      open the chat to describe a problem, or click{' '}
                      <span className="italic-em">new</span> to start a session.
                    </div>
                  </div>
                )}
                </div>
              </div>

              {/* right 3/5 — node configuration / inputs / outputs */}
              <div style={{ flex: 3, position: 'relative', minWidth: 0 }}>
                {viewingRun && (() => {
                  const snapDetail = snapshotToDetail(viewingRun);
                  const snapNode = snapDetail?.nodes.find(
                    (n) => n.id === selectedSnapshotNodeId,
                  );
                  if (snapDetail && snapNode) {
                    return (
                      <NodePanel
                        node={snapNode}
                        workflow={snapDetail}
                        onClose={() => setSelectedSnapshotNodeId(null)}
                        onChange={() => {}}
                        readOnly
                        pinnedRun={viewingRun}
                        // Pass currentRun so the trace tab streams live
                        // events when this snapshot view is bound to an
                        // in-flight run (rerun-from-snapshot, or recent-run
                        // click on a running run). Without it, the trace
                        // would fall back to viewingRun.node_runs — empty
                        // for runs that haven't materialised yet.
                        currentRun={currentRun}
                        onSendErrorToOrchestrator={sendErrorToOrchestrator}
                      />
                    );
                  }
                  return (
                    <SnapshotRunPanel
                      run={viewingRun}
                      onExit={exitSnapshotView}
                      // Block rerun while any run on this workflow is in
                      // flight — server has no guard yet, so we hold the
                      // line in the UI to avoid stacking parallel runs.
                      runInProgress={
                        !!currentRun &&
                        currentRun.workflow_id === viewingRun.workflow_id &&
                        (currentRun.status === 'running' ||
                          currentRun.status === 'pending')
                      }
                      onRerun={async (inputs) => {
                        const newRun = await api.rerunFromSnapshot(
                          viewingRun.id,
                          inputs,
                        );
                        // The rerun executes against the snapshot's graph
                        // (which may diverge from live), so the live canvas
                        // can't show its progress reliably. Stay in
                        // snapshot view — swap viewingRun to the new run
                        // and attach the WS so node-state dots animate on
                        // the snapshot canvas in real time. The user exits
                        // via "← live" on the SnapshotBanner whenever
                        // they're done watching.
                        setViewingRun(newRun);
                        setSelectedSnapshotNodeId(null);
                        attachToRunRef.current(
                          newRun.id,
                          newRun.workflow_id,
                          newRun.status,
                          /* executesOnSnapshot */ true,
                        );
                      }}
                    />
                  );
                })()}
                {!viewingRun && detail && selectedNode && (
                  <NodePanel
                    node={selectedNode}
                    workflow={detail}
                    onClose={() => setSelectedNodeId(null)}
                    onChange={refreshDetail}
                    currentRun={currentRun}
                    onSendErrorToOrchestrator={sendErrorToOrchestrator}
                  />
                )}
                {!viewingRun && detail && !selectedNode && (
                  <RunPanel
                    workflow={detail}
                    currentRun={currentRun}
                    onStart={startRun}
                    onCancel={cancelRun}
                    onViewRunOnCanvas={enterSnapshotView}
                    orchestrating={isOrchestrating}
                  />
                )}
                {!viewingRun && !detail && (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 12,
                      color: 'var(--ink-4)',
                      padding: 24,
                    }}
                  >
                    <div className="serif" style={{ fontStyle: 'italic', fontSize: 22, color: 'var(--ink-3)' }}>
                      no session yet.
                    </div>
                    <div style={{ fontSize: 13, maxWidth: 420, textAlign: 'center', lineHeight: 1.6 }}>
                      open the chat at the bottom-right and describe a problem, or click{' '}
                      <span className="italic-em">new</span> to start a fresh session.
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* floating chatbot — launcher when closed, panel when open. */}
            {!chatOpen && (
              <button
                onClick={() => setChatOpen(true)}
                className="chat-tab-enter"
                style={{
                  position: 'fixed',
                  bottom: 80,
                  right: 0,
                  width: 50,
                  height: 50,
                  padding: 0,
                  background: 'var(--paper)',
                  border: '1px solid var(--rule)',
                  borderRight: 'none',
                  borderTopLeftRadius: 4,
                  borderBottomLeftRadius: 4,
                  borderTopRightRadius: 0,
                  borderBottomRightRadius: 0,
                  cursor: 'pointer',
                  zIndex: 50,
                  boxShadow: '-6px 0 22px -10px rgba(26, 23, 20, 0.22), -1px 0 4px -2px rgba(26, 23, 20, 0.14)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  color: 'var(--ink)',
                }}
                title="open the orchestrator"
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  style={{ color: 'var(--ink-2)' }}
                >
                  <path d="M6 4h12a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-7l-4 3v-3H6a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z" />
                </svg>
                {isOrchestrating && (
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: 999,
                      background: 'var(--accent, #c08552)',
                      animation: 'pulse 1.4s ease-in-out infinite',
                    }}
                    aria-label="orchestrator is working"
                  />
                )}
              </button>
            )}
            {chatOpen && (
              <div
                className="chat-enter"
                style={{
                  position: 'fixed',
                  bottom: 24,
                  right: 24,
                  width: 'min(440px, calc(100vw - 48px))',
                  height: 'min(640px, calc(100vh - 102px))',
                  background: 'var(--paper)',
                  border: '1px solid var(--rule)',
                  borderRadius: 6,
                  display: 'flex',
                  flexDirection: 'column',
                  zIndex: 50,
                  boxShadow: '0 24px 60px -20px rgba(26, 23, 20, 0.35), 0 8px 20px -8px rgba(26, 23, 20, 0.18)',
                  overflow: 'hidden',
                }}
              >
                <div style={{ flex: 1, minHeight: 0 }}>
                  <ChatPanel
                    messages={messages}
                    onSend={handleSend}
                    onCancel={cancelOrchestrator}
                    disabled={isOrchestrating}
                    sessionTitle={activeWorkflow?.name}
                    modelLabel={orchestratorModel}
                    onClose={() => setChatOpen(false)}
                    onViewRun={(runId) => {
                      void enterSnapshotView(runId);
                    }}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Snapshot view — when the user clicks "view this run" (from the chat card or
// the run-history list), the canvas swaps to render the run's frozen
// `workflow_snapshot`. The banner keeps the read-only state visible at all
// times; the right-side panel summarises the run and offers a way back.
// ---------------------------------------------------------------------------

function SnapshotBanner({ run, onExit }: { run: Run; onExit: () => void }) {
  const statusColor =
    run.status === 'success'
      ? 'var(--state-ok)'
      : run.status === 'error'
        ? 'var(--state-err)'
        : 'var(--ink-4)';
  const statusGlyph =
    run.status === 'success' ? '✓' : run.status === 'error' ? '×' : '·';
  return (
    <div
      style={{
        padding: '6px 12px',
        background: 'var(--paper-2)',
        borderBottom: '1px solid var(--rule)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 11.5,
        minWidth: 0,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 6,
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        <span style={{ color: statusColor, fontSize: 10 }}>{statusGlyph}</span>
        <span
          className="serif"
          style={{
            fontStyle: 'italic',
            color: 'var(--ink-3)',
            fontSize: 12,
            whiteSpace: 'nowrap',
          }}
        >
          snapshot
        </span>
        <span
          className="mono"
          style={{
            color: 'var(--ink-4)',
            fontSize: 10.5,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {run.id.slice(0, 8)}
        </span>
      </span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onExit}
        style={{
          background: 'transparent',
          border: 0,
          padding: '2px 0',
          cursor: 'pointer',
          color: 'var(--accent-ink)',
          fontSize: 11.5,
          fontFamily: 'var(--serif)',
          fontStyle: 'italic',
          whiteSpace: 'nowrap',
        }}
        title="return to the live, editable canvas"
      >
        ← live
      </button>
    </div>
  );
}

function SnapshotRunPanel({
  run,
  onExit,
  onRerun,
  runInProgress,
}: {
  run: Run;
  onExit: () => void;
  onRerun: (inputs: Record<string, unknown>) => Promise<void>;
  /** True when another run on this workflow is still executing. The UI
   * blocks rerun in that case so we don't stack parallel runs against
   * one workflow. */
  runInProgress?: boolean;
}) {
  const errored = run.node_runs.filter((nr) => nr.status === 'error');
  const inputs = Object.entries(run.inputs ?? {});
  const outputs = Object.entries(run.outputs ?? {});

  // Re-run form state. The snapshot's input node defines the port shape;
  // we pre-fill each field with the prior run's value (JSON-stringified)
  // so the user can tweak just one knob and rerun.
  const inputPorts = (() => {
    const snap = run.workflow_snapshot;
    if (!snap) return [];
    const inputNode = snap.nodes.find((n) => n.id === snap.input_node_id);
    return inputNode?.inputs ?? [];
  })();
  const initialFormValues = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const p of inputPorts) {
      const prior = (run.inputs ?? {})[p.name];
      out[p.name] = prior === undefined || prior === null
        ? ''
        : typeof prior === 'string'
          ? prior
          : JSON.stringify(prior);
    }
    return out;
  }, [run.id, inputPorts]);
  const [formOpen, setFormOpen] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, string>>(initialFormValues);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  useEffect(() => {
    setFormOpen(false);
    setFormValues(initialFormValues);
    setSubmitError(null);
  }, [run.id, initialFormValues]);

  const submitRerun = async () => {
    const parsed: Record<string, unknown> = {};
    for (const p of inputPorts) {
      const raw = formValues[p.name];
      if (raw === undefined || raw === '') {
        parsed[p.name] = null;
        continue;
      }
      try { parsed[p.name] = JSON.parse(raw); } catch { parsed[p.name] = raw; }
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onRerun(parsed);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        padding: '20px 24px',
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div>
        <div className="smallcaps" style={{ color: 'var(--ink-3)', marginBottom: 4 }}>
          run details
        </div>
        <div
          className="serif"
          style={{ fontSize: 18, fontStyle: 'italic', color: 'var(--ink)' }}
        >
          run {run.id.slice(0, 8)}
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          columnGap: 14,
          rowGap: 4,
          fontSize: 12,
        }}
      >
        <span className="smallcaps" style={{ color: 'var(--ink-4)' }}>status</span>
        <span className="mono" style={{ fontSize: 11 }}>
          {run.status}
        </span>
        <span className="smallcaps" style={{ color: 'var(--ink-4)' }}>cost</span>
        <span className="mono" style={{ fontSize: 11 }}>
          ${(run.total_cost ?? 0).toFixed(4)}
        </span>
        <span className="smallcaps" style={{ color: 'var(--ink-4)' }}>nodes</span>
        <span className="mono" style={{ fontSize: 11 }}>
          {run.workflow_snapshot?.nodes.length ?? 0} ·{' '}
          {run.node_runs.filter((n) => n.status === 'success').length} ok ·{' '}
          {errored.length} err
        </span>
      </div>

      {errored.length > 0 && (
        <div>
          <div className="smallcaps" style={{ color: 'var(--ink-3)', marginBottom: 6 }}>
            errors
          </div>
          {errored.map((nr) => {
            const nodeName =
              run.workflow_snapshot?.nodes.find((n) => n.id === nr.node_id)?.name ??
              nr.node_id;
            return (
              <div
                key={nr.id}
                style={{
                  background: 'rgba(180, 60, 60, 0.06)',
                  borderLeft: '2px solid var(--state-err)',
                  padding: '6px 10px',
                  marginBottom: 6,
                  fontSize: 12,
                }}
              >
                <div className="mono" style={{ color: 'var(--state-err)' }}>
                  {nodeName}
                </div>
                <div
                  className="serif"
                  style={{ fontStyle: 'italic', color: 'var(--ink-2)' }}
                >
                  {nr.error}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* rerun affordance — visible whenever the snapshot is runnable
          (has a designated input node). When the input node has no input
          ports, the form skips field rendering and just confirms execute. */}
      {run.workflow_snapshot?.input_node_id && !formOpen && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            disabled={!!runInProgress}
            className="smallcaps"
            style={{
              background: 'transparent',
              border: '1px solid var(--rule)',
              padding: '6px 12px',
              cursor: runInProgress ? 'not-allowed' : 'pointer',
              color: runInProgress ? 'var(--ink-4)' : 'var(--accent-ink)',
              fontSize: 10,
              fontFamily: 'var(--serif)',
              fontStyle: 'italic',
              textTransform: 'none',
              letterSpacing: 0,
              opacity: runInProgress ? 0.6 : 1,
            }}
            title={
              runInProgress
                ? 'a run is already in progress on this workflow — wait for it to finish'
                : inputPorts.length > 0
                  ? 'run this exact graph again with edited inputs'
                  : 'run this exact graph again'
            }
          >
            {inputPorts.length > 0 ? 'rerun with new inputs →' : 'rerun →'}
          </button>
          {runInProgress && (
            <span
              className="serif"
              style={{ fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 11.5 }}
            >
              a run is already in flight
            </span>
          )}
        </div>
      )}

      {formOpen && (
        <div
          style={{
            border: '1px solid var(--rule)',
            background: 'var(--paper-2)',
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
            }}
          >
            <span className="smallcaps" style={{ color: 'var(--ink-3)' }}>
              {inputPorts.length > 0 ? 'new inputs' : 'rerun'}
            </span>
            <span
              className="serif"
              style={{ fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 11.5 }}
            >
              · runs the snapshot, not the live graph
            </span>
          </div>
          {inputPorts.length === 0 && (
            <div
              className="serif"
              style={{ fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 12 }}
            >
              this workflow takes no inputs.
            </div>
          )}
          {inputPorts.map((p) => (
            <label
              key={p.name}
              style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
            >
              <span
                className="mono"
                style={{ fontSize: 10.5, color: 'var(--ink-3)' }}
              >
                {p.name}
                {p.type_hint && p.type_hint !== 'any' && (
                  <span style={{ color: 'var(--ink-4)' }}>
                    {' · '}
                    {p.type_hint}
                  </span>
                )}
                {p.required && (
                  <span style={{ color: 'var(--accent-ink)', marginLeft: 6 }}>·</span>
                )}
              </span>
              <textarea
                value={formValues[p.name] ?? ''}
                onChange={(e) =>
                  setFormValues((prev) => ({ ...prev, [p.name]: e.target.value }))
                }
                rows={1}
                className="mono"
                style={{
                  fontSize: 11.5,
                  fontFamily: 'var(--mono)',
                  background: 'var(--paper)',
                  border: '1px solid var(--rule)',
                  padding: '6px 8px',
                  resize: 'vertical',
                  minHeight: 28,
                  color: 'var(--ink)',
                }}
                disabled={submitting}
              />
            </label>
          ))}
          {submitError && (
            <div
              className="serif"
              style={{
                fontStyle: 'italic',
                color: 'var(--state-err)',
                fontSize: 11.5,
              }}
            >
              {submitError}
            </div>
          )}
          {runInProgress && (
            <div
              className="serif"
              style={{
                fontStyle: 'italic',
                color: 'var(--state-err)',
                fontSize: 11.5,
              }}
            >
              another run is in flight on this workflow — wait for it to finish.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={submitRerun}
              disabled={submitting || !!runInProgress}
              className="ed-btn ed-btn--primary"
              style={{ fontSize: 11 }}
              title={
                runInProgress
                  ? 'a run is already in progress on this workflow'
                  : undefined
              }
            >
              {submitting ? 'starting…' : 'execute'}{' '}
              <span className="ed-btn__mark">→</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setFormOpen(false);
                setFormValues(initialFormValues);
                setSubmitError(null);
              }}
              disabled={submitting}
              className="ed-btn"
              style={{ fontSize: 11 }}
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {inputs.length > 0 && (
        <div>
          <div className="smallcaps" style={{ color: 'var(--ink-3)', marginBottom: 6 }}>
            inputs
          </div>
          {inputs.map(([k, v]) => (
            <PortRow
              key={k}
              name={k}
              value={v}
              viewerTitle={`run ${run.id.slice(0, 8)} · ${k}`}
              viewerSubtitle="input"
            />
          ))}
        </div>
      )}

      {outputs.length > 0 && (
        <div>
          <div className="smallcaps" style={{ color: 'var(--ink-3)', marginBottom: 6 }}>
            outputs
          </div>
          {outputs.map(([k, v]) => (
            <PortRow
              key={k}
              name={k}
              value={v}
              viewerTitle={`run ${run.id.slice(0, 8)} · ${k}`}
              viewerSubtitle="output"
            />
          ))}
        </div>
      )}

      <span style={{ flex: 1 }} />

      <button
        type="button"
        onClick={onExit}
        className="smallcaps"
        style={{
          alignSelf: 'flex-start',
          background: 'transparent',
          border: '1px solid var(--rule)',
          padding: '6px 12px',
          cursor: 'pointer',
          color: 'var(--accent-ink)',
          fontSize: 10,
          fontFamily: 'var(--serif)',
          fontStyle: 'italic',
          textTransform: 'none',
          letterSpacing: 0,
        }}
      >
        ← back to live
      </button>
    </div>
  );
}

function Hero({
  hasApiKey,
  disabled,
  onSend,
  onOpenSettings,
}: {
  hasApiKey: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onOpenSettings: () => void;
}) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (hasApiKey) taRef.current?.focus();
  }, [hasApiKey]);

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    setText('');
    onSend(t);
  };

  return (
    <div
      className="dotgrid"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Extra 54px on the bottom (= top-bar height) so the visual center of
        // the hero aligns with the viewport center, not the center of <main>.
        padding: '40px 24px 94px',
        boxSizing: 'border-box',
        overflow: 'auto',
      }}
    >
      <div style={{ width: '100%', maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <span className="smallcaps" style={{ color: 'var(--ink-4)' }}>orchestra</span>
        <h1
          className="serif"
          style={{
            margin: 0,
            fontSize: 40,
            fontStyle: 'italic',
            fontWeight: 400,
            letterSpacing: '-0.01em',
            color: 'var(--ink)',
            lineHeight: 1.15,
          }}
        >
          {hasApiKey ? 'describe what you want to achieve.' : 'set up your keys to begin.'}
        </h1>
        <p
          className="serif"
          style={{
            margin: 0,
            fontStyle: 'italic',
            fontSize: 15,
            color: 'var(--ink-3)',
            lineHeight: 1.55,
          }}
        >
          {hasApiKey
            ? 'the orchestrator will spawn a team of agents to help you — refine and run when ready.'
            : 'the orchestrator runs on your openrouter key. add it once, then describe a problem and orchestra will spawn a team of agents to help you.'}
        </p>

        {hasApiKey ? (
          <>
            <div
              style={{
                marginTop: 8,
                background: 'var(--paper)',
                border: '1px solid var(--rule)',
                borderRadius: 6,
                padding: '14px 16px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                boxShadow: '0 1px 0 rgba(26, 23, 20, 0.04), 0 12px 32px -16px rgba(26, 23, 20, 0.18)',
              }}
            >
              <textarea
                ref={taRef}
                rows={3}
                className="field"
                placeholder="e.g. take a company name, search recent news, and produce a sentiment-labeled briefing"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submit();
                  }
                }}
                style={{
                  resize: 'none',
                  fontFamily: 'var(--serif)',
                  fontStyle: 'italic',
                  fontSize: 16,
                  lineHeight: 1.5,
                  background: 'transparent',
                  border: 0,
                  outline: 'none',
                  padding: 0,
                  color: 'var(--ink)',
                }}
                disabled={disabled}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  className="serif"
                  style={{ fontStyle: 'italic', fontSize: 11.5, color: 'var(--ink-4)' }}
                >
                  ⌘ + enter to send
                </span>
                <span style={{ flex: 1 }} />
                <button
                  className="btn-ink"
                  onClick={submit}
                  disabled={disabled || !text.trim()}
                >
                  ask orchestra <span className="italic-em">→</span>
                </button>
              </div>
            </div>
          </>
        ) : (
          <div
            style={{
              marginTop: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              background: 'var(--paper)',
              border: '1px solid var(--rule)',
              borderRadius: 6,
              padding: '18px 20px',
            }}
          >
            <div style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6 }}>
              you'll need an{' '}
              <span className="mono" style={{ fontSize: 12 }}>openrouter</span> api key — keys are
              stored in your browser only.
            </div>
            <div>
              <button className="btn-ink" onClick={onOpenSettings}>
                open settings <span className="italic-em">→</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
