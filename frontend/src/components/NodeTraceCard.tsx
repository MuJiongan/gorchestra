import { useState } from 'react';
import type {
  WorkflowDetail, NodeRun, NodeRunStatus, RunEvent,
} from '../types';
import { JsonView } from './JsonView';
import { ValueRow, ViewerOverlay } from './ValueViewer';
import { NodeIOBlock } from './NodeIOBlock';

// --- types ----------------------------------------------------------------
//
// One entry per ctx.call_llm invocation, broken down by agent-loop round so
// reasoning / content / tool-arg streams render in chronological order rather
// than as one concatenated blob.

export type LiveCallStatus = 'streaming' | 'done' | 'error';
export type ToolCallStatus = 'streaming' | 'pending' | 'ok' | 'err';

export interface NestedToolCall {
  tc_index: number;
  round: number;
  tool: string;
  args_str: string;
  args?: Record<string, unknown>;
  status: ToolCallStatus;
  result?: unknown;
  error?: string;
}

export interface CallRound {
  round: number;
  reasoning: string;
  content: string;
  toolCalls: NestedToolCall[];
}

export interface LiveLLMCall {
  call_id: string;
  model: string;
  tools: string[];
  rounds: CallRound[];
  roundsByIdx: Map<number, CallRound>;
  status: LiveCallStatus;
  cost?: number;
  usage?: Record<string, unknown>;
  errorMsg?: string;
}

export type DirectCallStatus = 'pending' | 'ok' | 'err';

export interface DirectToolCall {
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
  status: DirectCallStatus;
  result?: unknown;
  error?: string;
}

export interface NodeTrace {
  node_id: string;
  status: NodeRunStatus;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  logs: string[];
  llmCalls: LiveLLMCall[];
  llmCallById: Map<string, LiveLLMCall>;
  directToolCalls: DirectToolCall[];
  directToolCallById: Map<string, DirectToolCall>;
  error?: string | null;
  duration_ms?: number;
  cost?: number;
}

const STATE_CLASS: Record<NodeRunStatus, string> = {
  pending: 'idle',
  running: 'running',
  success: 'success',
  error: 'error',
  skipped: 'skipped',
};

function ensureRound(call: LiveLLMCall, round: number | undefined): CallRound {
  const r = round ?? 0;
  let cr = call.roundsByIdx.get(r);
  if (!cr) {
    cr = { round: r, reasoning: '', content: '', toolCalls: [] };
    call.roundsByIdx.set(r, cr);
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

// --- aggregator -----------------------------------------------------------
//
// Folds a chronological RunEvent[] into per-node NodeTrace records. Pure /
// memoisable — call repeatedly as new events arrive on the WS.

export function aggregateEvents(events: RunEvent[]): NodeTrace[] {
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

// --- historical NodeRun → NodeTrace ---------------------------------------
//
// Lets the per-node renderer accept a frozen NodeRun row (snapshot view) the
// same way it accepts a live aggregation. Historical llm_calls don't carry
// per-round streaming detail, so each is folded into a single "round 0"
// LiveLLMCall preserving content / cost / tool_calls_made.

interface HistoricalLLMCall {
  call_id?: string;
  model?: string;
  tools?: string[];
  content?: string;
  tool_calls_made?: Array<{
    name?: string;
    arguments?: Record<string, unknown>;
    result?: unknown;
    error?: string;
  }>;
  usage?: Record<string, unknown>;
  cost?: number;
}

interface HistoricalToolCall {
  call_id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  via?: 'llm' | 'direct';
}

export function nodeRunToTrace(nr: NodeRun): NodeTrace {
  const llmCalls: LiveLLMCall[] = [];
  const llmCallById = new Map<string, LiveLLMCall>();

  const rawCalls = (nr.llm_calls as unknown as HistoricalLLMCall[]) ?? [];
  rawCalls.forEach((rec, i) => {
    const id = rec.call_id ?? `hist-llm-${i}`;
    const toolCalls: NestedToolCall[] = (rec.tool_calls_made ?? []).map((tc, j) => ({
      tc_index: j,
      round: 0,
      tool: tc.name ?? '',
      args_str: JSON.stringify(tc.arguments ?? {}),
      args: tc.arguments,
      status: tc.error ? 'err' : 'ok',
      result: tc.result,
      error: tc.error,
    }));
    const round: CallRound = {
      round: 0,
      reasoning: '',
      content: rec.content ?? '',
      toolCalls,
    };
    const c: LiveLLMCall = {
      call_id: id,
      model: rec.model ?? '',
      tools: rec.tools ?? [],
      rounds: [round],
      roundsByIdx: new Map([[0, round]]),
      status: 'done',
      cost: rec.cost,
      usage: rec.usage,
    };
    llmCalls.push(c);
    llmCallById.set(id, c);
  });

  // Direct tool calls: NodeRun.tool_calls aggregates everything (LLM-mediated
  // and direct). The LLM-mediated ones are already represented inside
  // llm_calls.tool_calls_made above, so to avoid duplication we surface only
  // entries marked `via: "direct"` (or untagged ones from older rows that
  // didn't record `via` at all — those predate the dual-path tracking).
  const directToolCalls: DirectToolCall[] = [];
  const directToolCallById = new Map<string, DirectToolCall>();
  const rawTools = (nr.tool_calls as unknown as HistoricalToolCall[]) ?? [];
  rawTools.forEach((tc, i) => {
    if (tc.via === 'llm') return;
    const id = tc.call_id ?? `hist-tool-${i}`;
    const dtc: DirectToolCall = {
      call_id: id,
      tool: tc.name ?? '',
      args: tc.arguments ?? {},
      status: tc.error ? 'err' : 'ok',
      result: tc.result,
      error: tc.error,
    };
    directToolCalls.push(dtc);
    directToolCallById.set(id, dtc);
  });

  return {
    node_id: nr.node_id,
    status: nr.status,
    inputs: nr.inputs,
    outputs: nr.outputs,
    logs: (nr.logs as string[]) ?? [],
    llmCalls,
    llmCallById,
    directToolCalls,
    directToolCallById,
    error: nr.error,
    duration_ms: nr.duration_ms,
    cost: nr.cost,
  };
}

// --- per-node renderer ----------------------------------------------------
//
// Renders a single NodeTrace — header (status / duration / cost), error,
// inputs / outputs / logs, LLM-call cards, direct tool calls. Same component
// drives the live in-flight view (events streaming in via aggregateEvents)
// and the snapshot view (one-shot conversion via nodeRunToTrace).

interface NodeTraceCardProps {
  workflow: WorkflowDetail;
  trace: NodeTrace;
  /** Hook for the "send to orchestrator" button on errors. Omit to hide. */
  onSendErrorToOrchestrator?: (message: string) => void;
  runId?: string;
}

function buildErrorPrompt({
  runId, nodeName, error,
}: {
  runId?: string;
  nodeName: string;
  error: string;
}): string {
  const prefix = runId ? `Node "${nodeName}" failed during run ${runId.slice(0, 8)}:` : `Node "${nodeName}" failed:`;
  return `${prefix}\n\n${error}\n\nPlease diagnose and fix.`;
}

export function NodeTraceCard({
  workflow, trace, onSendErrorToOrchestrator, runId,
}: NodeTraceCardProps) {
  const nodeName =
    workflow.nodes.find((n) => n.id === trace.node_id)?.name ?? trace.node_id;

  return (
    <div className="fade-in" style={{ padding: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          padding: '4px 0 10px',
          borderBottom: '1px solid var(--rule-2)',
          marginBottom: 10,
        }}
      >
        <span className={`node-state-dot ${STATE_CLASS[trace.status]}`} />
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink)' }}>
          {nodeName}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="smallcaps"
          style={{
            fontSize: 9,
            color:
              trace.status === 'success' ? 'var(--state-ok)' :
              trace.status === 'error' ? 'var(--state-err)' :
              trace.status === 'skipped' ? 'var(--ink-4)' : 'var(--ink-3)',
          }}
        >
          {trace.status}
          {typeof trace.duration_ms === 'number' ? ` · ${trace.duration_ms}ms` : ''}
          {typeof trace.cost === 'number' && trace.cost > 0
            ? ` · $${trace.cost.toFixed(4)}`
            : ''}
        </span>
      </div>

      {trace.error && (
        <>
          <pre
            className="mono"
            style={{ fontSize: 11, color: 'var(--state-err)', whiteSpace: 'pre-wrap', margin: '0 0 8px' }}
          >
            {trace.error}
          </pre>
          {onSendErrorToOrchestrator && (
            <button
              type="button"
              className="ed-btn ed-btn--mini"
              onClick={() =>
                onSendErrorToOrchestrator(
                  buildErrorPrompt({ runId, nodeName, error: trace.error ?? '' }),
                )
              }
              title="forward this error to the orchestrator"
              style={{ marginBottom: 10 }}
            >
              send to orchestrator <span className="ed-btn__mark">→</span>
            </button>
          )}
        </>
      )}

      <NodeIOBlock
        workflow={workflow}
        nodeId={trace.node_id}
        nodeName={nodeName}
        inputs={trace.inputs}
        outputs={trace.outputs}
        logs={trace.logs.length ? trace.logs : undefined}
      />

      {trace.llmCalls.map((c, idx) => (
        <LLMCallCard key={c.call_id} call={c} index={idx} />
      ))}

      {trace.directToolCalls.length > 0 && (
        <details style={{ margin: '10px 0 0' }} open={trace.directToolCalls.length <= 5}>
          <summary
            className="smallcaps"
            style={{ cursor: 'pointer', padding: '2px 0', marginBottom: 4 }}
          >
            tool calls — direct · {trace.directToolCalls.length}
          </summary>
          {trace.directToolCalls.map((dtc) => (
            <DirectToolCard key={dtc.call_id} call={dtc} />
          ))}
        </details>
      )}
    </div>
  );
}

// --- LLM call cards -------------------------------------------------------

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
  round, showRoundBadge, isLastRound, callStreaming,
}: {
  round: CallRound;
  showRoundBadge: boolean;
  isLastRound: boolean;
  callStreaming: boolean;
}) {
  const live = callStreaming && isLastRound;
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

function TraceRow({
  kind, text, live, viewerTitle,
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
