import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { api } from '../api';
import type { Run } from '../types';

export type ChatToolStatus = 'pending' | 'ok' | 'err';

// Markdown components — keeps assistant prose inside the paper-and-ink palette
// instead of inheriting browser defaults (giant h1s, bold serifs etc.).
const MD_COMPONENTS: Components = {
  p: ({ children }) => <p style={{ margin: '0 0 10px' }}>{children}</p>,
  strong: ({ children }) => (
    <strong style={{ color: 'var(--ink)', fontWeight: 500 }}>{children}</strong>
  ),
  em: ({ children }) => (
    <em style={{ fontStyle: 'italic', color: 'var(--ink)' }}>{children}</em>
  ),
  del: ({ children }) => (
    <del style={{ color: 'var(--ink-4)' }}>{children}</del>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{ color: 'var(--accent-ink)', textDecoration: 'underline' }}
    >
      {children}
    </a>
  ),
  code: ({ children, ...props }) => (
    <code
      {...props}
      style={{
        fontFamily: 'var(--mono)',
        fontSize: '0.86em',
        background: 'rgba(26, 23, 20, 0.06)',
        padding: '0.1em 0.4em',
        borderRadius: 2,
      }}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre
      style={{
        margin: '8px 0 12px',
        padding: 10,
        background: 'var(--paper-2)',
        border: '1px solid var(--rule)',
        borderRadius: 3,
        overflow: 'auto',
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: 'pre',
      }}
    >
      {children}
    </pre>
  ),
  ul: ({ children }) => (
    <ul
      style={{
        margin: '0 0 10px',
        paddingLeft: 22,
        listStyleType: 'disc',
        listStylePosition: 'outside',
      }}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol
      style={{
        margin: '0 0 10px',
        paddingLeft: 22,
        listStyleType: 'decimal',
        listStylePosition: 'outside',
      }}
    >
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li style={{ marginBottom: 3, paddingLeft: 2 }}>{children}</li>
  ),
  h1: ({ children }) => (
    <h1
      className="serif"
      style={{
        fontStyle: 'italic',
        fontSize: 22,
        fontWeight: 400,
        margin: '12px 0 6px',
        color: 'var(--ink)',
        letterSpacing: '-0.005em',
      }}
    >
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2
      className="serif"
      style={{
        fontStyle: 'italic',
        fontSize: 18,
        fontWeight: 400,
        margin: '10px 0 5px',
        color: 'var(--ink)',
      }}
    >
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3
      className="serif"
      style={{
        fontStyle: 'italic',
        fontSize: 16,
        fontWeight: 500,
        margin: '8px 0 4px',
        color: 'var(--ink)',
      }}
    >
      {children}
    </h3>
  ),
  blockquote: ({ children }) => (
    <blockquote
      style={{
        margin: '0 0 10px',
        paddingLeft: 12,
        borderLeft: '2px solid var(--rule)',
        color: 'var(--ink-3)',
        fontStyle: 'italic',
      }}
    >
      {children}
    </blockquote>
  ),
  hr: () => (
    <hr
      style={{
        border: 0,
        borderTop: '1px solid var(--rule)',
        margin: '14px 0',
      }}
    />
  ),
  table: ({ children }) => (
    <table
      style={{
        borderCollapse: 'collapse',
        margin: '8px 0 12px',
        fontSize: 12.5,
        fontFamily: 'var(--sans)',
      }}
    >
      {children}
    </table>
  ),
  th: ({ children, style }) => (
    <th
      style={{
        ...style,
        borderBottom: '1px solid var(--rule)',
        padding: '4px 8px',
        textAlign: 'left',
        color: 'var(--ink)',
      }}
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td
      style={{
        ...style,
        borderBottom: '1px solid var(--rule-2)',
        padding: '4px 8px',
      }}
    >
      {children}
    </td>
  ),
};

export interface ChatToolCall {
  t: 'tool';
  tool: string;
  args: string;
  status: ChatToolStatus;
  /** Tool result payload — `run_workflow` and a few others stash structured
   * data here so the panel can render rich cards. Untyped on purpose; each
   * card pulls the keys it cares about. */
  result?: unknown;
}

export interface ChatParagraph {
  t: 'p';
  text: string;
}

export interface ChatThinking {
  t: 'thinking';
  text: string;
}

export type ChatBlock = ChatParagraph | ChatToolCall | ChatThinking;

export interface UserMessage {
  role: 'user';
  text: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: ChatBlock[];
  streaming?: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage;

interface Props {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onCancel?: () => void;
  disabled?: boolean;
  sessionTitle?: string;
  modelLabel?: string;
  onClose?: () => void;
  /** Called when the user clicks "view this run on the canvas" in a
   * `run_workflow` tool card. The host can swap the canvas to render the
   * run's frozen `workflow_snapshot`. */
  onViewRun?: (runId: string) => void;
}

function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  // While the orchestrator is actively thinking, expand by default and keep
  // the latest line in view. Once the turn settles, collapse it — the user
  // can reopen to inspect the trace.
  const [open, setOpen] = useState(live);
  const tailRef = useRef<HTMLDivElement | null>(null);

  // Auto-open when streaming starts; auto-collapse when streaming ends.
  useEffect(() => {
    setOpen(live);
  }, [live]);

  // Keep the bottom of the trace pinned while text streams in.
  useEffect(() => {
    if (open && live && tailRef.current) {
      tailRef.current.scrollTop = tailRef.current.scrollHeight;
    }
  }, [text, open, live]);

  return (
    <div
      className="fade-in"
      style={{
        margin: '4px 0 10px',
        borderLeft: '2px solid var(--rule)',
        paddingLeft: 10,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="smallcaps"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: 'transparent',
          border: 0,
          padding: '2px 0',
          cursor: 'pointer',
          color: 'var(--ink-4)',
          fontSize: 9.5,
        }}
      >
        <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', textTransform: 'none', letterSpacing: 0, fontSize: 11 }}>
          {live ? 'thinking' : 'thought'}
        </span>
        <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', textTransform: 'none' }}>
          {open ? '▾' : '▸'}
        </span>
        {live && <span className="caret" style={{ marginLeft: 2 }} />}
      </button>
      {open && (
        <div
          ref={tailRef}
          className="serif scroll"
          style={{
            marginTop: 6,
            fontStyle: 'italic',
            fontSize: 12.5,
            lineHeight: 1.55,
            color: 'var(--ink-4)',
            whiteSpace: 'pre-wrap',
            maxHeight: live ? 220 : 360,
            overflow: 'auto',
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

function ToolCallCard({ tool, args, status }: ChatToolCall) {
  return (
    <div
      className="tool-call fade-in"
      style={{
        padding: '7px 10px',
        margin: '6px 0',
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        fontSize: 11.5,
      }}
    >
      <span className="mono" style={{ color: 'var(--accent-ink)', fontSize: 10.5 }}>
        {tool}
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
        {args}
      </span>
      <span
        className="smallcaps"
        style={{
          color: status === 'ok' ? 'var(--state-ok)' : status === 'err' ? 'var(--state-err)' : 'var(--ink-4)',
          fontSize: 9,
        }}
      >
        {status === 'ok' ? '✓ done' : status === 'err' ? '× failed' : '…'}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// run_workflow card — a richer tool card that surfaces the frozen graph
// snapshot the run actually executed: node count, status of each, total
// cost, and the failing node(s) when something errored. Pulls the snapshot
// via GET /api/runs/:rid; falls back to the live `result` payload if the
// fetch fails (offline, run vanished, etc.).
// ---------------------------------------------------------------------------

interface RunWorkflowResult {
  run_id?: string;
  status?: string;
  outputs?: Record<string, unknown>;
  node_errors?: { node_id: string; node_name: string; error: string }[];
  error?: string | null;
  total_cost?: number;
}

function preview(value: unknown, max = 140): string {
  if (value == null) return '∅';
  if (typeof value === 'string') {
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
  }
  try {
    const json = JSON.stringify(value);
    return json.length > max ? json.slice(0, max - 1) + '…' : json;
  } catch {
    return String(value);
  }
}

function RunWorkflowCard({
  args,
  status,
  result,
  onViewRun,
}: ChatToolCall & { onViewRun?: (runId: string) => void }) {
  const r = (result ?? {}) as RunWorkflowResult;
  const runId = r.run_id;
  const [snapshot, setSnapshot] = useState<Run | null>(null);

  useEffect(() => {
    if (!runId || status === 'pending') return;
    let cancelled = false;
    api
      .getRun(runId)
      .then((run) => {
        if (!cancelled) setSnapshot(run);
      })
      .catch(() => {
        // Snapshot fetch failures are non-fatal — the card still renders the
        // live `result` payload, just without per-node detail.
      });
    return () => {
      cancelled = true;
    };
  }, [runId, status]);

  const wfSnap = snapshot?.workflow_snapshot ?? null;
  const nodeRuns = snapshot?.node_runs ?? [];
  const nodeNamesById = new Map(wfSnap?.nodes.map((n) => [n.id, n.name]) ?? []);
  const inputName = wfSnap?.input_node_id ? nodeNamesById.get(wfSnap.input_node_id) : undefined;
  const outputName = wfSnap?.output_node_id ? nodeNamesById.get(wfSnap.output_node_id) : undefined;

  const isPending = status === 'pending';
  const isErr = status === 'err' || !!r.error || (r.node_errors?.length ?? 0) > 0;
  const statusColor = isPending
    ? 'var(--ink-4)'
    : isErr
      ? 'var(--state-err)'
      : 'var(--state-ok)';
  const statusLabel = isPending ? 'running' : isErr ? 'failed' : 'ran';
  const cost = r.total_cost ?? 0;

  return (
    <div
      className="tool-call fade-in"
      style={{
        padding: '10px 12px',
        margin: '8px 0',
        fontSize: 11.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {/* header row: tool name · status pill · cost */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="mono" style={{ color: 'var(--accent-ink)', fontSize: 10.5 }}>
          run_workflow
        </span>
        <span
          className="smallcaps"
          style={{ color: statusColor, fontSize: 9 }}
        >
          {isPending ? '… running' : isErr ? '× failed' : '✓ ran'}
        </span>
        <span style={{ flex: 1 }} />
        {cost > 0 && (
          <span
            className="mono"
            style={{ color: 'var(--ink-4)', fontSize: 10 }}
            title="total cost"
          >
            ${cost.toFixed(4)}
          </span>
        )}
      </div>

      {/* snapshot summary line */}
      {wfSnap && (
        <div
          className="serif"
          style={{ color: 'var(--ink-3)', fontSize: 12, fontStyle: 'italic' }}
        >
          {statusLabel}{' '}
          <span className="mono" style={{ fontSize: 11, fontStyle: 'normal' }}>
            {wfSnap.nodes.length}-node
          </span>{' '}
          workflow
          {inputName && (
            <>
              {' · '}
              <span className="mono" style={{ fontSize: 11, fontStyle: 'normal' }}>
                {inputName}
              </span>
              {' → '}
              <span className="mono" style={{ fontSize: 11, fontStyle: 'normal' }}>
                {outputName ?? '?'}
              </span>
            </>
          )}
        </div>
      )}

      {/* args (the inputs the orchestrator passed) — small + muted */}
      {args && (
        <div
          className="mono"
          style={{
            color: 'var(--ink-4)',
            fontSize: 10.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {args}
        </div>
      )}

      {/* per-node statuses (compact list) */}
      {wfSnap && nodeRuns.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            columnGap: 8,
            rowGap: 3,
            fontSize: 10.5,
          }}
        >
          {wfSnap.nodes.map((n) => {
            const nr = nodeRuns.find((x) => x.node_id === n.id);
            const st = nr?.status ?? 'pending';
            const dot =
              st === 'success'
                ? 'var(--state-ok)'
                : st === 'error'
                  ? 'var(--state-err)'
                  : st === 'skipped'
                    ? 'var(--ink-5)'
                    : 'var(--ink-4)';
            return (
              <>
                <span
                  key={`${n.id}-dot`}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: dot,
                    alignSelf: 'center',
                  }}
                />
                <span
                  key={`${n.id}-name`}
                  className="mono"
                  style={{ color: 'var(--ink-3)', fontSize: 10.5 }}
                >
                  {n.name}
                </span>
                <span
                  key={`${n.id}-status`}
                  className="smallcaps"
                  style={{ color: 'var(--ink-4)', fontSize: 9 }}
                >
                  {st}
                </span>
              </>
            );
          })}
        </div>
      )}

      {/* errors — front and center when something failed */}
      {(r.node_errors ?? []).map((e) => (
        <div
          key={e.node_id}
          style={{
            background: 'rgba(180, 60, 60, 0.06)',
            borderLeft: '2px solid var(--state-err)',
            padding: '5px 8px',
            fontSize: 11,
            color: 'var(--ink-2)',
          }}
        >
          <span className="mono" style={{ color: 'var(--state-err)' }}>
            {e.node_name}
          </span>
          <span style={{ color: 'var(--ink-4)' }}>{' — '}</span>
          <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic' }}>
            {e.error}
          </span>
        </div>
      ))}
      {r.error && !(r.node_errors ?? []).length && (
        <div
          style={{
            background: 'rgba(180, 60, 60, 0.06)',
            borderLeft: '2px solid var(--state-err)',
            padding: '5px 8px',
            fontSize: 11,
            color: 'var(--ink-2)',
            fontStyle: 'italic',
            fontFamily: 'var(--serif)',
          }}
        >
          {r.error}
        </div>
      )}

      {/* outputs — compact preview */}
      {!isErr && r.outputs && Object.keys(r.outputs).length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            columnGap: 8,
            rowGap: 2,
            fontSize: 11,
            color: 'var(--ink-3)',
          }}
        >
          {Object.entries(r.outputs).map(([k, v]) => (
            <>
              <span key={`${k}-k`} className="mono" style={{ color: 'var(--ink-4)', fontSize: 10.5 }}>
                {k}
              </span>
              <span
                key={`${k}-v`}
                className="serif"
                style={{
                  color: 'var(--ink-2)',
                  fontStyle: 'italic',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {preview(v)}
              </span>
            </>
          ))}
        </div>
      )}

      {/* footer: view-on-canvas action */}
      {runId && onViewRun && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => onViewRun(runId)}
            className="smallcaps"
            style={{
              background: 'transparent',
              border: 0,
              padding: '2px 0',
              cursor: 'pointer',
              color: 'var(--accent-ink)',
              fontSize: 9.5,
              fontFamily: 'var(--serif)',
              fontStyle: 'italic',
              textTransform: 'none',
              letterSpacing: 0,
            }}
          >
            view this run's graph →
          </button>
        </div>
      )}
    </div>
  );
}

function MessageBubble({
  msg,
  onViewRun,
}: {
  msg: ChatMessage;
  onViewRun?: (runId: string) => void;
}) {
  if (msg.role === 'user') {
    return (
      <div
        className="fade-in"
        style={{ padding: '14px 22px', borderBottom: '1px solid var(--rule-2)' }}
      >
        <div className="smallcaps" style={{ marginBottom: 6, color: 'var(--ink-3)' }}>
          you
        </div>
        <div
          style={{
            fontFamily: 'var(--serif)',
            fontSize: 14.5,
            lineHeight: 1.55,
            color: 'var(--ink)',
          }}
        >
          {msg.text}
        </div>
      </div>
    );
  }
  return (
    <div
      className="fade-in"
      style={{ padding: '14px 22px', borderBottom: '1px solid var(--rule-2)' }}
    >
      <div className="smallcaps" style={{ marginBottom: 8, color: 'var(--accent-ink)' }}>
        orchestra{' '}
        <span
          style={{
            fontFamily: 'var(--serif)',
            textTransform: 'none',
            letterSpacing: 0,
            fontStyle: 'italic',
            fontWeight: 400,
            color: 'var(--ink-4)',
            fontSize: 10.5,
          }}
        >
          · {msg.streaming ? 'thinking' : 'said'}
        </span>
      </div>
      <div
        style={{
          fontFamily: 'var(--serif)',
          fontSize: 15,
          lineHeight: 1.55,
          color: 'var(--ink-2)',
        }}
      >
        {msg.content.map((c, i) => {
          if (c.t === 'thinking') {
            // The "live" thinking block is the last block when the message is
            // still streaming and has nothing else after it yet.
            const isTail =
              !!msg.streaming && i === msg.content.length - 1;
            return <ThinkingBlock key={i} text={c.text} live={isTail} />;
          }
          if (c.t === 'p') {
            return (
              <ReactMarkdown
                key={i}
                remarkPlugins={[remarkGfm]}
                components={MD_COMPONENTS}
              >
                {c.text}
              </ReactMarkdown>
            );
          }
          if (c.tool === 'run_workflow') {
            return <RunWorkflowCard key={i} {...c} onViewRun={onViewRun} />;
          }
          return <ToolCallCard key={i} {...c} />;
        })}
        {msg.streaming && <span className="caret" />}
      </div>
    </div>
  );
}

export function ChatPanel({ messages, onSend, onCancel, disabled, sessionTitle, modelLabel, onClose, onViewRun }: Props) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!draft.trim() || disabled) return;
    onSend(draft.trim());
    setDraft('');
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--paper)',
      }}
    >
      <div
        style={{
          padding: '14px 22px 12px',
          borderBottom: '1px solid var(--rule)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="smallcaps">orchestrator</span>
          <span style={{ flex: 1 }} />
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              color: 'var(--ink-4)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 160,
            }}
            title={modelLabel || 'no orchestrator model set — using server fallback'}
          >
            {modelLabel || '(default)'}
          </span>
          {onClose && (
            <button
              onClick={onClose}
              className="btn-ghost"
              style={{ padding: '3px 9px', fontSize: 11 }}
              title="close chat"
            >
              close ✕
            </button>
          )}
        </div>
        <div
          className="serif"
          style={{
            fontStyle: 'italic',
            fontSize: 18,
            lineHeight: 1.3,
            color: 'var(--ink)',
            marginTop: 6,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {sessionTitle || 'untitled session'}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="scroll"
        style={{ flex: 1, overflow: 'auto', background: 'var(--paper)' }}
      >
        {messages.length === 0 && (
          <div
            className="serif"
            style={{
              padding: '32px 22px',
              fontStyle: 'italic',
              color: 'var(--ink-4)',
              fontSize: 14,
              lineHeight: 1.6,
            }}
          >
            the canvas is yours. wire nodes by hand — or describe a problem and{' '}
            <span className="italic-em" style={{ color: 'var(--ink-3)' }}>
              orchestra
            </span>{' '}
            will sketch a pipeline. (the orchestrator is wired but quiet for now.)
          </div>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} msg={m} onViewRun={onViewRun} />
        ))}
      </div>

      <form
        onSubmit={submit}
        style={{
          padding: '14px 22px 16px',
          borderTop: '1px solid var(--rule)',
          background: 'var(--paper-2)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="asterisk" style={{ fontSize: 18 }}>
            ✽
          </span>
          <input
            className="field"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={disabled ? 'orchestra is working…' : 'refine, add a node, or ask anything'}
            disabled={disabled}
            style={{ flex: 1, fontStyle: 'italic' }}
          />
          {disabled && onCancel ? (
            <button
              type="button"
              className="btn-ghost"
              onClick={onCancel}
              style={{ borderColor: 'var(--state-err)', color: 'var(--state-err)' }}
              title="stop the orchestrator"
            >
              stop <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic' }}>✕</span>
            </button>
          ) : (
            <button
              type="submit"
              className="btn-ghost"
              disabled={!draft.trim() || disabled}
            >
              send <span style={{ fontFamily: 'var(--serif)', fontStyle: 'italic' }}>↩</span>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
