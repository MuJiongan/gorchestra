import { Fragment, useCallback, useMemo, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Controls,
  Handle, Position,
  type Node as RFNode, type Edge as RFEdge,
  type NodeProps,
} from '@xyflow/react';
import type { WorkflowDetail, IOPort, NodeRunStatus } from '../types';

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

// Port section — handles attach to the card's top/bottom edge. Labels are
// rendered as absolutely-positioned tooltips next to each dot and only fade
// in on hover, so they don't reserve any space in the card layout.
function PortSection({
  ports,
  side,
}: {
  ports: IOPort[];
  side: 'top' | 'bottom';
}) {
  if (ports.length === 0) return null;
  const isTop = side === 'top';
  const [hovered, setHovered] = useState<string | null>(null);
  return (
    <Fragment>
      {ports.map((p, i) => {
        const xPct = ((i + 0.5) / ports.length) * 100;
        const dim = isTop && !p.required;
        const visible = hovered === p.name;
        return (
          <Fragment key={p.name}>
            <Handle
              type={isTop ? 'target' : 'source'}
              position={isTop ? Position.Top : Position.Bottom}
              id={p.name}
              onMouseEnter={() => setHovered(p.name)}
              onMouseLeave={() => setHovered((h) => (h === p.name ? null : h))}
              style={{
                [isTop ? 'top' : 'bottom']: -5,
                left: `${xPct}%`,
                transform: 'translateX(-50%)',
                position: 'absolute',
              }}
            />
            <div
              title={dim ? `${p.name} (optional)` : p.name}
              style={{
                position: 'absolute',
                [isTop ? 'bottom' : 'top']: 'calc(100% + 6px)',
                left: `${xPct}%`,
                transform: 'translateX(-50%)',
                fontFamily: 'var(--mono)',
                fontSize: 10.5,
                color: dim ? 'var(--ink-4)' : 'var(--ink-3)',
                lineHeight: 1.5,
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                opacity: visible ? 1 : 0,
                transition: 'opacity .15s',
                zIndex: 10,
              }}
            >
              {p.name}
            </div>
          </Fragment>
        );
      })}
    </Fragment>
  );
}

function NodeBlock({ data, selected }: NodeProps) {
  const d = data as NodeData;
  const ins = d.inputs || [];
  const outs = d.outputs || [];
  const role = d.isInput ? 'input' : d.isOutput ? 'output' : null;

  return (
    <div
      className={`node ${selected || d.selected ? 'selected' : ''}`}
      style={{
        position: 'relative',
        width: NODE_W,
      }}
    >
      {/* inputs — handles on the top edge, labels listed inside the card. */}
      <PortSection ports={ins} side="top" />

      {/* header — name on its own line so a long name doesn't push the role
          badge or tools row out of the card. */}
      <div
        style={{
          padding: '10px 14px 8px',
          borderBottom: d.description ? '1px solid var(--rule-2)' : undefined,
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
            padding: '6px 14px 10px',
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

      {/* outputs — handles on the bottom edge, labels listed inside the card. */}
      <PortSection ports={outs} side="bottom" />
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

// Vertical layered layout — input nodes at the top, flow downward by edge depth.
// Within each layer, ordering is decided by the Sugiyama barycenter heuristic
// for crossing reduction: each node's column is the average column of its
// neighbors in the adjacent layer, sorted, sweeping down then up until stable.
// This is the standard layered-graph algorithm (what dagre / Graphviz do) and
// produces a layout that follows the data flow and minimizes edge crossings.
// Approximate the rendered height of a node card from its content. Mirrors
// the paddings / line-heights / port row sizes in <NodeBlock>. Used so the
// vertical layout can space each layer below the *bottom* of the layer above
// — a fixed Y_GAP would let tall nodes (long descriptions, many ports)
// overlap into the next layer.
function estimateNodeHeight(n: WorkflowDetail['nodes'][number]): number {
  let h = 0;
  // Inputs section: padding 8/14/0 + N rows at line-height 1.5 * 10.5 ≈ 16px.
  if (n.inputs.length > 0) h += 8 + n.inputs.length * 16;
  // Header: padding 10/14/8 + name line at fontSize 12 (~16px line box).
  h += 10 + 16 + 8;
  if (n.config?.tools_enabled?.length) {
    h += 4 /* marginTop */ + 11 /* tools row line box */;
  }
  if (n.description) {
    h += 1; // header bottom border (only present when description follows)
    // Description block: padding 6/14/10, fontSize 12.5, lineHeight 1.4.
    // Width inside padding ≈ 240 - 14*2 = 212px; serif italic averages
    // ~6.5 px/char, so ~32 chars per line is a reasonable estimate.
    const charsPerLine = 32;
    const lines = Math.max(1, Math.ceil(n.description.length / charsPerLine));
    h += 6 + lines * Math.ceil(12.5 * 1.4) + 10;
  }
  // Outputs section: N rows + bottom padding 10.
  if (n.outputs.length > 0) h += n.outputs.length * 16 + 10;
  return Math.ceil(h);
}

function computeVerticalLayout(
  nodes: WorkflowDetail['nodes'],
  edges: WorkflowDetail['edges'],
): Record<string, { x: number; y: number }> {
  const X_GAP = 280;
  const ROW_GAP = 70; // visual gap between a layer's bottom and the next layer's top

  const incoming: Record<string, string[]> = {};
  const outgoing: Record<string, string[]> = {};
  for (const n of nodes) {
    incoming[n.id] = [];
    outgoing[n.id] = [];
  }
  for (const e of edges) {
    if (incoming[e.to_node_id]) incoming[e.to_node_id].push(e.from_node_id);
    if (outgoing[e.from_node_id]) outgoing[e.from_node_id].push(e.to_node_id);
  }

  // Orphan-aware fast path: while the orchestrator is still adding nodes and
  // hasn't drawn any edges yet, stack the nodes vertically (one per row, in
  // insertion order) instead of cramming them into a single horizontal row.
  // Once any edge exists, we fall through to the layered + barycenter path.
  if (edges.length === 0) {
    const out: Record<string, { x: number; y: number }> = {};
    let y = 0;
    nodes.forEach((n) => {
      out[n.id] = { x: 0, y };
      y += estimateNodeHeight(n) + ROW_GAP;
    });
    return out;
  }

  // Layer assignment: longest path from any source.
  const depth: Record<string, number> = {};
  const visiting = new Set<string>();
  const getDepth = (id: string): number => {
    if (depth[id] !== undefined) return depth[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const p of incoming[id] ?? []) d = Math.max(d, getDepth(p) + 1);
    visiting.delete(id);
    depth[id] = d;
    return d;
  };
  for (const n of nodes) getDepth(n.id);

  const maxDepth = nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => depth[n.id]));
  const layerOrder: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const n of nodes) layerOrder[depth[n.id]].push(n.id);

  // Initial intra-layer order: alphabetical, just so the starting state is
  // stable across renders.
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name ?? id;
  for (const layer of layerOrder) layer.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

  // Barycenter sweep — for each layer, reorder by the mean index of its
  // neighbors in the adjacent layer. Down-sweep uses predecessors, up-sweep
  // uses successors. Iterate until ordering is stable (or 24 sweeps, whichever
  // first — typical convergence is 2–6 sweeps).
  const orderKey = () => layerOrder.map((l) => l.join(',')).join('|');
  const buildIndexMap = () => {
    const m: Record<number, Map<string, number>> = {};
    layerOrder.forEach((layer, d) => {
      const map = new Map<string, number>();
      layer.forEach((id, i) => map.set(id, i));
      m[d] = map;
    });
    return m;
  };
  const reorderLayer = (
    layerIdx: number,
    neighborsOf: (id: string) => string[],
    neighborLayerIdx: number,
    idxByLayer: Record<number, Map<string, number>>,
  ) => {
    const layer = layerOrder[layerIdx];
    const bc = new Map<string, number>();
    layer.forEach((id, i) => {
      const nbs = neighborsOf(id).filter((nb) => depth[nb] === neighborLayerIdx);
      if (nbs.length === 0) {
        bc.set(id, i); // no neighbors in target layer — keep current spot
        return;
      }
      const sum = nbs.reduce((acc, nb) => acc + (idxByLayer[neighborLayerIdx].get(nb) ?? 0), 0);
      bc.set(id, sum / nbs.length);
    });
    // Stable sort: ties keep insertion order (ES2019+).
    layer.sort((a, b) => (bc.get(a) ?? 0) - (bc.get(b) ?? 0));
  };

  for (let sweep = 0; sweep < 24; sweep++) {
    const before = orderKey();
    let idx = buildIndexMap();
    for (let d = 1; d <= maxDepth; d++) {
      reorderLayer(d, (id) => incoming[id], d - 1, idx);
      idx = buildIndexMap();
    }
    for (let d = maxDepth - 1; d >= 0; d--) {
      reorderLayer(d, (id) => outgoing[id], d + 1, idx);
      idx = buildIndexMap();
    }
    if (orderKey() === before) break;
  }

  // Per-layer y is anchored to the bottom of the layer above + ROW_GAP, using
  // each layer's tallest node so nothing overlaps even when one row mixes
  // short and tall cards.
  const heightOf = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return n ? estimateNodeHeight(n) : 0;
  };
  const layerHeights = layerOrder.map((layer) =>
    layer.length === 0 ? 0 : Math.max(...layer.map(heightOf)),
  );
  const layerY: number[] = [0];
  for (let d = 1; d <= maxDepth; d++) {
    layerY[d] = layerY[d - 1] + layerHeights[d - 1] + ROW_GAP;
  }

  const out: Record<string, { x: number; y: number }> = {};
  layerOrder.forEach((layer, d) => {
    layer.forEach((id, i) => {
      out[id] = { x: (i - (layer.length - 1) / 2) * X_GAP, y: layerY[d] };
    });
  });
  return out;
}

function CanvasInner({ detail, selectedNodeId, onSelectNode, nodeStates }: CanvasProps) {
  const states = nodeStates ?? {};
  const positions = useMemo(
    () => computeVerticalLayout(detail.nodes, detail.edges),
    [detail.nodes, detail.edges],
  );
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
          position: positions[n.id] ?? { x: 0, y: 0 },
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
    [detail, selectedNodeId, states, positions],
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

  // Topology and positions are both orchestrator-owned now — the canvas auto-
  // layouts vertically (input nodes top, flowing down), so user drags would
  // just snap back. Drags are disabled below via `nodesDraggable={false}`.
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
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          // Topology and layout are orchestrator-owned. Canvas auto-layouts
          // top-to-bottom so drags would snap back — disable them.
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 0.8, minZoom: 0.3 }}
          minZoom={0.2}
          maxZoom={1.2}
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
