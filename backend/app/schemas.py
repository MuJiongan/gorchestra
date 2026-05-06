from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field


class IOPort(BaseModel):
    name: str
    type_hint: str = "any"
    required: bool = True


class NodeConfig(BaseModel):
    model: str = ""


class Position(BaseModel):
    x: float = 0
    y: float = 0


DEFAULT_CODE = "def run(inputs, ctx):\n    return {}\n"


class NodeIn(BaseModel):
    name: str = "node"
    description: str = ""
    code: str = DEFAULT_CODE
    inputs: list[IOPort] = Field(default_factory=list)
    outputs: list[IOPort] = Field(default_factory=list)
    config: NodeConfig = Field(default_factory=NodeConfig)
    position: Position = Field(default_factory=Position)


class NodeOut(NodeIn):
    id: str
    workflow_id: str


class NodePatch(BaseModel):
    name: str | None = None
    description: str | None = None
    code: str | None = None
    inputs: list[IOPort] | None = None
    outputs: list[IOPort] | None = None
    config: NodeConfig | None = None
    position: Position | None = None
    mark_user_edited: bool = False


class EdgeIn(BaseModel):
    from_node_id: str
    from_output: str
    to_node_id: str
    to_input: str


class EdgeOut(EdgeIn):
    id: str
    workflow_id: str


class WorkflowIn(BaseModel):
    name: str = "Untitled"


class WorkflowOut(BaseModel):
    id: str
    name: str
    input_node_id: str | None = None
    output_node_id: str | None = None


class WorkflowDetail(WorkflowOut):
    nodes: list[NodeOut]
    edges: list[EdgeOut]


class WorkflowPatch(BaseModel):
    name: str | None = None
    input_node_id: str | None = None
    output_node_id: str | None = None


class RunStartIn(BaseModel):
    inputs: dict[str, Any] = Field(default_factory=dict)
    kind: str = "user"


class NodeRunOut(BaseModel):
    id: str
    node_id: str
    status: str
    inputs: dict[str, Any]
    outputs: dict[str, Any]
    logs: list[Any]
    llm_calls: list[Any]
    tool_calls: list[Any]
    error: str | None = None
    duration_ms: int
    cost: float


class RunOut(BaseModel):
    id: str
    workflow_id: str
    kind: str
    status: str
    inputs: dict[str, Any]
    outputs: dict[str, Any]
    error: str | None = None
    total_cost: float
    # Frozen graph the runner actually executed (nodes + code + edges + in/out
    # node ids). `None` for legacy rows created before snapshotting landed.
    workflow_snapshot: dict[str, Any] | None = None
    node_runs: list[NodeRunOut]


# --- orchestrator session schemas -----------------------------------------


class SessionOut(BaseModel):
    id: str
    workflow_id: str


class ChatToolCall(BaseModel):
    """A tool call card as rendered in the chat panel."""
    tool: str
    args: str  # human-readable summary, e.g. 'name="transcribe"'
    status: str  # "ok" | "err"
    result: Any | None = None


class ChatBlockP(BaseModel):
    t: str = "p"
    text: str


class ChatBlockTool(BaseModel):
    t: str = "tool"
    tool: str
    args: str
    status: str
    result: Any | None = None


class ChatMessageOut(BaseModel):
    """One rendered chat bubble. Either user (with text) or assistant (mixed
    content)."""
    role: str  # "user" | "assistant"
    text: str | None = None
    content: list[dict[str, Any]] | None = None  # for assistant: list of ChatBlockP / ChatBlockTool


class SessionMessagesOut(BaseModel):
    messages: list[ChatMessageOut]


class UserMessageIn(BaseModel):
    text: str
