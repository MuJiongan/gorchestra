import { useCallback, useMemo } from 'react';
import {
  ReactFlow, ReactFlowProvider, Controls,
  Handle, Position,
  type Node as RFNode, type Edge as RFEdge,
  type NodeChange, type NodeProps,
} from '@xyflow/react';
import type { WorkflowDetail, IOPort, NodeRunStatus } from '../types';
import { api } from '../api';

interface CanvasProps {
  detail: WorkflowDetail;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  // Position drags still update the backend; topology mutations (add/remove
  // nodes, edges) are owned exclusively by the orchestrator, so we no longer
  // need an `onChange` for those callbacks.
  nodeStates?: Record<string, NodeRunStatus>;
}

type DotState = 'idle' | 'running' | 'success' | 'error' | 'skipped';

interface NodeData {
  label: string;
  description: string;
  inputs: IOPort[];
  outputs: IOPort[];
  isInput: boolean;
  isOutput: boolean;
  selected: boolean;
  tools: string[];
  state: DotState;
  [key: string]: unknown;
}

function StateDot({ state = 'idle' }: { state?: string }) {
  return <span className={`node-state-dot ${state}`} aria-hidden="true" />;
}

const NODE_W = 240;

function NodeBlock({ data, selected }: NodeProps) {
  const d = data as NodeData;
  const ins = d.inputs || [];
  const outs = d.outputs || [];
  const role = d.isInput ? 'input' : d.isOutput ? 'output' : null;
  const portRowCount = Math.max(ins.length, outs.length);

  return (
    <div
      className={`node ${selected || d.selected ? 'selected' : ''}`}
      style={{
        position: 'relative',
        width: NODE_W,
      }}
    >
      {/* header — name on its own line so a long name doesn't push the role
          badge or tools row out of the card. */}
      <div
        style={{
          padding: '10px 14px 8px',
          borderBottom: '1px solid var(--rule-2)',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <StateDot state={d.state} />
          <span
            className="mono"
            title={d.label}
            style={{
              color: 'var(--ink)',
              fontSize: 12,
              fontWeight: 500,
              flex: '1 1 auto',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {d.label}
          </span>
          {role && (
            <span
              style={{
                fontFamily: 'var(--serif)',
                fontStyle: 'italic',
                fontSize: 11,
                color: 'var(--accent-ink)',
                letterSpacing: '0.02em',
                flex: 'none',
              }}
            >
              · {role}
            </span>
          )}
        </div>
        {d.tools && d.tools.length > 0 && (
          <div
            className="smallcaps"
            title={d.tools.join(' · ')}
            style={{
              fontSize: 9,
              color: 'var(--ink-4)',
              marginTop: 4,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {d.tools.join(' · ')}
          </div>
        )}
      </div>

      {/* description */}
      {d.description && (
        <div
          style={{
            padding: '6px 14px 8px',
            fontFamily: 'var(--serif)',
            fontStyle: 'italic',
            fontSize: 12.5,
            color: 'var(--ink-3)',
            lineHeight: 1.4,
          }}
        >
          {d.description}
        </div>
      )}

      {/* ports — paired rows, one per (input, output) by index. each side
          gets equal share with ellipsis on long names. */}
      {portRowCount > 0 && (
        <div style={{ padding: '6px 14px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {Array.from({ length: portRowCount }).map((_, i) => {
            const inp = ins[i];
            const out = outs[i];
            return (
              <div
                key={i}
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 10.5,
                  fontFamily: 'var(--mono)',
                  minHeight: 14,
                }}
              >
                {/* left side: input port (or empty placeholder) */}
                {inp ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      flex: '1 1 0',
                      minWidth: 0,
                    }}
                  >
                    <Handle
                      type="target"
                      position={Position.Left}
                      id={inp.name}
                      style={{
                        top: '50%',
                        left: -19,
                        transform: 'translateY(-50%)',
                        position: 'absolute',
                      }}
                    />
                    <span
                      title={inp.name}
                      style={{
                        color: inp.required ? 'var(--ink-2)' : 'var(--ink-4)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                      }}
                    >
                      {inp.name}
                    </span>
                    {!inp.required && (
                      <span className="smallcaps" style={{ fontSize: 8.5, flex: 'none' }}>
                        opt
                      </span>
                    )}
                  </div>
                ) : (
                  <div style={{ flex: '1 1 0', minWidth: 0 }} />
                )}

                {/* right side: output port (or empty) */}
                {out ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      flex: '1 1 0',
                      minWidth: 0,
                      justifyContent: 'flex-end',
                    }}
                  >
                    <span
                      title={out.name}
                      style={{
                        color: 'var(--ink-2)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                        textAlign: 'right',
                      }}
                    >
                      {out.name}
                    </span>
                    <Handle
                      type="source"
                      position={Position.Right}
                      id={out.name}
                      style={{
                        top: '50%',
                        right: -19,
                        left: 'auto',
                        transform: 'translateY(-50%)',
                        position: 'absolute',
                      }}
                    />
                  </div>
                ) : (
                  <div style={{ flex: '1 1 0' }} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { wfNode: NodeBlock };

function CanvasLegend() {
  const items = [
    { k: 'idle', s: 'idle' },
    { k: 'running', s: 'running' },
    { k: 'success', s: 'success' },
    { k: 'skipped', s: 'skipped' },
  ];
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
      {items.map((i) => (
        <span
          key={i.k}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 10.5,
            color: 'var(--ink-4)',
            fontFamily: 'var(--mono)',
          }}
        >
          <span className={`node-state-dot ${i.s}`} /> {i.k}
        </span>
      ))}
    </div>
  );
}

function CanvasInner({ detail, selectedNodeId, onSelectNode, nodeStates }: CanvasProps) {
  const states = nodeStates ?? {};
  const rfNodes: RFNode[] = useMemo(
    () =>
      detail.nodes.map((n) => {
        const raw = states[n.id];
        const state: DotState =
          raw === 'running' || raw === 'success' || raw === 'error' || raw === 'skipped'
            ? raw
            : 'idle';
        return {
          id: n.id,
          type: 'wfNode',
          position: n.position ?? { x: 0, y: 0 },
          data: {
            label: n.name,
            description: n.description,
            inputs: n.inputs,
            outputs: n.outputs,
            isInput: n.id === detail.input_node_id,
            isOutput: n.id === detail.output_node_id,
            selected: n.id === selectedNodeId,
            tools: n.config.tools_enabled ?? [],
            state,
          } satisfies NodeData,
        };
      }),
    [detail, selectedNodeId, states],
  );

  const rfEdges: RFEdge[] = useMemo(
    () =>
      detail.edges.map((e) => {
        const sourceState = states[e.from_node_id];
        const targetState = states[e.to_node_id];
        const skipped = sourceState === 'skipped' || targetState === 'skipped';
        const flowing = sourceState === 'running' || (sourceState === 'success' && targetState === 'running');
        const className = skipped
          ? 'edge-path skipped'
          : flowing
            ? 'edge-path flowing'
            : 'edge-path';
        return {
          id: e.id,
          source: e.from_node_id,
          target: e.to_node_id,
          sourceHandle: e.from_output,
          targetHandle: e.to_input,
          type: 'smoothstep',
          className,
        };
      }),
    [detail.edges, states],
  );

  // Position drags (the only user-driven graph mutation we still allow) are
  // persisted so the orchestrator's auto-layout is overridable. Topology —
  // adding / removing nodes and edges — is owned by the orchestrator.
  const onNodesChange = useCallback(async (changes: NodeChange[]) => {
    for (const c of changes) {
      if (c.type === 'position' && c.dragging === false && c.position) {
        try { await api.patchNode(c.id, { position: c.position }); } catch { /* ignore */ }
      }
    }
  }, []);

  const onNodeClick = useCallback((_: unknown, n: RFNode) => onSelectNode(n.id), [onSelectNode]);
  const onPaneClick = useCallback(() => onSelectNode(null), [onSelectNode]);

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '10px 22px 8px',
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          borderBottom: '1px solid var(--rule)',
          background: 'var(--paper)',
        }}
      >
        <span className="smallcaps">canvas</span>
        <span
          className="serif"
          style={{
            fontStyle: 'italic',
            fontSize: 13,
            color: 'var(--ink-3)',
            marginLeft: 6,
          }}
        >
          — the graph as it stands.
        </span>
        <span style={{ flex: 1 }} />
        <CanvasLegend />
      </div>
      <div style={{ flex: 1, position: 'relative' }} className="dotgrid">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          // Topology is read-only from the user's side — only the orchestrator
          // adds or removes nodes / edges. Position drags still work.
          nodesConnectable={false}
          edgesFocusable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Controls showInteractive={false} />
        </ReactFlow>
        {detail.nodes.length === 0 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ink-4)',
              gap: 14,
              pointerEvents: 'none',
            }}
          >
            <div className="serif" style={{ fontStyle: 'italic', fontSize: 22, color: 'var(--ink-3)' }}>
              an empty canvas.
            </div>
            <div
              style={{ fontSize: 12.5, maxWidth: 320, textAlign: 'center', lineHeight: 1.6 }}
            >
              describe a problem to{' '}
              <span className="italic-em">orchestra</span>; she'll wire the nodes for you.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
