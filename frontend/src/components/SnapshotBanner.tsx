import type { Run } from '../types';

export function SnapshotBanner({
  run,
}: {
  run: Run;
}) {
  const statusColor =
    run.status === 'success'
      ? 'var(--state-ok)'
      : run.status === 'error'
        ? 'var(--state-err)'
        : 'var(--ink-4)';
  const statusGlyph =
    run.status === 'success' ? '✓' : run.status === 'error' ? '×' : '·';
  return (
    <div
      style={{
        padding: '6px 12px',
        background: 'var(--paper-2)',
        borderTop: '1px solid var(--rule)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        fontSize: 11.5,
        minWidth: 0,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 6,
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        <span style={{ color: statusColor, fontSize: 10 }}>{statusGlyph}</span>
        <span
          className="serif"
          style={{
            fontStyle: 'italic',
            color: 'var(--ink-3)',
            fontSize: 12,
            whiteSpace: 'nowrap',
          }}
        >
          snapshot
        </span>
        <span
          className="mono"
          style={{
            color: 'var(--ink-4)',
            fontSize: 10.5,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {run.id.slice(0, 8)}
        </span>
      </span>
      <span
        className="smallcaps"
        style={{
          color: 'var(--ink-4)',
          fontSize: 9,
          whiteSpace: 'nowrap',
          flex: 'none',
        }}
      >
        read-only run graph
      </span>
    </div>
  );
}
