import { useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { WFNode, IOPort, WorkflowDetail, Run, NodeRun, NodeRunStatus } from '../types';
import { api } from '../api';
import { NodeIOBlock } from './NodeIOBlock';
import { ValueRow } from './ValueViewer';

const NODE_RUN_STATE_CLASS: Record<NodeRunStatus, string> = {
  pending: 'idle',
  running: 'running',
  success: 'success',
  error: 'error',
  skipped: 'skipped',
};

interface Props {
  node: WFNode;
  workflow: WorkflowDetail;
  onClose: () => void;
  onChange: () => void;
}

type Tab = 'code' | 'i/o' | 'last run';

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
export function NodePanel({ node, workflow, onClose, onChange }: Props) {
  const [tab, setTab] = useState<Tab>('code');
  const [code, setCode] = useState(node.code);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setCode(node.code);
    setDirty(false);
    setTab('code');
  }, [node.id]);

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
          {dirty && (
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
        {(['code', 'i/o', 'last run'] as const).map((k) => (
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
              onChange={(v) => { setCode(v ?? ''); setDirty(true); }}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
                scrollBeyondLastLine: false,
                lineNumbers: 'off',
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

        {tab === 'last run' && <LastRunsTab nodeId={node.id} workflow={workflow} />}
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

interface NodeRunEntry {
  run: Run;
  nodeRun: NodeRun;
}

function LastRunsTab({ nodeId, workflow }: { nodeId: string; workflow: WorkflowDetail }) {
  const workflowId = workflow.id;
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  // Tracks whether we've already auto-opened the most-recent run for this
  // node selection. Without this, an effect that auto-opens whenever
  // `openRunId === null` would immediately re-open a run the user just
  // collapsed, making the row feel uncloseable.
  const [autoOpened, setAutoOpened] = useState(false);

  const refresh = async () => {
    try {
      const list = await api.listRuns(workflowId);
      setRuns(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    setRuns(null);
    setOpenRunId(null);
    setAutoOpened(false);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, workflowId]);

  // Filter to runs that actually touched this node, most recent first (the
  // listRuns endpoint already orders by started_at desc).
  const entries: NodeRunEntry[] = useMemo(() => {
    if (!runs) return [];
    const out: NodeRunEntry[] = [];
    for (const r of runs) {
      const nr = r.node_runs.find((x) => x.node_id === nodeId);
      if (nr) out.push({ run: r, nodeRun: nr });
    }
    return out;
  }, [runs, nodeId]);

  // Auto-open the most recent entry once, on first load. After that the
  // user owns the open/closed state — collapsing a row stays collapsed.
  useEffect(() => {
    if (!autoOpened && entries.length > 0) {
      setOpenRunId(entries[0].run.id);
      setAutoOpened(true);
    }
  }, [entries, autoOpened]);

  if (runs === null && !error) {
    return (
      <div
        className="serif"
        style={{ padding: 22, fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 13 }}
      >
        loading…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 22 }}>
        <div className="smallcaps" style={{ color: 'var(--state-err)', marginBottom: 6 }}>
          × failed to load runs
        </div>
        <pre className="mono" style={{ fontSize: 11, color: 'var(--state-err)', whiteSpace: 'pre-wrap', margin: 0 }}>
          {error}
        </pre>
        <button onClick={refresh} className="btn-ghost" style={{ marginTop: 12, padding: '4px 10px', fontSize: 11 }}>
          retry
        </button>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div
        className="serif"
        style={{ padding: 22, fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 13, lineHeight: 1.55 }}
      >
        no runs yet for this node. run the workflow and the per-node trace will land here.
      </div>
    );
  }

  return (
    <div style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 10 }}>
        <span className="smallcaps">runs</span>
        <span
          className="serif"
          style={{
            fontStyle: 'italic',
            fontSize: 12,
            color: 'var(--ink-4)',
            marginLeft: 8,
          }}
        >
          {entries.length} {entries.length === 1 ? 'pass' : 'passes'} · most recent first
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={refresh}
          className="btn-ghost"
          style={{ padding: '3px 9px', fontSize: 11 }}
          title="refetch runs"
        >
          refresh
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {entries.map(({ run, nodeRun }) => (
          <NodeRunCard
            key={run.id}
            workflow={workflow}
            run={run}
            nodeRun={nodeRun}
            open={openRunId === run.id}
            onToggle={() =>
              setOpenRunId((cur) => (cur === run.id ? null : run.id))
            }
          />
        ))}
      </div>
    </div>
  );
}

function NodeRunCard({
  workflow,
  run,
  nodeRun,
  open,
  onToggle,
}: {
  workflow: WorkflowDetail;
  run: Run;
  nodeRun: NodeRun;
  open: boolean;
  onToggle: () => void;
}) {
  const nodeName =
    workflow.nodes.find((n) => n.id === nodeRun.node_id)?.name ?? nodeRun.node_id;
  return (
    <div
      style={{
        border: '1px solid var(--rule)',
        borderRadius: 3,
        background: 'var(--paper)',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          padding: '8px 12px',
          background: 'transparent',
          border: 0,
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          cursor: 'pointer',
          textAlign: 'left',
          color: 'var(--ink-2)',
        }}
      >
        <span className={`node-state-dot ${NODE_RUN_STATE_CLASS[nodeRun.status]}`} />
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink)' }}>
          {run.id.slice(0, 8)}
        </span>
        <span
          className="serif"
          style={{ fontStyle: 'italic', fontSize: 12, color: 'var(--ink-4)' }}
        >
          {run.kind}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="smallcaps"
          style={{
            fontSize: 9,
            color:
              nodeRun.status === 'success'
                ? 'var(--state-ok)'
                : nodeRun.status === 'error'
                  ? 'var(--state-err)'
                  : nodeRun.status === 'skipped'
                    ? 'var(--ink-4)'
                    : 'var(--ink-3)',
          }}
        >
          {nodeRun.status}
          {typeof nodeRun.duration_ms === 'number' ? ` · ${nodeRun.duration_ms}ms` : ''}
          {typeof nodeRun.cost === 'number' && nodeRun.cost > 0
            ? ` · $${nodeRun.cost.toFixed(4)}`
            : ''}
        </span>
        <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-4)' }}>
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div
          className="fade-in"
          style={{
            padding: '8px 12px 12px',
            borderTop: '1px solid var(--rule-2)',
          }}
        >
          {nodeRun.error && (
            <pre
              className="mono"
              style={{
                fontSize: 11,
                color: 'var(--state-err)',
                whiteSpace: 'pre-wrap',
                margin: '0 0 8px',
              }}
            >
              {nodeRun.error}
            </pre>
          )}
          <NodeIOBlock
            workflow={workflow}
            nodeId={nodeRun.node_id}
            nodeName={nodeName}
            inputs={nodeRun.inputs}
            outputs={nodeRun.outputs}
            logs={nodeRun.logs.length ? nodeRun.logs : undefined}
          />
          {nodeRun.llm_calls.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div className="smallcaps" style={{ marginBottom: 4 }}>llm calls</div>
              <ValueRow
                label={`${nodeRun.llm_calls.length} ${nodeRun.llm_calls.length === 1 ? 'call' : 'calls'}`}
                value={nodeRun.llm_calls}
                viewerTitle={`${nodeName} · llm calls`}
              />
            </div>
          )}
          {nodeRun.tool_calls.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div className="smallcaps" style={{ marginBottom: 4 }}>tool calls</div>
              <ValueRow
                label={`${nodeRun.tool_calls.length} ${nodeRun.tool_calls.length === 1 ? 'call' : 'calls'}`}
                value={nodeRun.tool_calls}
                viewerTitle={`${nodeName} · tool calls`}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}


