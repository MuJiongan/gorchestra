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
  const [chatOpen, setChatOpen] = useState(true);

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
                  position: 'relative',
                  borderRight: '1px solid var(--rule)',
                  minWidth: 0,
                }}
              >
                {detail ? (
                  <Canvas
                    detail={detail}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={(id) => {
                      setSelectedNodeId(id);
                      if (id) setShowRunPanel(false);
                    }}
                    nodeStates={canvasNodeStates}
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

              {/* right 3/5 — node configuration / inputs / outputs */}
              <div style={{ flex: 3, position: 'relative', minWidth: 0 }}>
                {detail && selectedNode && (
                  <NodePanel
                    node={selectedNode}
                    workflow={detail}
                    onClose={() => setSelectedNodeId(null)}
                    onChange={refreshDetail}
                  />
                )}
                {detail && showRunPanel && (
                  <RunPanel
                    workflow={detail}
                    currentRun={currentRun}
                    onStart={startRun}
                    onCancel={cancelRun}
                    onClose={() => setShowRunPanel(false)}
                  />
                )}
                {detail && !selectedNode && !showRunPanel && (
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
                      nothing selected.
                    </div>
                    <div style={{ fontSize: 13, maxWidth: 420, textAlign: 'center', lineHeight: 1.6 }}>
                      click a node in the canvas to see its specification, or press{' '}
                      <span className="italic-em">run</span> to provide inputs and view outputs.
                    </div>
                  </div>
                )}
                {!detail && (
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

            {/* floating chatbot — launcher when closed, panel when open.
                Hidden while the run panel is open since both pin to bottom-right. */}
            {!chatOpen && !showRunPanel && (
              <button
                onClick={() => setChatOpen(true)}
                style={{
                  position: 'fixed',
                  bottom: 24,
                  right: 24,
                  padding: '10px 18px',
                  background: 'var(--paper)',
                  border: '1px solid var(--rule)',
                  borderRadius: 999,
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  letterSpacing: '0.06em',
                  textTransform: 'lowercase',
                  cursor: 'pointer',
                  zIndex: 50,
                  boxShadow: '0 8px 28px -10px rgba(26, 23, 20, 0.25), 0 2px 6px -2px rgba(26, 23, 20, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  color: 'var(--ink)',
                }}
                title="open chat with the orchestrator"
              >
                <span className="smallcaps">chat</span>
                {isOrchestrating && (
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 999,
                      background: 'var(--accent, #c08552)',
                      animation: 'pulse 1.4s ease-in-out infinite',
                    }}
                    aria-label="orchestrator is working"
                  />
                )}
              </button>
            )}
            {chatOpen && !showRunPanel && (
              <div
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
