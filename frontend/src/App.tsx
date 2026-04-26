import { useEffect, useRef, useState } from 'react';
import { TopBar } from './components/TopBar';
import { Canvas } from './components/Canvas';
import { ChatPanel, type ChatMessage, type AssistantMessage, type ChatBlock } from './components/ChatPanel';
import { NodePanel } from './components/NodePanel';
import { RunPanel } from './components/RunPanel';
import { SettingsPanel } from './components/Settings';
import { api } from './api';
import { loadSettings, SETTINGS_CHANGED_EVENT } from './localSettings';
import type {
  Workflow, WorkflowDetail, CurrentRun, RunEvent, NodeRunStatus,
  OrchestratorEvent, ChatHistoryMessage,
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
]);

function historyToChatMessages(history: ChatHistoryMessage[]): ChatMessage[] {
  return history.map((m) => {
    if (m.role === 'user') return { role: 'user', text: m.text ?? '' };
    return {
      role: 'assistant',
      content: (m.content ?? []).map((b): ChatBlock => {
        if (b.t === 'thinking') return { t: 'thinking', text: b.text };
        if (b.t === 'p') return { t: 'p', text: b.text };
        return { t: 'tool', tool: b.tool, args: b.args, status: b.status === 'pending' ? 'pending' : b.status };
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
  const [showRunPanel, setShowRunPanel] = useState(false);

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

  // Mirror localStorage's orchestrator-model setting so the chat header reflects
  // what's actually being sent over the wire. Refreshed on save (custom event)
  // and on cross-tab edits (`storage`).
  const [orchestratorModel, setOrchestratorModel] = useState<string>(
    () => loadSettings().default_orchestrator_model,
  );
  useEffect(() => {
    const sync = () => setOrchestratorModel(loadSettings().default_orchestrator_model);
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

  const refreshDetail = async () => {
    if (!activeId) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await api.getWorkflow(activeId));
    } catch {
      setDetail(null);
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
              content[i] = { ...b, status: ev.status };
              break;
            }
          }
          return { ...a, content };
        });
        if (ev.status === 'ok' && GRAPH_MUTATING_TOOLS.has(ev.tool)) {
          if (activeId === wid) refreshDetail();
        }
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
      if (activeId === wid) refreshDetail();
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
      setShowRunPanel(false);
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
    setShowRunPanel(false);
    setCurrentRun(null);
    setChatByWorkflow((prev) => ({ ...prev, [w.id]: [] }));
  };

  const handleDelete = async (id: string) => {
    await api.deleteWorkflow(id);
    if (id === activeId) {
      setActiveId(null);
      setDetail(null);
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

  const startRun = async (inputs: Record<string, unknown>) => {
    if (!detail) return;
    const run = await api.startRun(detail.id, inputs);
    setCurrentRun({
      id: run.id,
      workflow_id: detail.id,
      status: run.status,
      startedAt: Date.now(),
      events: [],
      nodeStates: {},
      finalOutputs: null,
      error: null,
      totalCost: 0,
    });
    setShowRunPanel(true);
    wsRef.current?.close();
    const ws = new WebSocket(api.runEventsUrl(run.id));
    wsRef.current = ws;
    ws.onmessage = (e) => {
      let ev: RunEvent;
      try { ev = JSON.parse(e.data) as RunEvent; } catch { return; }
      setCurrentRun((cur) => {
        if (!cur || cur.id !== run.id) return cur;
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

  const cancelRun = async () => {
    if (!currentRun) return;
    try { await api.cancelRun(currentRun.id); } catch { /* ignore */ }
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

  const canvasNodeStates: Record<string, NodeRunStatus> = currentRun?.nodeStates ?? {};

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
          setShowRunPanel(false);
          setCurrentRun(null);
        }}
        onNew={handleNew}
        onRename={handleRename}
        onDelete={handleDelete}
        onOpenSettings={() => setView('settings')}
        onOpenRun={() => {
          setShowRunPanel(true);
          setSelectedNodeId(null);
        }}
        runDisabled={!detail}
        status={topBarStatus}
      />

      <main style={{ height: 'calc(100vh - 54px)', position: 'relative' }}>
        {view === 'settings' && <SettingsPanel onClose={() => setView('workflow')} />}

        {view === 'workflow' && (
          <div style={{ display: 'flex', height: '100%' }}>
            {/* layout A — chat left, canvas right */}
            <div style={{ width: 420, borderRight: '1px solid var(--rule)', flex: 'none' }}>
              <ChatPanel
                messages={messages}
                onSend={handleSend}
                onCancel={cancelOrchestrator}
                disabled={isOrchestrating}
                sessionTitle={activeWorkflow?.name}
                modelLabel={orchestratorModel}
              />
            </div>
            <div style={{ flex: 1, position: 'relative' }}>
              {detail ? (
                <>
                  <Canvas
                    detail={detail}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={setSelectedNodeId}
                    nodeStates={canvasNodeStates}
                  />
                  {selectedNode && (
                    <NodePanel
                      node={selectedNode}
                      workflow={detail}
                      onClose={() => setSelectedNodeId(null)}
                      onChange={refreshDetail}
                    />
                  )}
                  {showRunPanel && (
                    <RunPanel
                      workflow={detail}
                      currentRun={currentRun}
                      onStart={startRun}
                      onCancel={cancelRun}
                      onClose={() => setShowRunPanel(false)}
                    />
                  )}
                </>
              ) : (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 14,
                    color: 'var(--ink-4)',
                  }}
                  className="dotgrid"
                >
                  <div className="serif" style={{ fontStyle: 'italic', fontSize: 24, color: 'var(--ink-3)' }}>
                    an empty canvas.
                  </div>
                  <div style={{ fontSize: 13, maxWidth: 360, textAlign: 'center', lineHeight: 1.6 }}>
                    describe a problem in the chat, or click{' '}
                    <span className="italic-em">new</span> to start a fresh session.
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
