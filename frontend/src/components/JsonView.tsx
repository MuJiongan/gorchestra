import { useState } from 'react';
import { Markdown } from './Markdown';

/**
 * Editorial JSON viewer — used for run inputs/outputs/logs/llm_calls/tool_calls.
 *
 * Differences from a raw JSON.stringify dump:
 * - Objects/arrays are collapsible.
 * - String values that look like markdown render as actual markdown.
 * - Multi-line strings render as wrap-preserving prose.
 * - Numbers / bools / null get type-aware styling.
 */

const MD_HINTS =
  // headings, lists, blockquotes, fenced code, bold/italic, links, tables.
  /(^|\n)\s*(#{1,6}\s|[-*+]\s|>\s|\d+\.\s|```)|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\)|^\|.+\|$/m;

function looksLikeMarkdown(s: string): boolean {
  if (s.length < 12) return false;
  return MD_HINTS.test(s);
}

function StringValue({ value, large = false }: { value: string; large?: boolean }) {
  if (looksLikeMarkdown(value)) {
    return (
      <div
        style={{
          padding: '6px 10px',
          background: 'var(--paper)',
          border: '1px solid var(--rule-2)',
          borderRadius: 3,
          marginTop: 2,
        }}
      >
        <Markdown large={large}>{value}</Markdown>
      </div>
    );
  }
  if (value.includes('\n') || value.length > 80) {
    return (
      <pre
        className="mono"
        style={{
          fontSize: large ? 13 : 11,
          color: 'var(--ink-2)',
          margin: '2px 0 0',
          padding: '6px 10px',
          background: 'var(--paper)',
          border: '1px solid var(--rule-2)',
          borderRadius: 3,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'var(--mono)',
        }}
      >
        {value}
      </pre>
    );
  }
  return (
    <span
      style={{
        fontFamily: 'var(--serif)',
        fontStyle: 'italic',
        color: 'var(--ink-2)',
        fontSize: large ? 14.5 : 13,
      }}
    >
      {value}
    </span>
  );
}

function PrimitiveBadge({
  text,
  color,
  mono,
  large = false,
}: {
  text: string;
  color: string;
  mono?: boolean;
  large?: boolean;
}) {
  return (
    <span
      className={mono ? 'mono' : 'smallcaps'}
      style={{ color, fontSize: mono ? (large ? 13 : 11.5) : (large ? 10.5 : 9) }}
    >
      {text}
    </span>
  );
}

interface NodeProps {
  value: unknown;
  level: number;
  large?: boolean;
}

function Node({ value, level, large = false }: NodeProps) {
  if (value === null) {
    return <PrimitiveBadge text="null" color="var(--ink-4)" large={large} />;
  }
  if (value === undefined) {
    return <PrimitiveBadge text="undefined" color="var(--ink-4)" large={large} />;
  }
  if (typeof value === 'boolean') {
    return (
      <PrimitiveBadge text={String(value)} color="var(--accent-ink)" large={large} />
    );
  }
  if (typeof value === 'number') {
    return (
      <span
        className="mono"
        style={{ color: 'var(--ink)', fontSize: large ? 13 : 11.5 }}
      >
        {value}
      </span>
    );
  }
  if (typeof value === 'string') {
    return <StringValue value={value} large={large} />;
  }
  if (Array.isArray(value)) {
    return <ArrayNode value={value} level={level} large={large} />;
  }
  if (typeof value === 'object') {
    return <ObjectNode value={value as Record<string, unknown>} level={level} large={large} />;
  }
  return (
    <span className="mono" style={{ color: 'var(--ink-3)' }}>
      {String(value)}
    </span>
  );
}

function Disclosure({
  open,
  onToggle,
  summary,
  large = false,
}: {
  open: boolean;
  onToggle: () => void;
  summary: React.ReactNode;
  large?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        background: 'transparent',
        border: 0,
        padding: '2px 0',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        color: 'var(--ink-3)',
        fontFamily: 'var(--sans)',
        fontSize: large ? 12 : 10.5,
      }}
    >
      <span style={{ width: 10, display: 'inline-block', textAlign: 'center', color: 'var(--ink-4)' }}>
        {open ? '▾' : '▸'}
      </span>
      {summary}
    </button>
  );
}

function ArrayNode({ value, level, large = false }: { value: unknown[]; level: number; large?: boolean }) {
  const [open, setOpen] = useState(level < 2);
  if (value.length === 0) {
    return <span style={{ color: 'var(--ink-4)' }}>[ ]</span>;
  }
  return (
    <div>
      <Disclosure
        open={open}
        onToggle={() => setOpen((v) => !v)}
        large={large}
        summary={
          <span className="smallcaps" style={{ fontSize: large ? 10.5 : 9 }}>
            array · {value.length}
          </span>
        }
      />
      {open && (
        <div
          style={{
            paddingLeft: 12,
            borderLeft: '1px solid var(--rule-2)',
            marginLeft: 4,
            marginTop: 2,
          }}
        >
          {value.map((v, i) => (
            <div key={i} style={{ marginTop: 4 }}>
              <span
                className="mono"
                style={{
                  fontSize: large ? 11.5 : 10,
                  color: 'var(--ink-4)',
                  marginRight: 8,
                }}
              >
                [{i}]
              </span>
              <span style={{ display: 'inline-block', verticalAlign: 'top' }}>
                <Node value={v} level={level + 1} large={large} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ObjectNode({
  value,
  level,
  large = false,
}: {
  value: Record<string, unknown>;
  level: number;
  large?: boolean;
}) {
  const keys = Object.keys(value);
  const [open, setOpen] = useState(level < 2);
  if (keys.length === 0) {
    return <span style={{ color: 'var(--ink-4)' }}>{'{ }'}</span>;
  }
  return (
    <div>
      <Disclosure
        open={open}
        onToggle={() => setOpen((v) => !v)}
        large={large}
        summary={
          <span className="smallcaps" style={{ fontSize: large ? 10.5 : 9 }}>
            object · {keys.length} {keys.length === 1 ? 'key' : 'keys'}
          </span>
        }
      />
      {open && (
        <div
          style={{
            paddingLeft: 12,
            borderLeft: '1px solid var(--rule-2)',
            marginLeft: 4,
            marginTop: 2,
          }}
        >
          {keys.map((k) => (
            <div key={k} style={{ marginTop: 4 }}>
              <span
                className="mono"
                style={{
                  fontSize: large ? 12.5 : 11,
                  color: 'var(--ink)',
                  marginRight: 8,
                }}
              >
                {k}
              </span>
              <span style={{ display: 'inline-block', verticalAlign: 'top', maxWidth: '100%' }}>
                <Node value={value[k]} level={level + 1} large={large} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function JsonView({ value, large = false }: { value: unknown; large?: boolean }) {
  // Top level — wrap in a paper card matching the prior <pre> styling.
  return (
    <div
      style={{
        padding: 8,
        background: 'var(--paper)',
        border: '1px solid var(--rule-2)',
        borderRadius: 3,
        fontSize: large ? 14 : 12,
        color: 'var(--ink-2)',
        maxWidth: '100%',
        overflowX: 'auto',
      }}
    >
      <Node value={value} level={0} large={large} />
    </div>
  );
}
