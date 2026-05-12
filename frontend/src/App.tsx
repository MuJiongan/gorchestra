import { useEffect, useRef, useState } from 'react';
import { TopBar } from './components/TopBar';
import { Canvas } from './components/Canvas';
import { ChatPanel, type ChatMessage } from './components/ChatPanel';
import { NodePanel } from './components/NodePanel';
import { RunPanel } from './components/RunPanel';
import { SettingsPanel } from './components/Settings';
import { Hero } from './components/Hero';
import { SnapshotBanner } from './components/SnapshotBanner';
import { SnapshotRunPanel } from './components/SnapshotRunPanel';
import { api } from './api';
import { loadSettings, SETTINGS_CHANGED_EVENT } from './localSettings';
import {
  DEFAULT_WORKFLOW_NAME,
  deriveWorkflowName,
  historyToChatMessages,
  snapshotToDetail,
} from './appHelpers';
import { useOrchestratorStream } from './orchestratorStream';
import { useRunWebSocket } from './runWebSocket';
import type {
  Workflow, WorkflowDetail, NodeRunStatus, Run,
} from './types';

type View = 'workflow' | 'settings';

export default function App() {
  const [view, setView] = useState<View>('workflow');
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // The right column toggles between two surfaces — the project's workspace
  // (run details / node config / snapshot view) and the orchestrator chat.
  // The chat used to float as an overlay; tabbing replaces it cleanly so the
  // run/execute footer is never blocked.
  const [rightPanelMode, setRightPanelMode] = useState<'workspace' | 'chat'>('workspace');

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

  // When non-null, the canvas renders this run's frozen `workflow_snapshot`
  // instead of the live graph. NodePanel still works (read-only) so the user
  // can drill into a snapshot node's code and that node's run trace; the
  // live RunPanel is hidden.
  const [viewingRun, setViewingRun] = useState<Run | null>(null);
  // Selection is tracked separately for snapshot view so it doesn't leak
  // into the live canvas's selection state when the user toggles back.
  const [selectedSnapshotNodeId, setSelectedSnapshotNodeId] = useState<string | null>(null);

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

  const { currentRun, setCurrentRun, attachToRun, closeWs } = useRunWebSocket(workflows);

  const attachToRunRef = useRef(attachToRun);
  useEffect(() => { attachToRunRef.current = attachToRun; });

  const { streamToOrchestrator, abortStream, dropWorkflow } = useOrchestratorStream({
    setChatByWorkflow,
    setOrchestratingIds,
    refreshDetail,
    attachToRunRef,
  });

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

  // viewingRun is captured at the moment snapshot view opens, so for an
  // in-flight run its outputs/node_runs/total_cost are empty. currentRun
  // streams the live deltas, but the SnapshotRunPanel reads its display
  // fields off viewingRun. When the bound run finishes, refetch it once so
  // the panel picks up the final outputs, completed node_runs, and total
  // cost in a single update.
  useEffect(() => {
    if (!viewingRun || !currentRun || currentRun.id !== viewingRun.id) return;
    const terminal =
      currentRun.status === 'success' ||
      currentRun.status === 'error' ||
      currentRun.status === 'cancelled';
    if (!terminal) return;
    let cancelled = false;
    api.getRun(viewingRun.id)
      .then((fresh) => {
        if (cancelled) return;
        setViewingRun((cur) => (cur && cur.id === fresh.id ? fresh : cur));
      })
      .catch(() => { /* leave viewingRun stale; user can exit and re-enter */ });
    return () => { cancelled = true; };
  }, [viewingRun?.id, currentRun?.id, currentRun?.status]);

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
    return () => closeWs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const activeWorkflow = workflows.find((w) => w.id === activeId) ?? null;
  const messages = activeId ? chatByWorkflow[activeId] ?? [] : [];

  /**
   * Send a user message. Lazily creates a workflow + chat context if one
   * doesn't exist yet, so the user can land on the workspace and just start
   * typing. The first message also becomes the workflow's name when it's still
   * the placeholder.
   */
  const handleSend = async (text: string) => {
    let wid = activeId;
    let isFirstMessage = false;

    if (!wid) {
      // No active workflow — create one named after this message.
      const w = await api.createWorkflow(deriveWorkflowName(text));
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
    if (
      !isFirstMessage &&
      cur &&
      (cur.name === DEFAULT_WORKFLOW_NAME || cur.name === 'untitled session')
    ) {
      const nextName = deriveWorkflowName(text);
      api.patchWorkflow(wid, { name: nextName }).then(() => refreshWorkflows()).catch(() => {});
    }

    streamToOrchestrator(wid, sid, text);
  };

  const cancelOrchestrator = async () => {
    if (!activeId) return;
    const sid = sessionByWorkflow[activeId];
    if (!sid) return;
    try { await api.cancelOrchestratorTurn(sid); } catch { /* ignore */ }
    abortStream(activeId);
  };

  /**
   * "new workflow" drops into the Hero empty state without touching the
   * backend. handleSend's `!wid` branch lazily creates the workflow and chat
   * context when the user sends their first message, so we avoid leaving
   * orphaned placeholder rows behind every time someone clicks +.
   */
  const handleNew = () => {
    setActiveId(null);
    setDetail(null);
    setView('workflow');
    setSelectedNodeId(null);
    setCurrentRun(null);
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
    dropWorkflow(id);
    await refreshWorkflows();
  };

  const handleRename = async (id: string, name: string) => {
    await api.patchWorkflow(id, { name });
    await refreshWorkflows();
    if (id === activeId) await refreshDetail();
  };

  const activateFork = async (workflow: Workflow) => {
    setWorkflows((prev) => [workflow, ...prev.filter((w) => w.id !== workflow.id)]);
    activeIdRef.current = workflow.id;
    setActiveId(workflow.id);
    setView('workflow');
    setSelectedNodeId(null);
    setSelectedSnapshotNodeId(null);
    setViewingRun(null);
    setCurrentRun(null);
    setChatByWorkflow((prev) => ({ ...prev, [workflow.id]: [] }));
    try {
      const d = await api.getWorkflow(workflow.id);
      if (activeIdRef.current === workflow.id) setDetail(d);
    } catch {
      if (activeIdRef.current === workflow.id) setDetail(null);
    }
  };

  const handleForkWorkflow = async (id: string) => {
    if (orchestratingIds.has(id)) {
      alert('wait for the orchestrator to finish before forking this project.');
      return;
    }
    try {
      const fork = await api.forkWorkflow(id);
      await activateFork(fork);
    } catch (e) {
      alert(`couldn't fork project: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleForkSnapshot = async () => {
    if (!viewingRun?.workflow_snapshot) return;
    try {
      const fork = await api.forkRunSnapshot(viewingRun.id);
      await activateFork(fork);
    } catch (e) {
      alert(`couldn't fork snapshot: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const startRun = async (inputs: Record<string, unknown>) => {
    if (!detail) return;
    const run = await api.startRun(detail.id, inputs);
    attachToRun(run.id, detail.id, run.status);
    // Drop the user on the run's detail page so they can watch this specific
    // run's progress and see its inputs/outputs as they land. The run carries
    // its own workflow_snapshot from the start_run response, so we can enter
    // snapshot view immediately without a follow-up fetch.
    if (run.workflow_snapshot) {
      setSelectedNodeId(null);
      setSelectedSnapshotNodeId(null);
      setViewingRun(run);
    }
  };

  const cancelRun = async () => {
    if (!currentRun) return;
    try { await api.cancelRun(currentRun.id); } catch { /* ignore */ }
  };

  /** Forward an error from a run/node into the orchestrator chat as a user message. */
  const sendErrorToOrchestrator = (message: string) => {
    setRightPanelMode('chat');
    handleSend(message);
  };

  const selectedNode = detail?.nodes.find((n) => n.id === selectedNodeId);
  const isOrchestrating = !!activeId && orchestratingIds.has(activeId);

  const clearChatContext = async () => {
    if (!activeId || isOrchestrating) return;
    const sid = sessionByWorkflow[activeId];
    if (!sid) {
      setChatByWorkflow((prev) => ({ ...prev, [activeId]: [] }));
      return;
    }
    if (!confirm('clear this chat context? the project graph and run history will stay.')) return;
    try {
      await api.clearSessionMessages(sid);
      setChatByWorkflow((prev) => ({ ...prev, [activeId]: [] }));
    } catch (e) {
      alert(`couldn't clear context: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

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
    ? {
        ...Object.fromEntries(
          viewingRun.node_runs.map((nr) => [nr.node_id, nr.status]),
        ),
        ...(currentRun && currentRun.id === viewingRun.id
          ? currentRun.nodeStates
          : {}),
      }
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
        onFork={handleForkWorkflow}
        onRename={handleRename}
        onDelete={handleDelete}
        onOpenSettings={() => setView('settings')}
        onOpenRun={() => {
          // RunPanel is the default right-side surface — "Runs" in the
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
                setRightPanelMode('chat');
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
                  <SnapshotBanner run={viewingRun} />
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
                        onSelectNode={(id) => {
                          setSelectedSnapshotNodeId(id);
                          // Clicking a canvas node from the chat tab should
                          // surface the node detail; the chat hides the
                          // workspace where NodePanel lives. Pane deselects
                          // (id === null) shouldn't yank the user out of chat.
                          if (id !== null) setRightPanelMode('workspace');
                        }}
                        nodeStates={snapshotNodeStates}
                      />
                    ) : null;
                  })()
                ) : detail ? (
                  <Canvas
                    detail={detail}
                    selectedNodeId={selectedNodeId}
                    onSelectNode={(id) => {
                      setSelectedNodeId(id);
                      if (id !== null) setRightPanelMode('workspace');
                    }}
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
                      <span className="italic-em">new project</span> to start fresh.
                    </div>
                  </div>
                )}
                </div>
                {viewingRun && (
                  <div
                    style={{
                      borderTop: '1px solid var(--rule)',
                      background: 'var(--paper-2)',
                      padding: '10px 12px',
                      display: 'flex',
                      justifyContent: 'flex-end',
                      gap: 8,
                      flexShrink: 0,
                    }}
                  >
                    <button
                      type="button"
                      onClick={handleForkSnapshot}
                      className="snapshot-action-btn snapshot-action-btn--secondary"
                      title="copy this frozen run graph into a new editable project"
                    >
                      create project from snapshot
                    </button>
                    <button
                      type="button"
                      onClick={exitSnapshotView}
                      className="snapshot-action-btn"
                      title="return to the live, editable canvas"
                    >
                      back to live canvas
                    </button>
                  </div>
                )}
              </div>

              {/* right 3/5 — workspace (run/node) or orchestrator chat,
                  toggled via the tabs at the top. */}
              <div
                style={{
                  flex: 3,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <RightPanelTabs
                  mode={rightPanelMode}
                  setMode={setRightPanelMode}
                  showChatActivityDot={isOrchestrating && rightPanelMode !== 'chat'}
                />
                <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
                  {rightPanelMode === 'chat' ? (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        flexDirection: 'column',
                      }}
                    >
                      <ChatPanel
                        messages={messages}
                        onSend={handleSend}
                        onCancel={cancelOrchestrator}
                        disabled={isOrchestrating}
                        workflowTitle={activeWorkflow?.name}
                        modelLabel={orchestratorModel}
                        onClearContext={clearChatContext}
                        onViewRun={(runId) => {
                          // Snapshot view renders inside the workspace tab —
                          // flip back from chat so the run panel is actually
                          // visible after the click.
                          setRightPanelMode('workspace');
                          void enterSnapshotView(runId);
                        }}
                      />
                    </div>
                  ) : (
                    <>
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
                            no project yet.
                          </div>
                          <div style={{ fontSize: 13, maxWidth: 420, textAlign: 'center', lineHeight: 1.6 }}>
                            open the{' '}
                            <button
                              type="button"
                              onClick={() => setRightPanelMode('chat')}
                              className="italic-em"
                              style={{
                                background: 'none',
                                border: 0,
                                padding: 0,
                                color: 'var(--accent-ink)',
                                cursor: 'pointer',
                                font: 'inherit',
                                fontStyle: 'italic',
                              }}
                            >
                              chat
                            </button>{' '}
                            tab and describe a problem, or click{' '}
                            <span className="italic-em">new project</span> to start fresh.
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function RightPanelTabs({
  mode,
  setMode,
  showChatActivityDot,
}: {
  mode: 'workspace' | 'chat';
  setMode: (m: 'workspace' | 'chat') => void;
  /** When true, paint a small accent dot on the chat tab to signal that
   * the orchestrator is doing work the user can't currently see. */
  showChatActivityDot: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 0,
        padding: '0 12px',
        borderBottom: '1px solid var(--rule)',
        background: 'var(--paper-2)',
        flexShrink: 0,
      }}
    >
      <PanelTabButton
        active={mode === 'workspace'}
        onClick={() => setMode('workspace')}
      >
        workspace
      </PanelTabButton>
      <PanelTabButton
        active={mode === 'chat'}
        onClick={() => setMode('chat')}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          chat
          {showChatActivityDot && (
            <span
              aria-label="orchestrator is working"
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: 'var(--accent)',
                animation: 'pulse 1.4s ease-in-out infinite',
              }}
            />
          )}
        </span>
      </PanelTabButton>
    </div>
  );
}

function PanelTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="smallcaps"
      aria-pressed={active}
      style={{
        background: 'transparent',
        border: 0,
        padding: '10px 14px',
        cursor: 'pointer',
        color: active ? 'var(--ink)' : 'var(--ink-4)',
        fontSize: 10.5,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        borderBottom: active
          ? '1.5px solid var(--accent)'
          : '1.5px solid transparent',
        marginBottom: -1,
        transition: 'color .15s, border-color .15s',
      }}
    >
      {children}
    </button>
  );
}
