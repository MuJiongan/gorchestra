from __future__ import annotations
import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, Float, Text, ForeignKey, JSON, DateTime
from sqlalchemy.orm import relationship

from app.db import Base


def uid() -> str:
    return uuid.uuid4().hex[:12]


class Workflow(Base):
    __tablename__ = "workflows"
    id = Column(String, primary_key=True, default=uid)
    name = Column(String, nullable=False, default="Untitled")
    created_at = Column(DateTime, default=datetime.utcnow)
    input_node_id = Column(String, nullable=True)
    output_node_id = Column(String, nullable=True)
    nodes = relationship("Node", back_populates="workflow", cascade="all, delete-orphan")
    edges = relationship("Edge", back_populates="workflow", cascade="all, delete-orphan")
    runs = relationship("Run", back_populates="workflow", cascade="all, delete-orphan")
    sessions = relationship("Session", back_populates="workflow", cascade="all, delete-orphan")


class Node(Base):
    __tablename__ = "nodes"
    id = Column(String, primary_key=True, default=uid)
    workflow_id = Column(String, ForeignKey("workflows.id"), nullable=False)
    name = Column(String, nullable=False, default="node")
    description = Column(Text, default="")
    code = Column(Text, default="def run(inputs, ctx):\n    return {}\n")
    inputs = Column(JSON, default=list)
    outputs = Column(JSON, default=list)
    config = Column(JSON, default=dict)
    position = Column(JSON, default=dict)
    user_edited_at = Column(DateTime, nullable=True)
    workflow = relationship("Workflow", back_populates="nodes")


class Edge(Base):
    __tablename__ = "edges"
    id = Column(String, primary_key=True, default=uid)
    workflow_id = Column(String, ForeignKey("workflows.id"), nullable=False)
    from_node_id = Column(String, nullable=False)
    from_output = Column(String, nullable=False)
    to_node_id = Column(String, nullable=False)
    to_input = Column(String, nullable=False)
    workflow = relationship("Workflow", back_populates="edges")


class Run(Base):
    __tablename__ = "runs"
    id = Column(String, primary_key=True, default=uid)
    workflow_id = Column(String, ForeignKey("workflows.id"), nullable=False)
    kind = Column(String, default="user")  # "user" | "test"
    status = Column(String, default="pending")  # pending|running|success|error|cancelled
    inputs = Column(JSON, default=dict)
    outputs = Column(JSON, default=dict)
    error = Column(Text, nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow)
    ended_at = Column(DateTime, nullable=True)
    total_cost = Column(Float, default=0.0)
    # Frozen at run creation: full graph (nodes + code + edges + in/out node ids)
    # the runner actually executed. Lets the canvas re-render an old run's
    # graph even after the live workflow has been mutated.
    workflow_snapshot = Column(JSON, nullable=True)
    workflow = relationship("Workflow", back_populates="runs")
    node_runs = relationship("NodeRun", back_populates="run", cascade="all, delete-orphan")


class NodeRun(Base):
    __tablename__ = "node_runs"
    id = Column(String, primary_key=True, default=uid)
    run_id = Column(String, ForeignKey("runs.id"), nullable=False)
    node_id = Column(String, nullable=False)
    status = Column(String, default="pending")
    inputs = Column(JSON, default=dict)
    outputs = Column(JSON, default=dict)
    logs = Column(JSON, default=list)
    llm_calls = Column(JSON, default=list)
    tool_calls = Column(JSON, default=list)
    error = Column(Text, nullable=True)
    duration_ms = Column(Integer, default=0)
    cost = Column(Float, default=0.0)
    run = relationship("Run", back_populates="node_runs")


class Setting(Base):
    __tablename__ = "settings"
    key = Column(String, primary_key=True)
    value = Column(Text, default="")


class Session(Base):
    """One orchestrator chat session attached to a workflow."""
    __tablename__ = "sessions"
    id = Column(String, primary_key=True, default=uid)
    workflow_id = Column(String, ForeignKey("workflows.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    workflow = relationship("Workflow", back_populates="sessions")
    messages = relationship(
        "Message",
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="Message.ts",
    )


class Message(Base):
    """A single LLM-format message: user / assistant / tool / system.

    Stored in OpenAI/OpenRouter message shape so the agent loop can replay
    history verbatim across turns.
    """
    __tablename__ = "messages"
    id = Column(String, primary_key=True, default=uid)
    session_id = Column(String, ForeignKey("sessions.id"), nullable=False)
    role = Column(String, nullable=False)  # "user" | "assistant" | "tool" | "system"
    content = Column(Text, default="")
    tool_calls = Column(JSON, default=list)  # assistant: [{id, type, function:{name, arguments}}]
    tool_call_id = Column(String, nullable=True)  # tool role: which call this is a result for
    name = Column(String, nullable=True)  # tool role: tool name
    # Anthropic extended-thinking blocks. We must echo these back unmodified
    # in the assistant message on the next turn for tool-calling to stay
    # valid (OpenRouter / Anthropic enforce ordering).
    reasoning_details = Column(JSON, default=list)
    ts = Column(DateTime, default=datetime.utcnow)
    session = relationship("Session", back_populates="messages")
