import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

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

function MessageBubble({ msg }: { msg: ChatMessage }) {
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
          return <ToolCallCard key={i} {...c} />;
        })}
        {msg.streaming && <span className="caret" />}
      </div>
    </div>
  );
}

export function ChatPanel({ messages, onSend, onCancel, disabled, sessionTitle, modelLabel, onClose }: Props) {
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
          <MessageBubble key={i} msg={m} />
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
