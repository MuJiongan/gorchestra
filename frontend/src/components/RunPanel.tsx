import { useEffect, useMemo, useState } from 'react';
import type {
  WorkflowDetail, Run, IOPort, NodeRunStatus, CurrentRun, RunEvent,
} from '../types';
import { api } from '../api';
import { JsonView } from './JsonView';
import { PortRow, ValueRow, ViewerOverlay } from './ValueViewer';
import { NodeIOBlock } from './NodeIOBlock';

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
  runId, nodeName, error,
}: {
  runId: string;
  nodeName?: string;
  error: string;
}): string {
  const shortId = runId.slice(0, 8);
  if (nodeName) {
    return `Node "${nodeName}" failed during run ${shortId}:\n\n${error}\n\nPlease diagnose and fix.`;
  }
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

const STATE_CLASS: Record<NodeRunStatus, string> = {
  pending: 'idle',
  running: 'running',
  success: 'success',
  error: 'error',
  skipped: 'skipped',
};

/**
 * One-line, human-readable summary of a run for the `recent runs` list —
 * a preview of the input values, shown instead of the opaque run id. Falls
 * back to the run id (short hex prefix) when there's nothing useful in the
 * inputs to show.
 *
 * Returns { text, kind } so the caller can style the fallback ("id") in
 * mono font, distinct from the populated-input previews.
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

  // Multi-input: join short value previews so the user can recognise the run
  // by what they actually typed, not by the port names (which repeat across runs).
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

// --- per-LLM-call streaming state ----------------------------------------
//
// A node may invoke ctx.call_llm multiple times concurrently (threading inside
// the node body). Each invocation gets a unique `call_id` from the backend; we
// track them in insertion order and render one card per call so streams don't
// fight over the same DOM space.

type LiveCallStatus = 'streaming' | 'done' | 'error';
type ToolCallStatus = 'streaming' | 'pending' | 'ok' | 'err';

interface NestedToolCall {
  tc_index: number;
  round: number;
  tool: string;
  args_str: string;            // accumulating raw arg-string while streaming
  args?: Record<string, unknown>;  // parsed once the call actually fires
  status: ToolCallStatus;
  result?: unknown;
  error?: string;
}

// One agent-loop turn within a single ctx.call_llm invocation.
//
// The LLM produces reasoning + content, optionally calls tools at the end of
// the round, and the loop kicks off the next round with tool results. We
// render rounds in order so the trace reflects actual chronology rather than
// concatenating all content together with all tool calls dumped at the end.
interface CallRound {
  round: number;
  reasoning: string;
  content: string;
  toolCalls: NestedToolCall[];
}

interface LiveLLMCall {
  call_id: string;
  model: string;
  tools: string[];
  rounds: CallRound[];                    // ordered by round index
  roundsByIdx: Map<number, CallRound>;
  status: LiveCallStatus;
  cost?: number;
  usage?: Record<string, unknown>;
  errorMsg?: string;
}

// A direct (non-LLM) tool call, e.g. `ctx.tools.web_fetch(...)`. The backend
// emits the same `tool_call_started` / `tool_call_finished` events as the
// LLM-mediated path, with `via: 'direct'` and a `call_id` we use to thread
// pending → ok/err for the same call.
type DirectCallStatus = 'pending' | 'ok' | 'err';

interface DirectToolCall {
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
  status: DirectCallStatus;
  result?: unknown;
  error?: string;
}

interface NodeTrace {
  node_id: string;
  status: NodeRunStatus;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  logs: string[];
  llmCalls: LiveLLMCall[];          // insertion-ordered
  llmCallById: Map<string, LiveLLMCall>;
  directToolCalls: DirectToolCall[];           // insertion-ordered
  directToolCallById: Map<string, DirectToolCall>;
  error?: string | null;
  duration_ms?: number;
  cost?: number;
}

function ensureRound(call: LiveLLMCall, round: number | undefined): CallRound {
  const r = round ?? 0;
  let cr = call.roundsByIdx.get(r);
  if (!cr) {
    cr = { round: r, reasoning: '', content: '', toolCalls: [] };
    call.roundsByIdx.set(r, cr);
    // Maintain insertion-by-round-index ordering.
    const i = call.rounds.findIndex((x) => x.round > r);
    if (i === -1) call.rounds.push(cr);
    else call.rounds.splice(i, 0, cr);
  }
  return cr;
}

function findNestedTool(round: CallRound, tc_index: number | undefined): NestedToolCall | undefined {
  const idx = tc_index ?? 0;
  return round.toolCalls.find((t) => t.tc_index === idx);
}

function aggregateEvents(events: RunEvent[]): NodeTrace[] {
  const byId = new Map<string, NodeTrace>();
  const order: string[] = [];

  const ensureNode = (id: string): NodeTrace => {
    let t = byId.get(id);
    if (!t) {
      t = {
        node_id: id,
        status: 'pending',
        logs: [],
        llmCalls: [],
        llmCallById: new Map(),
        directToolCalls: [],
        directToolCallById: new Map(),
      };
      byId.set(id, t);
      order.push(id);
    }
    return t;
  };

  const ensureCall = (t: NodeTrace, call_id: string, model = '', tools: string[] = []): LiveLLMCall => {
    let c = t.llmCallById.get(call_id);
    if (!c) {
      c = {
        call_id,
        model,
        tools,
        rounds: [],
        roundsByIdx: new Map(),
        status: 'streaming',
      };
      t.llmCallById.set(call_id, c);
      t.llmCalls.push(c);
    } else {
      if (model && !c.model) c.model = model;
      if (tools.length && !c.tools.length) c.tools = tools;
    }
    return c;
  };

  for (const ev of events) {
    if (ev.type === 'node_started') {
      const t = ensureNode(ev.node_id);
      t.status = 'running';
      t.inputs = ev.inputs;
    } else if (ev.type === 'log') {
      ensureNode(ev.node_id).logs.push(ev.msg);
    } else if (ev.type === 'llm_call_started') {
      ensureCall(ensureNode(ev.node_id), ev.call_id, ev.model, ev.tools);
    } else if (ev.type === 'llm_round_started') {
      ensureRound(ensureCall(ensureNode(ev.node_id), ev.call_id), ev.round);
    } else if (ev.type === 'llm_call_chunk') {
      const call = ensureCall(ensureNode(ev.node_id), ev.call_id);
      const r = ensureRound(call, ev.round);
      if (ev.kind === 'content') {
        r.content += ev.delta;
      } else if (ev.kind === 'reasoning') {
        r.reasoning += ev.delta;
      } else if (ev.kind === 'tool_args') {
        let tc = findNestedTool(r, ev.tc_index);
        if (!tc) {
          tc = {
            tc_index: ev.tc_index ?? 0,
            round: r.round,
            tool: ev.tool || '',
            args_str: '',
            status: 'streaming',
          };
          r.toolCalls.push(tc);
        }
        if (ev.tool && !tc.tool) tc.tool = ev.tool;
        tc.args_str += ev.delta;
      }
    } else if (ev.type === 'llm_call_finished') {
      const call = ensureCall(ensureNode(ev.node_id), ev.call_id, ev.model);
      call.status = ev.error ? 'error' : 'done';
      call.cost = ev.cost;
      call.usage = ev.usage;
      call.errorMsg = ev.error;
      // Authoritative final content — replaces the LAST round's content
      // (the round with no further tool calls is the one that emitted it).
      if (ev.content && call.rounds.length) {
        call.rounds[call.rounds.length - 1].content = ev.content;
      }
    } else if (ev.type === 'tool_call_started') {
      const t = ensureNode(ev.node_id);
      if (ev.via === 'llm' && ev.call_id) {
        const call = ensureCall(t, ev.call_id);
        const r = ensureRound(call, ev.round);
        let tc = findNestedTool(r, ev.tc_index);
        if (!tc) {
          tc = {
            tc_index: ev.tc_index ?? 0,
            round: r.round,
            tool: ev.tool,
            args_str: JSON.stringify(ev.args),
            status: 'pending',
          };
          r.toolCalls.push(tc);
        } else {
          tc.tool = ev.tool || tc.tool;
        }
        tc.args = ev.args;
        tc.status = 'pending';
      } else if (ev.via === 'direct' && ev.call_id) {
        let dtc = t.directToolCallById.get(ev.call_id);
        if (!dtc) {
          dtc = {
            call_id: ev.call_id,
            tool: ev.tool,
            args: ev.args,
            status: 'pending',
          };
          t.directToolCallById.set(ev.call_id, dtc);
          t.directToolCalls.push(dtc);
        } else {
          dtc.tool = ev.tool || dtc.tool;
          dtc.args = ev.args;
        }
      }
    } else if (ev.type === 'tool_call_finished') {
      const t = ensureNode(ev.node_id);
      if (ev.via === 'llm' && ev.call_id) {
        const call = ensureCall(t, ev.call_id);
        const r = ensureRound(call, ev.round);
        let tc = findNestedTool(r, ev.tc_index);
        if (!tc) {
          tc = {
            tc_index: ev.tc_index ?? 0,
            round: r.round,
            tool: ev.tool,
            args_str: JSON.stringify(ev.args),
            status: 'pending',
          };
          r.toolCalls.push(tc);
        }
        tc.tool = ev.tool || tc.tool;
        tc.args = ev.args;
        tc.result = ev.result;
        tc.error = ev.error;
        tc.status = ev.error ? 'err' : 'ok';
      } else {
        // Direct call. Match the pending entry by call_id when available;
        // fall back to creating a fresh entry (handles older runs that
        // lacked call_id on direct events).
        let dtc: DirectToolCall | undefined;
        if (ev.call_id) dtc = t.directToolCallById.get(ev.call_id);
        if (!dtc) {
          dtc = {
            call_id: ev.call_id ?? `direct-${t.directToolCalls.length + 1}`,
            tool: ev.tool,
            args: ev.args,
            status: 'pending',
          };
          t.directToolCallById.set(dtc.call_id, dtc);
          t.directToolCalls.push(dtc);
        }
        dtc.tool = ev.tool || dtc.tool;
        dtc.args = ev.args;
        dtc.result = ev.result;
        dtc.error = ev.error;
        dtc.status = ev.error ? 'err' : 'ok';
      }
    } else if (ev.type === 'node_finished') {
      const t = ensureNode(ev.node_id);
      t.status = ev.status;
      t.inputs = ev.inputs;
      t.outputs = ev.outputs;
      t.error = ev.error;
      t.duration_ms = ev.duration_ms;
      t.cost = ev.cost;
      // Trust accumulated logs from chunk events when present, else fall back.
      if (t.logs.length === 0 && ev.logs && ev.logs.length) {
        t.logs = ev.logs as string[];
      }
      // Mark any still-streaming live calls as done so the spinner stops.
      for (const c of t.llmCalls) {
        if (c.status === 'streaming') c.status = 'done';
        for (const r of c.rounds) {
          for (const tc of r.toolCalls) {
            if (tc.status === 'streaming' || tc.status === 'pending') {
              tc.status = tc.error ? 'err' : 'ok';
            }
          }
        }
      }
    }
  }
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

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
  // Guards against stale state leaking across workflows (e.g. after deleting
  // the active workflow and auto-switching to another).
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

  const traces = useMemo(
    () => (ownRun ? aggregateEvents(ownRun.events) : []),
    [ownRun?.events],
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
          <RunTraceCard
            workflow={workflow}
            runId={ownRun.id}
            status={ownRun.status}
            error={ownRun.error}
            cost={ownRun.totalCost}
            outputs={ownRun.finalOutputs}
            traces={traces}
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
                    alignItems: 'baseline',
                    gap: 8,
                    background: 'transparent',
                    borderBottom: '1px solid var(--rule-2)',
                    border: 0,
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
                  <span className="smallcaps" style={{ fontSize: 9 }}>{h.status}</span>
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
            color: status === 'error' ? 'var(--state-err)' : 'var(--ink-4)',
            fontSize: 12,
          }}
        >
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

// Renders the final output of a run as a list of click-to-expand port rows,
// matching the per-node trace view. The backend emits `outputs` as a
// port-name → value dict (one entry per output port on the output node);
// each entry becomes one row, and clicking opens the value in the same
// fullscreen viewer used elsewhere.
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
    <div style={{ marginBottom: 14 }}>
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

function RunTraceCard({
  workflow, runId, status, error, cost, outputs, traces, onSendErrorToOrchestrator,
}: {
  workflow: WorkflowDetail;
  runId: string;
  status: string;
  error: string | null;
  cost: number;
  outputs: Record<string, unknown> | null;
  traces: NodeTrace[];
  onSendErrorToOrchestrator: (message: string) => void;
}) {
  const hasFinal = status === 'success' && outputs && Object.keys(outputs).length > 0;
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
            fontSize:
              status === 'success' || status === 'error' ? 14 : undefined,
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
      <details style={{ marginTop: hasFinal ? 4 : 0 }} open={!hasFinal}>
        <summary
          className="smallcaps"
          style={{
            cursor: 'pointer',
            padding: '4px 0',
            color: 'var(--ink-3)',
            fontSize: 10,
          }}
        >
          trace · {traces.length} {traces.length === 1 ? 'node' : 'nodes'}
        </summary>
        <div style={{ marginTop: 6 }}>
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
                <div
                  style={{
                    padding: '8px 0 8px 14px',
                    marginLeft: 4,
                    borderLeft: '1px solid var(--rule-2)',
                  }}
                >
                  {t.error && (
                    <>
                      <pre
                        className="mono"
                        style={{ fontSize: 11, color: 'var(--state-err)', whiteSpace: 'pre-wrap', margin: '0 0 8px' }}
                      >
                        {t.error}
                      </pre>
                      <SendErrorButton
                        onClick={() =>
                          onSendErrorToOrchestrator(
                            buildErrorPrompt({ runId, nodeName, error: t.error ?? '' }),
                          )
                        }
                      />
                    </>
                  )}
                  <NodeIOBlock
                    workflow={workflow}
                    nodeId={t.node_id}
                    nodeName={nodeName}
                    inputs={t.inputs}
                    outputs={t.outputs}
                    logs={t.logs.length ? t.logs : undefined}
                  />
                  {t.llmCalls.map((c, idx) => (
                    <LLMCallCard key={c.call_id} call={c} index={idx} />
                  ))}
                  {t.directToolCalls.length > 0 && (
                    <details
                      style={{ margin: '10px 0 0' }}
                      open={t.directToolCalls.length <= 5}
                    >
                      <summary
                        className="smallcaps"
                        style={{ cursor: 'pointer', padding: '2px 0', marginBottom: 4 }}
                      >
                        tool calls — direct · {t.directToolCalls.length}
                      </summary>
                      {t.directToolCalls.map((dtc) => (
                        <DirectToolCard key={dtc.call_id} call={dtc} />
                      ))}
                    </details>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      </details>
      <div className="serif" style={{ fontStyle: 'italic', fontSize: 12, color: 'var(--ink-4)', marginTop: 10 }}>
        cost — ${cost.toFixed(4)}
      </div>
    </div>
  );
}

function LLMCallCard({ call, index }: { call: LiveLLMCall; index: number }) {
  const isStreaming = call.status === 'streaming';
  const isError = call.status === 'error';
  const statusColor = isError
    ? 'var(--state-err)'
    : isStreaming
      ? 'var(--ink-4)'
      : 'var(--state-ok)';
  const statusLabel = isStreaming ? 'streaming' : isError ? 'failed' : 'done';
  const lastRoundIdx = call.rounds.length - 1;
  const showWaiting =
    isStreaming &&
    call.rounds.every((r) => !r.content && !r.reasoning && r.toolCalls.length === 0);

  return (
    <div
      className="fade-in"
      style={{
        margin: '10px 0 0',
        padding: '10px 12px',
        background: 'var(--paper)',
        border: '1px solid var(--rule)',
        borderRadius: 3,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span className="smallcaps">llm call {index + 1}</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
          {call.model || '…'}
        </span>
        {call.tools.length > 0 && (
          <span
            className="serif"
            style={{ fontStyle: 'italic', fontSize: 12, color: 'var(--ink-4)' }}
          >
            tools=[{call.tools.join(', ')}]
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span className="smallcaps" style={{ fontSize: 9, color: statusColor }}>
          {isStreaming && <span className="caret" style={{ marginRight: 4 }} />}
          {statusLabel}
          {!isStreaming && typeof call.cost === 'number' && (
            <span style={{ marginLeft: 6, color: 'var(--ink-4)' }}>
              · ${call.cost.toFixed(4)}
            </span>
          )}
        </span>
      </div>

      {call.errorMsg && (
        <pre
          className="mono"
          style={{
            fontSize: 11,
            color: 'var(--state-err)',
            whiteSpace: 'pre-wrap',
            margin: '0 0 6px',
          }}
        >
          {call.errorMsg}
        </pre>
      )}

      {call.rounds.map((r, i) => (
        <CallRoundView
          key={r.round}
          round={r}
          showRoundBadge={call.rounds.length > 1}
          isLastRound={i === lastRoundIdx}
          callStreaming={isStreaming}
        />
      ))}

      {showWaiting && (
        <div
          className="serif"
          style={{ fontStyle: 'italic', fontSize: 12.5, color: 'var(--ink-4)', marginTop: 4 }}
        >
          waiting for first token…
        </div>
      )}
    </div>
  );
}

function CallRoundView({
  round,
  showRoundBadge,
  isLastRound,
  callStreaming,
}: {
  round: CallRound;
  showRoundBadge: boolean;
  isLastRound: boolean;
  callStreaming: boolean;
}) {
  // A round is "live" while the call is streaming AND this is the last round
  // we've observed — that's where new chunks land.
  const live = callStreaming && isLastRound;
  // Inside a round, content appears once reasoning has stopped streaming.
  const reasoningLive = live && !round.content && round.toolCalls.length === 0;
  const contentLive = live && !!round.content && round.toolCalls.length === 0;
  const roundTitle = `round ${round.round + 1}`;

  return (
    <div style={{ marginTop: showRoundBadge ? 10 : 6 }}>
      {showRoundBadge && (
        <div
          className="smallcaps"
          style={{ fontSize: 9, color: 'var(--ink-4)', marginBottom: 4 }}
        >
          round {round.round + 1}
        </div>
      )}
      {round.reasoning && (
        <TraceRow
          kind="reasoning"
          text={round.reasoning}
          live={reasoningLive}
          viewerTitle={`${roundTitle} · thinking`}
        />
      )}
      {round.content && (
        <TraceRow
          kind="content"
          text={round.content}
          live={contentLive}
          viewerTitle={`${roundTitle} · output`}
        />
      )}
      {round.toolCalls.length > 0 && (
        <details style={{ marginTop: 8 }} open={round.toolCalls.length <= 5}>
          <summary
            className="smallcaps"
            style={{ cursor: 'pointer', padding: '2px 0', marginBottom: 4, fontSize: 9 }}
          >
            tool calls · {round.toolCalls.length}
          </summary>
          {round.toolCalls.map((tc) => (
            <NestedToolCard key={`${tc.round}-${tc.tc_index}`} tc={tc} />
          ))}
        </details>
      )}
    </div>
  );
}

/**
 * Compact, click-to-open row for LLM reasoning / output streams.
 *
 * Nothing is shown inline — even while the call is streaming. The row only
 * advertises that there is content (with a live char counter + caret while
 * tokens arrive); clicking pops it into the fullscreen viewer, which
 * re-renders against the latest text on every parent update.
 */
function TraceRow({
  kind,
  text,
  live,
  viewerTitle,
}: {
  kind: 'reasoning' | 'content';
  text: string;
  live: boolean;
  viewerTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const isReasoning = kind === 'reasoning';
  const label = isReasoning ? (live ? 'thinking' : 'thought') : live ? 'streaming' : 'output';
  const charCount = text.length;
  const lineCount = text.split('\n').length;
  const sizeText =
    charCount === 0
      ? '…'
      : lineCount > 1
        ? `${lineCount} lines · ${charCount.toLocaleString()} chars`
        : `${charCount.toLocaleString()} chars`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="port-row"
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'baseline',
          gap: 8,
          padding: '6px 8px',
          margin: '4px -8px 0',
          background: 'transparent',
          border: 0,
          borderRadius: 3,
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'inherit',
          color: 'inherit',
        }}
      >
        <span
          className="serif"
          style={{
            fontStyle: 'italic',
            fontSize: 12,
            color: isReasoning ? 'var(--ink-4)' : 'var(--ink-3)',
          }}
        >
          {label}
        </span>
        {live && <span className="caret" />}
        <span style={{ flex: 1 }} />
        <span className="smallcaps" style={{ fontSize: 9, color: 'var(--ink-4)' }}>
          {sizeText}
        </span>
        <span
          aria-hidden
          style={{
            color: 'var(--ink-4)',
            fontFamily: 'var(--serif)',
            fontStyle: 'italic',
            fontSize: 12,
          }}
        >
          ⤢
        </span>
      </button>
      {open && (
        <ViewerOverlay
          title={viewerTitle}
          value={text}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function DirectToolCard({ call }: { call: DirectToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const status = call.status;
  const statusLabel =
    status === 'ok' ? '✓ done' :
    status === 'err' ? '× failed' :
    '… running';
  const statusColor =
    status === 'ok' ? 'var(--state-ok)' :
    status === 'err' ? 'var(--state-err)' :
    'var(--ink-4)';
  const argsDisplay = JSON.stringify(call.args);

  return (
    <div
      className="tool-call fade-in"
      style={{ padding: '7px 10px', margin: '6px 0', cursor: 'pointer' }}
      onClick={() => setExpanded((v) => !v)}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11.5 }}>
        <span
          aria-hidden
          style={{
            width: 10,
            display: 'inline-block',
            textAlign: 'center',
            color: 'var(--ink-4)',
            fontSize: 10,
          }}
        >
          {expanded ? '▾' : '▸'}
        </span>
        <span className="mono" style={{ color: 'var(--accent-ink)', fontSize: 10.5 }}>
          {call.tool || '…'}
        </span>
        <span
          className="mono"
          style={{
            color: 'var(--ink-4)',
            fontSize: 10.5,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {argsDisplay || '…'}
        </span>
        <span className="smallcaps" style={{ color: statusColor, fontSize: 9 }}>
          {status === 'pending' && <span className="caret" style={{ marginRight: 4 }} />}
          {statusLabel}
        </span>
      </div>
      {expanded && (
        <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
          <div className="smallcaps" style={{ marginBottom: 3 }}>args</div>
          <JsonView value={call.args} />
          {call.status === 'ok' && call.result !== undefined && (
            <ValueRow
              label="result"
              value={call.result}
              viewerTitle={`${call.tool || 'tool'} · result`}
            />
          )}
          {call.status === 'err' && call.error && (
            <>
              <div
                className="smallcaps"
                style={{ margin: '6px 0 3px', color: 'var(--state-err)' }}
              >
                error
              </div>
              <pre
                className="mono"
                style={{ fontSize: 11, color: 'var(--state-err)', whiteSpace: 'pre-wrap', margin: 0 }}
              >
                {call.error}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NestedToolCard({ tc }: { tc: NestedToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const status = tc.status;
  const statusLabel =
    status === 'ok' ? '✓ done' :
    status === 'err' ? '× failed' :
    status === 'pending' ? '… running' :
    '… streaming';
  const statusColor =
    status === 'ok' ? 'var(--state-ok)' :
    status === 'err' ? 'var(--state-err)' :
    'var(--ink-4)';
  const argsDisplay = tc.args !== undefined ? JSON.stringify(tc.args) : tc.args_str;

  return (
    <div
      className="tool-call fade-in"
      style={{ padding: '7px 10px', margin: '6px 0', cursor: 'pointer' }}
      onClick={() => setExpanded((v) => !v)}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11.5 }}>
        <span
          aria-hidden
          style={{
            width: 10,
            display: 'inline-block',
            textAlign: 'center',
            color: 'var(--ink-4)',
            fontSize: 10,
          }}
        >
          {expanded ? '▾' : '▸'}
        </span>
        <span className="mono" style={{ color: 'var(--accent-ink)', fontSize: 10.5 }}>
          {tc.tool || '…'}
        </span>
        <span
          className="mono"
          style={{
            color: 'var(--ink-4)',
            fontSize: 10.5,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {argsDisplay || '…'}
        </span>
        <span className="smallcaps" style={{ color: statusColor, fontSize: 9 }}>
          {statusLabel}
        </span>
      </div>
      {expanded && (
        <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
          <div className="smallcaps" style={{ marginBottom: 3 }}>args</div>
          {tc.args !== undefined ? (
            <JsonView value={tc.args} />
          ) : (
            <pre
              className="mono"
              style={{ fontSize: 11, color: 'var(--ink-3)', whiteSpace: 'pre-wrap', margin: 0 }}
            >
              {tc.args_str || '…'}
            </pre>
          )}
          {tc.status === 'ok' && tc.result !== undefined && (
            <ValueRow
              label="result"
              value={tc.result}
              viewerTitle={`${tc.tool || 'tool'} · result`}
            />
          )}
          {tc.status === 'err' && tc.error && (
            <>
              <div
                className="smallcaps"
                style={{ margin: '6px 0 3px', color: 'var(--state-err)' }}
              >
                error
              </div>
              <pre
                className="mono"
                style={{ fontSize: 11, color: 'var(--state-err)', whiteSpace: 'pre-wrap', margin: 0 }}
              >
                {tc.error}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

