import { useEffect, useMemo, useState } from 'react';
import type {
  WorkflowDetail, Run, IOPort, NodeRunStatus, CurrentRun, RunEvent,
} from '../types';
import { api } from '../api';
import { JsonView } from './JsonView';

interface Props {
  workflow: WorkflowDetail;
  currentRun: CurrentRun | null;
  onStart: (inputs: Record<string, unknown>) => void;
  onCancel: () => void;
  onClose: () => void;
}

const STATE_CLASS: Record<NodeRunStatus, string> = {
  pending: 'idle',
  running: 'running',
  success: 'success',
  error: 'error',
  skipped: 'skipped',
};

const PANEL_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 16,
  right: 16,
  bottom: 16,
  width: 460,
  background: 'var(--paper)',
  border: '1px solid var(--rule)',
  borderRadius: 4,
  display: 'flex',
  flexDirection: 'column',
  zIndex: 30,
  boxShadow: '0 1px 0 rgba(26, 23, 20, 0.04), 0 24px 60px -28px rgba(26, 23, 20, 0.25)',
};

const FULLSCREEN_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: 24,
  left: 24,
  right: 24,
  bottom: 24,
  width: 'auto',
  background: 'var(--paper)',
  border: '1px solid var(--rule)',
  borderRadius: 4,
  display: 'flex',
  flexDirection: 'column',
  zIndex: 60,
  boxShadow: '0 1px 0 rgba(26, 23, 20, 0.04), 0 40px 100px -40px rgba(26, 23, 20, 0.45)',
};

const FULLSCREEN_BACKDROP: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(26, 23, 20, 0.18)',
  zIndex: 55,
  backdropFilter: 'blur(2px)',
};

interface NodeTrace {
  node_id: string;
  status: NodeRunStatus;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  logs: string[];
  llm_calls: Array<{ model: string; content: string; cost: number }>;
  tool_calls: Array<{ tool: string; args: Record<string, unknown>; result?: unknown; error?: string; via: string }>;
  error?: string | null;
  duration_ms?: number;
  cost?: number;
}

function aggregateEvents(events: RunEvent[]): NodeTrace[] {
  const byId = new Map<string, NodeTrace>();
  const order: string[] = [];
  const ensure = (id: string): NodeTrace => {
    let t = byId.get(id);
    if (!t) {
      t = { node_id: id, status: 'pending', logs: [], llm_calls: [], tool_calls: [] };
      byId.set(id, t);
      order.push(id);
    }
    return t;
  };
  for (const ev of events) {
    if (ev.type === 'node_started') {
      const t = ensure(ev.node_id);
      t.status = 'running';
      t.inputs = ev.inputs;
    } else if (ev.type === 'log') {
      ensure(ev.node_id).logs.push(ev.msg);
    } else if (ev.type === 'llm_call_finished') {
      ensure(ev.node_id).llm_calls.push({
        model: ev.model,
        content: ev.content,
        cost: ev.cost,
      });
    } else if (ev.type === 'tool_call_finished') {
      ensure(ev.node_id).tool_calls.push({
        tool: ev.tool,
        args: ev.args,
        result: ev.result,
        error: ev.error,
        via: ev.via,
      });
    } else if (ev.type === 'node_finished') {
      const t = ensure(ev.node_id);
      t.status = ev.status;
      t.inputs = ev.inputs;
      t.outputs = ev.outputs;
      t.error = ev.error;
      t.duration_ms = ev.duration_ms;
      t.cost = ev.cost;
      // Trust the finished event's full lists over what we accumulated.
      if (ev.logs && ev.logs.length) t.logs = ev.logs as string[];
      if (ev.llm_calls && (ev.llm_calls as any[]).length) {
        t.llm_calls = (ev.llm_calls as any[]).map((c) => ({
          model: c.model,
          content: c.content,
          cost: c.cost,
        }));
      }
      if (ev.tool_calls && (ev.tool_calls as any[]).length) {
        t.tool_calls = (ev.tool_calls as any[]).map((c) => ({
          tool: c.name,
          args: c.args,
          result: c.result,
          error: c.error,
          via: c.via,
        }));
      }
    }
  }
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

export function RunPanel({ workflow, currentRun, onStart, onCancel, onClose }: Props) {
  const inputNode = workflow.nodes.find((n) => n.id === workflow.input_node_id);
  const inputPorts: IOPort[] = inputNode?.inputs ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Run[]>([]);
  const [historicalRun, setHistoricalRun] = useState<Run | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    api.listRuns(workflow.id).then(setHistory).catch(() => {});
  }, [workflow.id]);

  // Esc collapses fullscreen first; if already side-panel, the parent's own
  // close logic isn't triggered (would be too greedy — let the user click ✕).
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  // Refresh history when a run finishes so the latest one shows up.
  useEffect(() => {
    if (
      currentRun &&
      (currentRun.status === 'success' ||
        currentRun.status === 'error' ||
        currentRun.status === 'cancelled')
    ) {
      api.listRuns(workflow.id).then(setHistory).catch(() => {});
    }
  }, [currentRun?.status, workflow.id]);

  const traces = useMemo(
    () => (currentRun ? aggregateEvents(currentRun.events) : []),
    [currentRun?.events],
  );

  const start = () => {
    if (!workflow.input_node_id) {
      alert('set an input node first (click a node, then "set as input").');
      return;
    }
    if (!workflow.output_node_id) {
      if (!confirm('no output node set. continue anyway?')) return;
    }
    const inputs: Record<string, unknown> = {};
    for (const p of inputPorts) {
      const raw = values[p.name];
      if (raw === undefined || raw === '') {
        inputs[p.name] = null;
        continue;
      }
      try { inputs[p.name] = JSON.parse(raw); } catch { inputs[p.name] = raw; }
    }
    setHistoricalRun(null);
    onStart(inputs);
  };

  const running = currentRun?.status === 'running' || currentRun?.status === 'pending';
  const status = currentRun?.status;

  return (
    <>
      {isFullscreen && (
        <div style={FULLSCREEN_BACKDROP} onClick={() => setIsFullscreen(false)} />
      )}
      <div className="fade-in" style={isFullscreen ? FULLSCREEN_STYLE : PANEL_STYLE}>
      <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid var(--rule)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="smallcaps">run</span>
          <span style={{ flex: 1 }} />
          <button
            className="btn-ghost"
            onClick={() => setIsFullscreen((v) => !v)}
            style={{ padding: '3px 9px', fontSize: 11 }}
            title={isFullscreen ? 'collapse to side panel (esc)' : 'expand to fullscreen'}
          >
            {isFullscreen ? 'collapse' : 'expand'} <span className="italic-em">⤢</span>
          </button>
          <button
            className="btn-ghost"
            onClick={onClose}
            style={{ padding: '3px 9px', fontSize: 11 }}
          >
            close ✕
          </button>
        </div>
        <div
          className="serif"
          style={{ fontStyle: 'italic', fontSize: 22, marginTop: 6, color: 'var(--ink)' }}
        >
          your inputs.
        </div>
        {inputNode && (
          <div className="serif" style={{ fontStyle: 'italic', fontSize: 12.5, color: 'var(--ink-3)', marginTop: 2 }}>
            entry — <span className="mono" style={{ fontStyle: 'normal' }}>{inputNode.name}</span>
          </div>
        )}
      </div>

      <div className="scroll" style={{ flex: 1, overflow: 'auto', padding: 22 }}>
        {!inputNode && (
          <div className="serif" style={{ fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 13 }}>
            no input node selected. open a node and mark it as input from the config tab.
          </div>
        )}
        {inputNode && inputPorts.length === 0 && (
          <div className="serif" style={{ fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 13 }}>
            this node takes no declared inputs.
          </div>
        )}
        {inputPorts.map((p) => (
          <div key={p.name} style={{ marginBottom: 22 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
              <span className="mono" style={{ fontSize: 12 }}>{p.name}</span>
              <span
                className="serif"
                style={{ fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 11.5 }}
              >
                {p.type_hint}
              </span>
              <span style={{ flex: 1 }} />
              {!p.required && (
                <span className="smallcaps" style={{ fontSize: 9 }}>
                  optional
                </span>
              )}
            </div>
            <textarea
              rows={1}
              className="field"
              style={{
                resize: 'vertical',
                fontFamily: 'var(--mono)',
                fontStyle: 'normal',
                fontSize: 12.5,
              }}
              value={values[p.name] ?? ''}
              onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}
              placeholder={p.type_hint === 'path' ? '/users/you/recordings' : 'plain text or json'}
            />
          </div>
        ))}

        {currentRun && (
          <RunTraceCard
            workflow={workflow}
            runId={currentRun.id}
            status={currentRun.status}
            error={currentRun.error}
            cost={currentRun.totalCost}
            outputs={currentRun.finalOutputs}
            traces={traces}
          />
        )}

        {historicalRun && !currentRun && (
          <HistoricalRunCard workflow={workflow} run={historicalRun} />
        )}

        {history.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <div className="smallcaps" style={{ marginBottom: 8 }}>recent runs</div>
            {history.slice(0, 8).map((h) => (
              <button
                key={h.id}
                onClick={async () => setHistoricalRun(await api.getRun(h.id))}
                style={{
                  display: 'flex',
                  width: '100%',
                  padding: '6px 0',
                  alignItems: 'baseline',
                  gap: 8,
                  background: 'transparent',
                  border: 0,
                  borderBottom: '1px solid var(--rule-2)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-4)' }}>{h.id.slice(0, 8)}</span>
                <span style={{ flex: 1 }} />
                <span className="smallcaps" style={{ fontSize: 9 }}>{h.status}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        style={{
          padding: '14px 18px',
          borderTop: '1px solid var(--rule)',
          background: 'var(--paper-2)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span
          className="serif"
          style={{
            fontStyle: 'italic',
            color: status === 'error' ? 'var(--state-err)' : 'var(--ink-4)',
            fontSize: 12,
          }}
        >
          {running
            ? 'running…'
            : status === 'success'
              ? 'ready — tweak inputs and rerun'
              : status === 'error'
                ? 'failed — adjust and try again'
                : status === 'cancelled'
                  ? 'cancelled — adjust and rerun'
                  : 'standing by'}
        </span>
        {running ? (
          <button className="btn-ghost" onClick={onCancel} style={{ borderColor: 'var(--state-err)', color: 'var(--state-err)' }}>
            cancel ✕
          </button>
        ) : (
          <button className="btn-ink" onClick={start} disabled={!inputNode}>
            {status === 'error' || status === 'cancelled'
              ? 'try again'
              : status === 'success'
                ? 'rerun'
                : 'execute'}{' '}
            <span className="italic-em">→</span>
          </button>
        )}
      </div>
      </div>
    </>
  );
}

function RunTraceCard({
  workflow, runId, status, error, cost, outputs, traces,
}: {
  workflow: WorkflowDetail;
  runId: string;
  status: string;
  error: string | null;
  cost: number;
  outputs: Record<string, unknown> | null;
  traces: NodeTrace[];
}) {
  return (
    <div
      style={{
        marginTop: 14,
        padding: 16,
        background: 'var(--paper-2)',
        border: '1px solid var(--rule)',
        borderRadius: 3,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span
          className="smallcaps"
          style={{
            color:
              status === 'success' ? 'var(--state-ok)' :
              status === 'error' ? 'var(--state-err)' :
              status === 'cancelled' ? 'var(--ink-3)' : 'var(--ink-3)',
          }}
        >
          {status === 'success' ? '✓ result' :
           status === 'error' ? '× error' :
           status === 'cancelled' ? '— cancelled' :
           `· ${status}`}
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-4)' }}>
          {runId.slice(0, 8)}
        </span>
      </div>
      {error && (
        <pre
          className="mono"
          style={{ fontSize: 11, color: 'var(--state-err)', whiteSpace: 'pre-wrap', margin: '0 0 10px' }}
        >
          {error}
        </pre>
      )}
      {traces.map((t) => {
        const nodeName = workflow.nodes.find((n) => n.id === t.node_id)?.name ?? t.node_id;
        return (
          <details key={t.node_id} style={{ marginBottom: 6 }} open={t.status === 'running' || t.status === 'error'}>
            <summary
              style={{
                cursor: 'pointer',
                padding: '6px 0',
                borderBottom: '1px solid var(--rule-2)',
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
              }}
            >
              <span className={`node-state-dot ${STATE_CLASS[t.status]}`} />
              <span className="mono" style={{ fontSize: 11.5 }}>{nodeName}</span>
              <span style={{ flex: 1 }} />
              <span className="smallcaps" style={{ fontSize: 9 }}>
                {t.status}
                {typeof t.duration_ms === 'number' ? ` · ${t.duration_ms}ms` : ''}
              </span>
            </summary>
            <div style={{ padding: '8px 0' }}>
              {t.error && (
                <pre
                  className="mono"
                  style={{ fontSize: 11, color: 'var(--state-err)', whiteSpace: 'pre-wrap', margin: '0 0 8px' }}
                >
                  {t.error}
                </pre>
              )}
              {t.inputs !== undefined && <Section label="inputs" json={t.inputs} />}
              {t.outputs !== undefined && <Section label="outputs" json={t.outputs} />}
              {t.logs.length > 0 && <Section label="logs" json={t.logs} />}
              {t.llm_calls.length > 0 && (
                <Section label={`llm calls (${t.llm_calls.length})`} json={t.llm_calls} />
              )}
              {t.tool_calls.length > 0 && (
                <Section label={`tool calls (${t.tool_calls.length})`} json={t.tool_calls} />
              )}
            </div>
          </details>
        );
      })}
      {status === 'success' && outputs && (
        <div style={{ marginTop: 12 }}>
          <div className="smallcaps" style={{ marginBottom: 4 }}>final output</div>
          <JsonView value={outputs} />
        </div>
      )}
      <div className="serif" style={{ fontStyle: 'italic', fontSize: 12, color: 'var(--ink-4)', marginTop: 10 }}>
        cost — ${cost.toFixed(4)}
      </div>
    </div>
  );
}

function HistoricalRunCard({ workflow, run }: { workflow: WorkflowDetail; run: Run }) {
  return (
    <div
      style={{
        marginTop: 14,
        padding: 16,
        background: 'var(--paper-2)',
        border: '1px solid var(--rule)',
        borderRadius: 3,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span
          className="smallcaps"
          style={{
            color:
              run.status === 'success' ? 'var(--state-ok)' :
              run.status === 'error' ? 'var(--state-err)' : 'var(--ink-3)',
          }}
        >
          {run.status === 'success' ? '✓ replay' :
           run.status === 'error' ? '× replay' :
           `· ${run.status}`}
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-4)' }}>
          {run.id.slice(0, 8)}
        </span>
      </div>
      {run.error && (
        <pre
          className="mono"
          style={{ fontSize: 11, color: 'var(--state-err)', whiteSpace: 'pre-wrap', margin: '0 0 10px' }}
        >
          {run.error}
        </pre>
      )}
      {run.node_runs.map((nr) => {
        const nodeName = workflow.nodes.find((n) => n.id === nr.node_id)?.name ?? nr.node_id;
        return (
          <details key={nr.id} style={{ marginBottom: 6 }}>
            <summary
              style={{
                cursor: 'pointer',
                padding: '6px 0',
                borderBottom: '1px solid var(--rule-2)',
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
              }}
            >
              <span className={`node-state-dot ${STATE_CLASS[nr.status]}`} />
              <span className="mono" style={{ fontSize: 11.5 }}>{nodeName}</span>
              <span style={{ flex: 1 }} />
              <span className="smallcaps" style={{ fontSize: 9 }}>
                {nr.status} · {nr.duration_ms}ms
              </span>
            </summary>
            <div style={{ padding: '8px 0' }}>
              {nr.error && (
                <pre
                  className="mono"
                  style={{ fontSize: 11, color: 'var(--state-err)', whiteSpace: 'pre-wrap', margin: '0 0 8px' }}
                >
                  {nr.error}
                </pre>
              )}
              <Section label="inputs" json={nr.inputs} />
              <Section label="outputs" json={nr.outputs} />
              {nr.logs.length > 0 && <Section label="logs" json={nr.logs} />}
            </div>
          </details>
        );
      })}
      <div className="serif" style={{ fontStyle: 'italic', fontSize: 12, color: 'var(--ink-4)', marginTop: 10 }}>
        cost — ${run.total_cost.toFixed(4)}
      </div>
    </div>
  );
}

function Section({ label, json }: { label: string; json: unknown }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="smallcaps" style={{ marginBottom: 3 }}>{label}</div>
      <JsonView value={json} />
    </div>
  );
}
