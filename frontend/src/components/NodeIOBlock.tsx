import type { IOPort, WorkflowDetail } from '../types';
import { JsonView } from './JsonView';
import { PortRow } from './ValueViewer';

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

export function NodeIOBlock({
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
