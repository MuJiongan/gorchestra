// Browser notifications for run completion.
//
// Permission must be requested from a user gesture (button click, message
// send), so callers prime this on the same path that kicks off a run —
// `ensureNotificationPermission()` is a no-op after the first call.

import type { RunStatus } from './types';

let permissionAsked = false;

export function ensureNotificationPermission(): void {
  if (typeof Notification === 'undefined') return;
  if (permissionAsked) return;
  permissionAsked = true;
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

export function notifyRunFinished({
  runId,
  workflowName,
  status,
  error,
  outputs,
  totalCost,
  durationMs,
}: {
  runId: string;
  workflowName: string;
  status: RunStatus;
  error: string | null;
  outputs: Record<string, unknown> | null;
  totalCost: number;
  durationMs: number;
}): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;

  const icon =
    status === 'success' ? '✓'
    : status === 'error' ? '×'
    : status === 'cancelled' ? '—'
    : '·';
  const title = `${icon} ${workflowName}`;

  const lines: string[] = [];
  if (status === 'success' && outputs) {
    const preview = previewOutputs(outputs);
    if (preview) lines.push(preview);
  } else if (status === 'error' && error) {
    lines.push(truncate(error.replace(/\s+/g, ' ').trim(), 200));
  } else if (status === 'cancelled') {
    lines.push('cancelled');
  }
  const meta: string[] = [`run ${runId.slice(0, 8)}`];
  if (Number.isFinite(durationMs) && durationMs > 0) meta.push(formatDuration(durationMs));
  if (Number.isFinite(totalCost) && totalCost > 0) meta.push(`$${totalCost.toFixed(4)}`);
  lines.push(meta.join(' · '));

  try {
    new Notification(title, { body: lines.join('\n'), tag: `run-${runId}` });
  } catch {
    /* ignore — some browsers throw when the page lacks user activation */
  }
}

function previewOutputs(outputs: Record<string, unknown>): string {
  const entries = Object.entries(outputs).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );
  if (entries.length === 0) return '';
  if (entries.length === 1) {
    return truncate(formatValue(entries[0][1]), 120);
  }
  const per = Math.max(20, Math.floor(120 / entries.length));
  return entries
    .map(([k, v]) => `${k}: ${truncate(formatValue(v), per)}`)
    .join(' · ');
}

function formatValue(v: unknown): string {
  const raw = typeof v === 'string' ? v : safeStringify(v);
  return raw.replace(/\s+/g, ' ').trim();
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const mins = Math.floor(s / 60);
  const rem = Math.round(s - mins * 60);
  return rem ? `${mins}m${rem}s` : `${mins}m`;
}
