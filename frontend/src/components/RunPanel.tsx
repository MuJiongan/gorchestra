import { useEffect, useState } from 'react';
import type {
  WorkflowDetail, Run, IOPort, CurrentRun,
} from '../types';
import { api } from '../api';
import { PortRow } from './ValueViewer';

interface Props {
  workflow: WorkflowDetail;
  currentRun: CurrentRun | null;
  onStart: (inputs: Record<string, unknown>) => void;
  onCancel: () => void;
  /** Optional close handler. When omitted, the panel is treated as the
   * always-on default surface and the close button is hidden. */
  onClose?: () => void;
  onSendErrorToOrchestrator: (message: string) => void;
  /** When set, the history list shows a "view on canvas" affordance per run.
   * The host (App) handles fetching the snapshot and swapping the canvas. */
  onViewRunOnCanvas?: (runId: string) => void;
  /** True while an orchestrator turn is streaming for this workflow. The
   * graph may be mid-build (added nodes, no edges yet) or about to mutate
   * again — manual runs are blocked until the turn settles. */
  orchestrating?: boolean;
}

function buildErrorPrompt({
  runId, error,
}: {
  runId: string;
  error: string;
}): string {
  const shortId = runId.slice(0, 8);
  return `Run ${shortId} failed:\n\n${error}\n\nPlease diagnose.`;
}

function SendErrorButton({
  onClick,
}: {
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="ed-btn ed-btn--mini"
      onClick={onClick}
      title="forward this error to the orchestrator"
      style={{ marginBottom: 10 }}
    >
      send to orchestrator <span className="ed-btn__mark">→</span>
    </button>
  );
}

/**
 * One-line, human-readable summary of a run for the `recent runs` list —
 * a preview of the input values, shown instead of the opaque run id.
 */
function summariseRun(run: Run): { text: string; kind: 'value' | 'id' } {
  const populated = Object.entries(run.inputs ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );

  if (populated.length === 0) {
    return { text: run.id.slice(0, 8), kind: 'id' };
  }

  const previewValue = (v: unknown): string => {
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };

  const truncate = (s: string, n: number) =>
    s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;

  const TOTAL_BUDGET = 60;

  if (populated.length === 1) {
    const [, v] = populated[0];
    return {
      text: truncate(previewValue(v).replace(/\s+/g, ' ').trim(), TOTAL_BUDGET),
      kind: 'value',
    };
  }

  const perValueBudget = Math.max(8, Math.floor(TOTAL_BUDGET / populated.length));
  const joined = populated
    .map(([, v]) => truncate(previewValue(v).replace(/\s+/g, ' ').trim(), perValueBudget))
    .join(' · ');
  return { text: truncate(joined, TOTAL_BUDGET), kind: 'value' };
}

const PANEL_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--paper)',
  display: 'flex',
  flexDirection: 'column',
  zIndex: 30,
};

export function RunPanel({
  workflow,
  currentRun,
  onStart,
  onCancel,
  onClose,
  onSendErrorToOrchestrator,
  onViewRunOnCanvas,
  orchestrating,
}: Props) {
  const inputNode = workflow.nodes.find((n) => n.id === workflow.input_node_id);
  const inputPorts: IOPort[] = inputNode?.inputs ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Run[]>([]);

  // Only consider currentRun ours if it belongs to the workflow we're showing.
  const ownRun = currentRun && currentRun.workflow_id === workflow.id ? currentRun : null;

  useEffect(() => {
    api.listRuns(workflow.id).then(setHistory).catch(() => {});
  }, [workflow.id]);

  // Refresh history when a run finishes so the latest one shows up.
  useEffect(() => {
    if (
      ownRun &&
      (ownRun.status === 'success' ||
        ownRun.status === 'error' ||
        ownRun.status === 'cancelled')
    ) {
      api.listRuns(workflow.id).then(setHistory).catch(() => {});
    }
  }, [ownRun?.status, workflow.id]);

  // While any row in `history` still reads as running/pending, poll so its
  // status flips once the backend marks it terminal. Covers the case where
  // the panel didn't observe the run start (e.g. reopened mid-flight) so
  // `ownRun` is null and the effect above never fires. Self-stops once no
  // row is in flight.
  const anyHistoryRunning = history.some(
    (h) => h.status === 'running' || h.status === 'pending',
  );
  useEffect(() => {
    if (!anyHistoryRunning) return;
    const id = setInterval(() => {
      api.listRuns(workflow.id).then(setHistory).catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, [anyHistoryRunning, workflow.id]);

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
    onStart(inputs);
  };

  const running = ownRun?.status === 'running' || ownRun?.status === 'pending';
  const status = ownRun?.status;

  return (
    <div className="fade-in" style={PANEL_STYLE}>
      <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid var(--rule)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="smallcaps">run</span>
          <span style={{ flex: 1 }} />
          {onClose && (
            <button
              className="ed-btn ed-btn--mini"
              onClick={onClose}
            >
              close <span className="ed-btn__mark">×</span>
            </button>
          )}
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

        {ownRun && (
          <RunSummaryCard
            workflow={workflow}
            runId={ownRun.id}
            status={ownRun.status}
            error={ownRun.error}
            cost={ownRun.totalCost}
            outputs={ownRun.finalOutputs}
            onSendErrorToOrchestrator={onSendErrorToOrchestrator}
          />
        )}

        {history.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <div
              className="smallcaps"
              style={{
                marginBottom: 8,
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
              }}
            >
              <span>recent runs</span>
            </div>
            {history.slice(0, 8).map((h) => {
              const summary = summariseRun(h);
              const isId = summary.kind === 'id';
              const rowRunning = h.status === 'running' || h.status === 'pending';
              return (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => onViewRunOnCanvas?.(h.id)}
                  disabled={!onViewRunOnCanvas}
                  title={
                    onViewRunOnCanvas
                      ? "view this run's graph on the canvas"
                      : isId
                        ? h.id
                        : summary.text
                  }
                  style={{
                    display: 'flex',
                    width: '100%',
                    padding: '6px 8px',
                    margin: '0 -8px',
                    alignItems: 'center',
                    gap: 8,
                    background: rowRunning ? '#fbf7ec' : 'transparent',
                    border: 0,
                    borderBottom: '1px solid var(--rule-2)',
                    borderLeft: rowRunning
                      ? '2px solid var(--state-run)'
                      : '2px solid transparent',
                    cursor: onViewRunOnCanvas ? 'pointer' : 'default',
                    textAlign: 'left',
                  }}
                >
                  <span
                    className={isId ? 'mono' : 'serif'}
                    style={{
                      fontSize: isId ? 10.5 : 12.5,
                      color: isId ? 'var(--ink-4)' : 'var(--ink-2)',
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {summary.text}
                  </span>
                  <span
                    className="smallcaps"
                    style={{
                      fontSize: 9,
                      color: rowRunning ? 'var(--state-run)' : undefined,
                      fontWeight: rowRunning ? 600 : undefined,
                    }}
                  >
                    {h.status}
                  </span>
                </button>
              );
            })}
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
            color:
              running ? 'var(--state-run)' :
              status === 'error' ? 'var(--state-err)' : 'var(--ink-4)',
            fontSize: 12,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {running && !orchestrating && (
            <span className="node-state-dot running" aria-hidden="true" />
          )}
          {orchestrating
            ? 'orchestrator working — wait for it to settle'
            : running
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
          <button className="ed-btn ed-btn--danger" onClick={onCancel}>
            cancel <span className="ed-btn__mark">×</span>
          </button>
        ) : (
          <button
            className="ed-btn ed-btn--primary"
            onClick={start}
            disabled={!inputNode || !!orchestrating}
            title={orchestrating ? 'wait until the orchestrator finishes its turn' : undefined}
          >
            {status === 'error' || status === 'cancelled'
              ? 'try again'
              : status === 'success'
                ? 'rerun'
                : 'execute'}{' '}
            <span className="ed-btn__mark">→</span>
          </button>
        )}
      </div>
    </div>
  );
}

// Renders the final output of a run as a list of click-to-expand port rows.
// The backend emits `outputs` as a port-name → value dict (one entry per
// output port on the output node); each entry becomes one row.
function FinalOutputBlock({
  workflow,
  outputs,
}: {
  workflow: WorkflowDetail;
  outputs: Record<string, unknown>;
}) {
  const outNode = workflow.nodes.find((n) => n.id === workflow.output_node_id);
  const schemaByName = new Map((outNode?.outputs ?? []).map((p) => [p.name, p]));
  const keys = Object.keys(outputs);
  return (
    <div style={{ marginBottom: 4 }}>
      <div className="smallcaps" style={{ marginBottom: 6, color: 'var(--state-ok)' }}>
        final output
      </div>
      {keys.length === 0 ? (
        <span
          className="serif"
          style={{ fontStyle: 'italic', fontSize: 11.5, color: 'var(--ink-4)' }}
        >
          none
        </span>
      ) : (
        keys.map((k) => (
          <PortRow
            key={k}
            name={k}
            typeHint={schemaByName.get(k)?.type_hint}
            value={outputs[k]}
            viewerTitle={`final · ${k}`}
          />
        ))
      )}
    </div>
  );
}

// Top-level run summary — status, error, final outputs, cost. Per-node trace
// detail lives on the canvas: click a node to drill in via the node panel's
// `trace` tab. Keeps this surface clean for the run's headline result.
function RunSummaryCard({
  workflow, runId, status, error, cost, outputs, onSendErrorToOrchestrator,
}: {
  workflow: WorkflowDetail;
  runId: string;
  status: string;
  error: string | null;
  cost: number;
  outputs: Record<string, unknown> | null;
  onSendErrorToOrchestrator: (message: string) => void;
}) {
  const hasFinal = status === 'success' && outputs && Object.keys(outputs).length > 0;
  const isRunning = status === 'running' || status === 'pending';
  return (
    <div
      style={{
        marginTop: 14,
        padding: 16,
        background: isRunning ? '#fbf7ec' : 'var(--paper-2)',
        border: '1px solid var(--rule)',
        borderLeft: isRunning
          ? '3px solid var(--state-run)'
          : '1px solid var(--rule)',
        borderRadius: 3,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {isRunning && (
          <span
            className="node-state-dot running"
            style={{ alignSelf: 'center' }}
            aria-hidden="true"
          />
        )}
        {status === 'success' && (
          <span
            className="node-state-dot success"
            style={{ alignSelf: 'center' }}
            aria-hidden="true"
          />
        )}
        <span
          className="smallcaps"
          style={{
            color:
              isRunning ? 'var(--state-run)' :
              status === 'success' ? 'var(--state-ok)' :
              status === 'error' ? 'var(--state-err)' :
              status === 'cancelled' ? 'var(--ink-3)' : 'var(--ink-3)',
            fontSize:
              isRunning || status === 'success' || status === 'error' ? 14 : undefined,
            fontWeight: isRunning ? 600 : undefined,
            letterSpacing: isRunning ? '0.12em' : undefined,
          }}
        >
          {isRunning ? 'running…' :
           status === 'success' ? 'success' :
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
        <>
          <pre
            className="mono"
            style={{ fontSize: 11, color: 'var(--state-err)', whiteSpace: 'pre-wrap', margin: '0 0 8px' }}
          >
            {error}
          </pre>
          <SendErrorButton
            onClick={() => onSendErrorToOrchestrator(buildErrorPrompt({ runId, error }))}
          />
        </>
      )}
      {hasFinal && outputs && <FinalOutputBlock workflow={workflow} outputs={outputs} />}
      {!hasFinal && !error && (
        <div
          className="serif"
          style={{ fontStyle: 'italic', fontSize: 12.5, color: 'var(--ink-4)' }}
        >
          {isRunning
            ? 'click a node on the canvas to inspect its trace.'
            : 'no outputs.'}
        </div>
      )}
      <div className="serif" style={{ fontStyle: 'italic', fontSize: 12, color: 'var(--ink-4)', marginTop: 10 }}>
        cost — ${cost.toFixed(4)}
      </div>
    </div>
  );
}
