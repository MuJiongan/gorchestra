import { useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { WFNode, IOPort, WorkflowDetail, Run, CurrentRun } from '../types';
import { api } from '../api';
import {
  NodeTraceCard, aggregateEvents, nodeRunToTrace, type NodeTrace,
} from './NodeTraceCard';

interface Props {
  node: WFNode;
  workflow: WorkflowDetail;
  onClose: () => void;
  onChange: () => void;
  /** Render as read-only — used when inspecting a snapshot. Hides the save
   * button and locks the editor. */
  readOnly?: boolean;
  /** When set, the trace tab is bound to this single historical run. The
   * snapshot view passes the run that produced the snapshot. */
  pinnedRun?: Run;
  /** Live in-flight run on this workflow. When present (and `pinnedRun` is
   * not), the trace tab streams events for `node.id` from the run's WS. */
  currentRun?: CurrentRun | null;
  /** Forward a node-level error from the trace tab to the orchestrator. */
  onSendErrorToOrchestrator?: (message: string) => void;
}

type Tab = 'code' | 'i/o' | 'trace';

const PANEL_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--paper)',
  display: 'flex',
  flexDirection: 'column',
  zIndex: 20,
};

/**
 * Node side panel.
 *
 * Topology (node name, description, port shape, input/output role) is owned
 * exclusively by the orchestrator and rendered read-only here — the user
 * asks the orchestrator via chat to make those changes. Per-node model and
 * tools likewise live with the orchestrator; user-level defaults are set
 * once in workflow settings.
 *
 * Content the user can still refine directly:
 *   - code (Monaco editor)
 *
 * Saves set `mark_user_edited` so the orchestrator's next pass can preserve
 * user intent (per PRD §4.4).
 */
export function NodePanel({
  node, workflow, onClose, onChange, readOnly, pinnedRun, currentRun,
  onSendErrorToOrchestrator,
}: Props) {
  // Trace tab visibility:
  //   - snapshot view: pinnedRun is set, the trace is the historical NodeRun
  //     for this node within that run.
  //   - in-flight run on this workflow: currentRun.events stream live; the
  //     trace re-aggregates on each new event. Only counts when the run is
  //     bound to this workflow id (avoids leaking state across workflows).
  const liveRunOnThisWorkflow =
    !pinnedRun &&
    currentRun &&
    currentRun.workflow_id === workflow.id
      ? currentRun
      : null;

  const trace: NodeTrace | null = useMemo(() => {
    if (pinnedRun) {
      const nr = pinnedRun.node_runs.find((x) => x.node_id === node.id);
      return nr ? nodeRunToTrace(nr) : null;
    }
    if (liveRunOnThisWorkflow) {
      const all = aggregateEvents(liveRunOnThisWorkflow.events);
      return all.find((t) => t.node_id === node.id) ?? null;
    }
    return null;
  }, [pinnedRun, liveRunOnThisWorkflow?.events, node.id]);

  const traceTabAvailable = !!pinnedRun || !!liveRunOnThisWorkflow;

  const [tab, setTab] = useState<Tab>('code');
  const [code, setCode] = useState(node.code);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setCode(node.code);
    setDirty(false);
    setTab('code');
  }, [node.id]);

  // If the trace tab disappears (run was cleared, snapshot exited) while it
  // was selected, fall back to code so we don't render an empty pane.
  useEffect(() => {
    if (tab === 'trace' && !traceTabAvailable) setTab('code');
  }, [tab, traceTabAvailable]);

  const isInput = workflow.input_node_id === node.id;
  const isOutput = workflow.output_node_id === node.id;
  const role = isInput ? 'input' : isOutput ? 'output' : null;

  const save = async () => {
    await api.patchNode(node.id, {
      code,
      mark_user_edited: true,
    });
    setDirty(false);
    onChange();
  };

  return (
    <div className="fade-in" style={PANEL_STYLE}>
      <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid var(--rule)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="smallcaps">node</span>
          <span style={{ flex: 1 }} />
          {dirty && !readOnly && (
            <button className="btn-ink" style={{ padding: '5px 12px', fontSize: 11 }} onClick={save}>
              save
            </button>
          )}
          <button
            className="btn-ghost"
            onClick={onClose}
            style={{ padding: '3px 9px', fontSize: 11 }}
          >
            close ✕
          </button>
        </div>
        <div
          className="serif mono"
          title={node.name}
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 18,
            marginTop: 6,
            color: 'var(--ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {node.name}
        </div>
        {role && (
          <div className="serif" style={{ fontStyle: 'italic', fontSize: 12, color: 'var(--accent-ink)', marginTop: -2 }}>
            · {role}
          </div>
        )}
        {node.description && (
          <div
            className="serif"
            style={{
              fontStyle: 'italic',
              fontSize: 13,
              color: 'var(--ink-3)',
              marginTop: 4,
              lineHeight: 1.45,
            }}
          >
            {node.description}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid var(--rule)', padding: '0 18px' }}>
        {/* `trace` shows when this node is part of a run we can read — a
         * frozen snapshot (pinnedRun) or a live in-flight run on this
         * workflow. Otherwise it'd just render an empty pane, so we hide
         * the button. */}
        {(traceTabAvailable
          ? (['code', 'i/o', 'trace'] as const)
          : (['code', 'i/o'] as const)
        ).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className="smallcaps"
            style={{
              padding: '10px 12px',
              borderBottom: tab === k ? '1.5px solid var(--ink)' : '1.5px solid transparent',
              color: tab === k ? 'var(--ink)' : 'var(--ink-4)',
              marginRight: 4,
              background: 'transparent',
              border: 'none',
              borderBottomStyle: 'solid',
              borderBottomWidth: 1.5,
              borderBottomColor: tab === k ? 'var(--ink)' : 'transparent',
              cursor: 'pointer',
            }}
          >
            {k}
          </button>
        ))}
      </div>

      <div className="scroll" style={{ flex: 1, overflow: 'auto' }}>
        {tab === 'code' && (
          <div style={{ height: '100%', minHeight: 400 }}>
            <Editor
              height="100%"
              theme="vs-dark"
              language="python"
              value={code}
              onChange={(v) => {
                if (readOnly) return;
                setCode(v ?? '');
                setDirty(true);
              }}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
                scrollBeyondLastLine: false,
                lineNumbers: 'off',
                readOnly: !!readOnly,
              }}
            />
          </div>
        )}

        {tab === 'i/o' && (
          <div style={{ padding: 18 }}>
            <div className="smallcaps" style={{ marginBottom: 10 }}>inputs</div>
            {node.inputs.length === 0 ? (
              <div className="serif" style={{ fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 13 }}>
                no inputs.
              </div>
            ) : (
              node.inputs.map((p, i) => (
                <PortRow key={i} port={p} showRequired />
              ))
            )}

            <div className="smallcaps" style={{ marginTop: 22, marginBottom: 10 }}>outputs</div>
            {node.outputs.length === 0 ? (
              <div className="serif" style={{ fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 13 }}>
                no outputs.
              </div>
            ) : (
              node.outputs.map((p, i) => (
                <PortRow key={i} port={p} />
              ))
            )}

            <div
              className="serif"
              style={{
                marginTop: 24,
                fontStyle: 'italic',
                color: 'var(--ink-4)',
                fontSize: 12.5,
                lineHeight: 1.5,
              }}
            >
              ports are shaped by{' '}
              <span className="italic-em" style={{ color: 'var(--ink-3)' }}>
                orchestra
              </span>
              . ask in the chat to add, rename, or remove one.
            </div>
          </div>
        )}

        {tab === 'trace' && (
          <div style={{ padding: 18 }}>
            {trace ? (
              <NodeTraceCard
                workflow={workflow}
                trace={trace}
                runId={pinnedRun?.id ?? liveRunOnThisWorkflow?.id}
                onSendErrorToOrchestrator={onSendErrorToOrchestrator}
              />
            ) : (
              <div
                className="serif"
                style={{ fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 13, lineHeight: 1.55 }}
              >
                {liveRunOnThisWorkflow
                  ? 'waiting for this node to start…'
                  : 'this node has no trace in the selected run.'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PortRow({
  port, showRequired,
}: {
  port: IOPort;
  showRequired?: boolean;
}) {
  return (
    <div
      style={{
        padding: '8px 0',
        borderBottom: '1px solid var(--rule-2)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <span
        className="mono"
        style={{
          flex: 1,
          fontSize: 12,
          color: 'var(--ink-2)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={port.name}
      >
        {port.name}
      </span>
      <span
        className="serif"
        style={{
          width: 110,
          fontStyle: 'italic',
          fontSize: 12,
          color: 'var(--ink-3)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={port.type_hint}
      >
        {port.type_hint || 'any'}
      </span>
      {showRequired && (
        <span
          className="smallcaps"
          style={{
            fontSize: 9,
            color: port.required ? 'var(--accent-ink)' : 'var(--ink-4)',
          }}
        >
          {port.required ? 'required' : 'optional'}
        </span>
      )}
    </div>
  );
}


