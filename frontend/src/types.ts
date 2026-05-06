export interface IOPort {
  name: string;
  type_hint: string;
  required: boolean;
}

export interface NodeConfig {
  model: string;
}

export interface WFNode {
  id: string;
  workflow_id: string;
  name: string;
  description: string;
  code: string;
  inputs: IOPort[];
  outputs: IOPort[];
  config: NodeConfig;
  position: { x: number; y: number };
}

export interface WFEdge {
  id: string;
  workflow_id: string;
  from_node_id: string;
  from_output: string;
  to_node_id: string;
  to_input: string;
}

export interface Workflow {
  id: string;
  name: string;
  input_node_id: string | null;
  output_node_id: string | null;
}

export interface WorkflowDetail extends Workflow {
  nodes: WFNode[];
  edges: WFEdge[];
}

export type RunStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled';
export type NodeRunStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

export interface NodeRun {
  id: string;
  node_id: string;
  status: NodeRunStatus;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  logs: unknown[];
  llm_calls: unknown[];
  tool_calls: unknown[];
  error: string | null;
  duration_ms: number;
  cost: number;
}

export interface RunWorkflowSnapshotNode {
  id: string;
  name: string;
  description?: string;
  code: string;
  inputs: IOPort[];
  outputs: IOPort[];
  config: NodeConfig;
  position?: { x: number; y: number };
}

export interface RunWorkflowSnapshotEdge {
  id: string;
  from_node_id: string;
  from_output: string;
  to_node_id: string;
  to_input: string;
}

export interface RunWorkflowSnapshot {
  id: string;
  input_node_id: string | null;
  output_node_id: string | null;
  nodes: RunWorkflowSnapshotNode[];
  edges: RunWorkflowSnapshotEdge[];
}

export interface Run {
  id: string;
  workflow_id: string;
  kind: string;
  status: RunStatus;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  error: string | null;
  total_cost: number;
  workflow_snapshot: RunWorkflowSnapshot | null;
  node_runs: NodeRun[];
}

export interface Settings {
  openrouter_api_key: string;
  parallel_api_key: string;
  default_orchestrator_model: string;
  default_node_model: string;
}

// --- streaming run events --------------------------------------------------

export type ToolVia = 'direct' | 'llm';

export type LLMChunkKind = 'content' | 'reasoning' | 'tool_args';

export type RunEvent =
  | { type: 'run_started'; node_count: number; order: string[] }
  | { type: 'node_started'; node_id: string; inputs: Record<string, unknown> }
  | { type: 'log'; node_id: string; msg: string }
  | {
      type: 'llm_call_started';
      node_id: string;
      call_id: string;
      model: string;
      tools: string[];
    }
  | {
      type: 'llm_round_started';
      node_id: string;
      call_id: string;
      round: number;
    }
  | {
      type: 'llm_call_chunk';
      node_id: string;
      call_id: string;
      kind: LLMChunkKind;
      round: number;
      delta: string;
      tc_index?: number;
      tool?: string;
    }
  | {
      type: 'llm_call_finished';
      node_id: string;
      call_id: string;
      model: string;
      content: string;
      usage: Record<string, unknown>;
      cost: number;
      error?: string;
    }
  | {
      type: 'tool_call_started';
      node_id: string;
      tool: string;
      args: Record<string, unknown>;
      via: ToolVia;
      call_id?: string;
      tc_index?: number;
      round?: number;
    }
  | {
      type: 'tool_call_finished';
      node_id: string;
      tool: string;
      args: Record<string, unknown>;
      result?: unknown;
      error?: string;
      via: ToolVia;
      call_id?: string;
      tc_index?: number;
      round?: number;
    }
  | {
      type: 'node_finished';
      node_id: string;
      status: NodeRunStatus;
      inputs: Record<string, unknown>;
      outputs: Record<string, unknown>;
      logs: string[];
      llm_calls: unknown[];
      tool_calls: unknown[];
      error: string | null;
      duration_ms: number;
      cost: number;
    }
  | {
      type: 'run_finished';
      status: RunStatus;
      outputs: Record<string, unknown>;
      error: string | null;
      total_cost: number;
    };

export interface CurrentRun {
  id: string;
  workflow_id: string;
  status: RunStatus;
  startedAt: number;
  events: RunEvent[];
  nodeStates: Record<string, NodeRunStatus>;
  finalOutputs: Record<string, unknown> | null;
  error: string | null;
  totalCost: number;
  // Frozen graph this run is/was executing against. The canvas always
  // renders this (not the live `detail`) for the run's full lifetime —
  // running and post-completion alike — so the live canvas stays
  // unambiguously editable and the running canvas stays unambiguously
  // frozen. The user explicitly leaves via the in-flight banner's exit
  // (which nulls this field). May also be null briefly while we async-fetch
  // it after attaching by run_id alone (the orchestrator-triggered path).
  snapshot: RunWorkflowSnapshot | null;
}

// --- orchestrator chat session --------------------------------------------

export interface OrchestratorSession {
  id: string;
  workflow_id: string;
}

export interface ChatBlockP {
  t: 'p';
  text: string;
}

export interface ChatBlockTool {
  t: 'tool';
  tool: string;
  args: string;
  status: 'pending' | 'ok' | 'err';
  result?: unknown;
}

/** Extended-thinking trace from the model. Renders as a collapsible block. */
export interface ChatBlockThinking {
  t: 'thinking';
  text: string;
}

export type ChatBlock = ChatBlockP | ChatBlockTool | ChatBlockThinking;

export interface ChatHistoryUser {
  role: 'user';
  text: string;
  content?: null;
}

export interface ChatHistoryAssistant {
  role: 'assistant';
  text?: null;
  content: ChatBlock[];
}

export type ChatHistoryMessage = ChatHistoryUser | ChatHistoryAssistant;

export interface ChatHistory {
  messages: ChatHistoryMessage[];
}

export type OrchestratorEvent =
  | { kind: 'user_message'; id: string; text: string }
  // assistant_text fires once per LLM round with the full text — kept for
  // backwards compat with non-streaming clients (currently unused by App).
  | { kind: 'assistant_text'; text: string }
  // assistant_text_chunk fires for each token delta during a round.
  | { kind: 'assistant_text_chunk'; text: string }
  // assistant_thinking_chunk fires for each reasoning-token delta during a round.
  | { kind: 'assistant_thinking_chunk'; text: string }
  | {
      kind: 'tool_call_start';
      tool: string;
      args: string;
      args_full?: Record<string, unknown>;
    }
  | {
      kind: 'tool_call_end';
      tool: string;
      args: string;
      status: 'ok' | 'err';
      result?: unknown;
    }
  // Emitted by the agent loop when the orchestrator's `run_workflow` tool
  // kicks off a run. The frontend attaches the run panel to the run's WS
  // (same code path the manual Run button uses), so the user sees live
  // progress while the orchestrator awaits the result.
  | { kind: 'run_started'; run_id: string; workflow_id: string }
  | { kind: 'error'; message: string }
  | { kind: 'done' };
