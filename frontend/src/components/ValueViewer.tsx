import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { JsonView } from './JsonView';
import { Markdown } from './Markdown';

/**
 * Compact, clickable row for a single named value (e.g. a node input/output
 * port, a log bundle, a tool-call result). Shows a one-line preview plus a
 * size hint; clicking opens a full-screen overlay with the rendered value.
 *
 * The goal is to keep the run-trace dense — one row per piece of data —
 * while still making the full payload trivially reachable.
 */

const MD_HINTS =
  /(^|\n)\s*(#{1,6}\s|[-*+]\s|>\s|\d+\.\s|```)|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\)|^\|.+\|$/m;

function looksLikeMarkdown(s: string): boolean {
  if (s.length < 12) return false;
  return MD_HINTS.test(s);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface PreviewInfo {
  text: string;        // one-line preview (already truncated)
  size: string | null; // size badge (null = hide)
  // primitives small enough we can render inline without an overlay.
  inline: boolean;
}

function describe(value: unknown): PreviewInfo {
  if (value === null) return { text: 'null', size: null, inline: true };
  if (value === undefined) return { text: 'undefined', size: null, inline: true };
  if (typeof value === 'boolean') return { text: String(value), size: null, inline: true };
  if (typeof value === 'number') return { text: String(value), size: null, inline: true };
  if (typeof value === 'string') {
    const collapsed = value.replace(/\s+/g, ' ').trim();
    const lines = value.split('\n').length;
    const chars = value.length;
    const inline = !value.includes('\n') && chars <= 80;
    const size = inline
      ? null
      : lines > 1
        ? `${lines} lines · ${formatBytes(chars)}`
        : formatBytes(chars);
    return {
      text: collapsed.length > 120 ? collapsed.slice(0, 120) + '…' : collapsed,
      size,
      inline,
    };
  }
  if (Array.isArray(value)) {
    return {
      text: value.length === 0 ? '[ ]' : `[${value.length === 1 ? '1 item' : `${value.length} items`}]`,
      size: null,
      inline: value.length === 0,
    };
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return {
      text:
        keys.length === 0
          ? '{ }'
          : `{ ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''} }`,
      size: keys.length ? `${keys.length} ${keys.length === 1 ? 'key' : 'keys'}` : null,
      inline: keys.length === 0,
    };
  }
  return { text: String(value), size: null, inline: true };
}

function ValueBody({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    if (looksLikeMarkdown(value)) {
      return <Markdown>{value}</Markdown>;
    }
    return (
      <pre
        className="mono"
        style={{
          fontSize: 12,
          color: 'var(--ink-2)',
          margin: 0,
          padding: '12px 16px',
          background: 'var(--paper)',
          border: '1px solid var(--rule-2)',
          borderRadius: 3,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {value}
      </pre>
    );
  }
  return <JsonView value={value} />;
}

function copy(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  navigator.clipboard?.writeText(text).catch(() => {});
}

interface ViewerOverlayProps {
  title: string;
  subtitle?: string;
  value: unknown;
  onClose: () => void;
}

export function ViewerOverlay({ title, subtitle, value, onClose }: ViewerOverlayProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const onCopy = () => {
    copy(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(26, 23, 20, 0.45)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
        padding: '4vh 4vw',
        zIndex: 1000,
      }}
      className="fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="shadow-card"
        style={{
          flex: 1,
          maxWidth: 1100,
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          borderRadius: 4,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            padding: '14px 18px',
            borderBottom: '1px solid var(--rule)',
            background: 'var(--paper-2)',
          }}
        >
          <span className="smallcaps">{title}</span>
          {subtitle && (
            <span
              className="serif"
              style={{ fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 12 }}
            >
              {subtitle}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button className="ed-btn ed-btn--mini" onClick={onCopy}>
            {copied ? 'copied' : 'copy'}{' '}
            <span className="ed-btn__mark">{copied ? '✓' : '⎘'}</span>
          </button>
          <button className="ed-btn ed-btn--mini" onClick={onClose}>
            close <span className="ed-btn__mark">×</span>
          </button>
        </div>
        <div
          className="scroll"
          style={{ flex: 1, overflow: 'auto', padding: 18 }}
        >
          <ValueBody value={value} />
        </div>
        <div
          style={{
            padding: '8px 18px',
            borderTop: '1px solid var(--rule)',
            background: 'var(--paper-2)',
            color: 'var(--ink-4)',
          }}
          className="serif"
        >
          <span style={{ fontStyle: 'italic', fontSize: 11.5 }}>
            esc to close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface PortRowProps {
  name: string;
  typeHint?: string;
  value: unknown;
  /** Title shown in the overlay header when expanded. */
  viewerTitle: string;
  /** Optional subtitle for the overlay header (e.g. "from analyze.summary"). */
  viewerSubtitle?: string;
}

/**
 * One row that summarizes a value. Inline-renders trivial primitives;
 * for anything larger it shows a preview + size, and clicking opens
 * the full payload in a fullscreen overlay.
 */
export function PortRow({
  name,
  typeHint,
  value,
  viewerTitle,
  viewerSubtitle,
}: PortRowProps) {
  const [open, setOpen] = useState(false);
  const info = describe(value);

  const labelEl = (
    <>
      <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink)' }}>
        {name}
      </span>
      {typeHint && (
        <span
          className="serif"
          style={{ fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 11 }}
        >
          {typeHint}
        </span>
      )}
    </>
  );

  if (info.inline) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          padding: '5px 0',
          borderBottom: '1px solid var(--rule-2)',
          fontSize: 12,
        }}
      >
        {labelEl}
        <span
          className="mono"
          style={{
            color: 'var(--ink-2)',
            fontSize: 11,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {info.text}
        </span>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="port-row"
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'baseline',
          gap: 8,
          padding: '6px 8px',
          margin: '2px -8px',
          background: 'transparent',
          border: 0,
          borderRadius: 3,
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'inherit',
          color: 'inherit',
          transition: 'background .12s',
        }}
      >
        {labelEl}
        <span
          className="serif"
          style={{
            fontStyle: 'italic',
            color: 'var(--ink-3)',
            fontSize: 12,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {info.text}
        </span>
        {info.size && (
          <span className="smallcaps" style={{ fontSize: 9, color: 'var(--ink-4)' }}>
            {info.size}
          </span>
        )}
        <span
          className="ed-btn__mark"
          aria-hidden
          style={{ color: 'var(--ink-4)', fontSize: 12, marginLeft: 2 }}
        >
          ⤢
        </span>
      </button>
      {open && (
        <ViewerOverlay
          title={viewerTitle}
          subtitle={viewerSubtitle}
          value={value}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

interface ValueRowProps {
  /** Label shown on the row (e.g. "logs", "result"). */
  label: string;
  value: unknown;
  viewerTitle: string;
  viewerSubtitle?: string;
}

/** Single-row variant where there's no "port name" — just a label and value. */
export function ValueRow({ label, value, viewerTitle, viewerSubtitle }: ValueRowProps) {
  return (
    <PortRow
      name={label}
      value={value}
      viewerTitle={viewerTitle}
      viewerSubtitle={viewerSubtitle}
    />
  );
}
