import { useEffect, useMemo, useState } from 'react';
import type {
  WorkflowDetail, Run, IOPort, NodeRunStatus, CurrentRun, RunEvent,
} from '../types';
import { api } from '../api';
import { JsonView } from './JsonView';
import { PortRow, ValueRow, ViewerOverlay } from './ValueViewer';

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

interface DirectToolCall {
  tool: string;
  args: Record<string, unknown>;
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
  directToolCalls: DirectToolCall[];
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
      }
      // direct tool starts get matched up at finish — nothing to record yet.
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
        t.directToolCalls.push({
          tool: ev.tool,
          args: ev.args,
          result: ev.result,
          error: ev.error,
        });
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

export function RunPanel({ workflow, currentRun, onStart, onCancel, onClose }: Props) {
  const inputNode = workflow.nodes.find((n) => n.id === workflow.input_node_id);
  const inputPorts: IOPort[] = inputNode?.inputs ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Run[]>([]);
  const [historicalRun, setHistoricalRun] = useState<Run | null>(null);

  useEffect(() => {
    api.listRuns(workflow.id).then(setHistory).catch(() => {});
  }, [workflow.id]);

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
    <div className="fade-in" style={PANEL_STYLE}>
      <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid var(--rule)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="smallcaps">run</span>
          <span style={{ flex: 1 }} />
          <button
            className="ed-btn ed-btn--mini"
            onClick={onClose}
          >
            close <span className="ed-btn__mark">×</span>
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
          <button className="ed-btn ed-btn--danger" onClick={onCancel}>
            cancel <span className="ed-btn__mark">×</span>
          </button>
        ) : (
          <button className="ed-btn ed-btn--primary" onClick={start} disabled={!inputNode}>
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
                <div style={{ padding: '8px 0' }}>
                  {t.error && (
                    <pre
                      className="mono"
                      style={{ fontSize: 11, color: 'var(--state-err)', whiteSpace: 'pre-wrap', margin: '0 0 8px' }}
                    >
                      {t.error}
                    </pre>
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
                    <div style={{ marginBottom: 8 }}>
                      <div className="smallcaps" style={{ marginBottom: 4 }}>
                        tool calls — direct
                      </div>
                      <ValueRow
                        label={`${t.directToolCalls.length} ${
                          t.directToolCalls.length === 1 ? 'call' : 'calls'
                        }`}
                        value={t.directToolCalls}
                        viewerTitle={`${nodeName} · direct tool calls`}
                      />
                    </div>
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
        <div style={{ marginTop: 8 }}>
          {round.toolCalls.map((tc) => (
            <NestedToolCard key={`${tc.round}-${tc.tc_index}`} tc={tc} />
          ))}
        </div>
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

function HistoricalRunCard({ workflow, run }: { workflow: WorkflowDetail; run: Run }) {
  const hasFinal = run.status === 'success' && run.outputs && Object.keys(run.outputs).length > 0;
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
      {hasFinal && <FinalOutputBlock workflow={workflow} outputs={run.outputs} />}
      <details open={!hasFinal} style={{ marginTop: hasFinal ? 4 : 0 }}>
        <summary
          className="smallcaps"
          style={{
            cursor: 'pointer',
            padding: '4px 0',
            color: 'var(--ink-3)',
            fontSize: 10,
          }}
        >
          trace · {run.node_runs.length} {run.node_runs.length === 1 ? 'node' : 'nodes'}
        </summary>
        <div style={{ marginTop: 6 }}>
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
              <NodeIOBlock
                workflow={workflow}
                nodeId={nr.node_id}
                nodeName={nodeName}
                inputs={nr.inputs}
                outputs={nr.outputs}
                logs={nr.logs.length ? nr.logs : undefined}
              />
              {nr.llm_calls.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div className="smallcaps" style={{ marginBottom: 4 }}>llm calls</div>
                  <ValueRow
                    label={`${nr.llm_calls.length} ${nr.llm_calls.length === 1 ? 'call' : 'calls'}`}
                    value={nr.llm_calls}
                    viewerTitle={`${nodeName} · llm calls`}
                  />
                </div>
              )}
              {nr.tool_calls.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div className="smallcaps" style={{ marginBottom: 4 }}>tool calls</div>
                  <ValueRow
                    label={`${nr.tool_calls.length} ${nr.tool_calls.length === 1 ? 'call' : 'calls'}`}
                    value={nr.tool_calls}
                    viewerTitle={`${nodeName} · tool calls`}
                  />
                </div>
              )}
            </div>
          </details>
        );
      })}
        </div>
      </details>
      <div className="serif" style={{ fontStyle: 'italic', fontSize: 12, color: 'var(--ink-4)', marginTop: 10 }}>
        cost — ${run.total_cost.toFixed(4)}
      </div>
    </div>
  );
}

/**
 * Render a node's input/output ports as a compact, clickable list.
 *
 * Each port becomes one row (name · type · preview · size · expand affordance);
 * clicking opens the full value in the viewer overlay. For inputs, we resolve
 * the upstream edge so the row also shows "from upstream-node.port" — clarifying
 * that the value is a duplicate of an upstream output without re-rendering it.
 */
function PortList({
  values,
  schema,
  workflow,
  nodeId,
  nodeName,
  kind,
}: {
  values: Record<string, unknown>;
  schema: IOPort[];
  workflow: WorkflowDetail;
  nodeId: string;
  nodeName: string;
  kind: 'inputs' | 'outputs';
}) {
  const seen = new Set<string>();
  const rows: React.ReactNode[] = [];
  for (const port of schema) {
    seen.add(port.name);
    if (!(port.name in values)) continue;
    let subtitle: string | undefined;
    if (kind === 'inputs') {
      const e = workflow.edges.find(
        (x) => x.to_node_id === nodeId && x.to_input === port.name,
      );
      if (e) {
        const src = workflow.nodes.find((n) => n.id === e.from_node_id);
        subtitle = `from ${src?.name ?? e.from_node_id}.${e.from_output}`;
      }
    }
    rows.push(
      <PortRow
        key={port.name}
        name={port.name}
        typeHint={port.type_hint}
        value={values[port.name]}
        viewerTitle={`${nodeName} · ${kind === 'inputs' ? 'in' : 'out'} · ${port.name}`}
        viewerSubtitle={subtitle}
      />,
    );
  }
  // any keys present at runtime but not declared in the schema
  for (const k of Object.keys(values)) {
    if (seen.has(k)) continue;
    rows.push(
      <PortRow
        key={k}
        name={k}
        value={values[k]}
        viewerTitle={`${nodeName} · ${kind === 'inputs' ? 'in' : 'out'} · ${k}`}
      />,
    );
  }
  if (rows.length === 0) {
    return (
      <span
        className="serif"
        style={{ fontStyle: 'italic', fontSize: 11.5, color: 'var(--ink-4)' }}
      >
        none
      </span>
    );
  }
  return <div>{rows}</div>;
}

function NodeIOBlock({
  workflow,
  nodeId,
  nodeName,
  inputs,
  outputs,
  logs,
}: {
  workflow: WorkflowDetail;
  nodeId: string;
  nodeName: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  logs?: unknown[];
}) {
  const schemaNode = workflow.nodes.find((n) => n.id === nodeId);
  return (
    <>
      {inputs !== undefined && (
        <div style={{ marginBottom: 8 }}>
          <div className="smallcaps" style={{ marginBottom: 4 }}>inputs</div>
          <PortList
            values={inputs}
            schema={schemaNode?.inputs ?? []}
            workflow={workflow}
            nodeId={nodeId}
            nodeName={nodeName}
            kind="inputs"
          />
        </div>
      )}
      {outputs !== undefined && (
        <div style={{ marginBottom: 8 }}>
          <div className="smallcaps" style={{ marginBottom: 4 }}>outputs</div>
          <PortList
            values={outputs}
            schema={schemaNode?.outputs ?? []}
            workflow={workflow}
            nodeId={nodeId}
            nodeName={nodeName}
            kind="outputs"
          />
        </div>
      )}
      {logs && logs.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div className="smallcaps" style={{ marginBottom: 3 }}>logs</div>
          <JsonView value={logs} />
        </div>
      )}
    </>
  );
}
