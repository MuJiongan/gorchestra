import { useEffect, useRef, useState } from 'react';
import type { Workflow } from '../types';

interface Props {
  workflows: Workflow[];
  activeWorkflow: Workflow | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  onOpenRun: () => void;
  runDisabled?: boolean;
  status?: 'idle' | 'building' | 'running' | 'ready';
}

export function TopBar({
  workflows,
  activeWorkflow,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onOpenSettings,
  onOpenRun,
  runDisabled,
  status = 'idle',
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // id of the workflow row currently being renamed inline (null = none).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const pickerRef = useRef<HTMLDivElement | null>(null);

  // Close on outside-click. Listener only mounts while the picker is open so
  // we don't catch the very click that's about to open it.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
        setEditingId(null);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [pickerOpen]);

  const startRename = (w: Workflow) => {
    setEditingId(w.id);
    setDraftName(w.name);
  };

  const commitRename = (id: string) => {
    const trimmed = draftName.trim();
    const original = workflows.find((w) => w.id === id);
    if (trimmed && original && trimmed !== original.name) {
      onRename(id, trimmed);
    }
    setEditingId(null);
  };

  const statusLabel =
    status === 'building' ? 'building' : status === 'running' ? 'running' : status === 'ready' ? 'ready' : 'idle';
  const statusDotClass =
    status === 'building' || status === 'running' ? 'running' : status === 'ready' ? 'success' : 'idle';

  return (
    <div
      style={{
        height: 54,
        borderBottom: '1px solid var(--rule)',
        background: 'var(--paper)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 22px',
        gap: 18,
        position: 'relative',
        zIndex: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span
          className="serif"
          style={{
            fontStyle: 'italic',
            fontSize: 22,
            color: 'var(--ink)',
            letterSpacing: '-0.01em',
          }}
        >
          orchestra
        </span>
      </div>

      <span className="smallcaps" style={{ color: 'var(--ink-4)' }}>session</span>

      <div
        ref={pickerRef}
        style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}
      >
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={pickerOpen}
          className="serif"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontStyle: 'italic',
            fontSize: 14,
            color: 'var(--ink-2)',
            maxWidth: 460,
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
            padding: '2px 0',
            textAlign: 'left',
            minWidth: 0,
          }}
          title="switch session"
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {activeWorkflow?.name || 'untitled'}
          </span>
          <span
            style={{
              color: 'var(--ink-4)',
              fontStyle: 'normal',
              fontSize: 11,
              flex: 'none',
              transition: 'transform .15s',
              transform: pickerOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              display: 'inline-block',
            }}
          >
            ▾
          </span>
        </button>

        {pickerOpen && (
          <div
            className="shadow-card fade-in"
            role="listbox"
            style={{
              position: 'absolute',
              top: 28,
              left: 0,
              minWidth: 320,
              maxHeight: 360,
              overflow: 'auto',
              background: 'var(--paper)',
              border: '1px solid var(--rule)',
              borderRadius: 4,
              padding: 6,
              zIndex: 100,
            }}
          >
            {workflows.length === 0 && (
              <div
                className="serif"
                style={{ padding: 12, fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 13 }}
              >
                no sessions yet.
              </div>
            )}
            {workflows.map((w) => {
              const isActive = w.id === activeWorkflow?.id;
              const isEditing = editingId === w.id;
              return (
                <SessionRow
                  key={w.id}
                  workflow={w}
                  isActive={isActive}
                  isEditing={isEditing}
                  draftName={draftName}
                  onDraftChange={setDraftName}
                  onCommit={() => commitRename(w.id)}
                  onCancelEdit={() => setEditingId(null)}
                  onSelect={() => {
                    onSelect(w.id);
                    setPickerOpen(false);
                    setEditingId(null);
                  }}
                  onStartRename={() => startRename(w)}
                  onDelete={() => {
                    if (confirm(`delete "${w.name}"?`)) onDelete(w.id);
                  }}
                />
              );
            })}
          </div>
        )}
      </div>

      {activeWorkflow && (
        <span
          className="smallcaps"
          style={{
            color: 'var(--ink-3)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span className={`node-state-dot ${statusDotClass}`} />
          {statusLabel}
        </span>
      )}

      <button className="ed-btn" onClick={onOpenSettings}>
        settings
      </button>
      <button className="ed-btn" onClick={onNew}>
        new <span className="ed-btn__mark">+</span>
      </button>
      <button className="ed-btn ed-btn--primary" onClick={onOpenRun} disabled={runDisabled}>
        run <span className="ed-btn__mark">→</span>
      </button>
    </div>
  );
}

function SessionRow({
  workflow,
  isActive,
  isEditing,
  draftName,
  onDraftChange,
  onCommit,
  onCancelEdit,
  onSelect,
  onStartRename,
  onDelete,
}: {
  workflow: Workflow;
  isActive: boolean;
  isEditing: boolean;
  draftName: string;
  onDraftChange: (s: string) => void;
  onCommit: () => void;
  onCancelEdit: () => void;
  onSelect: () => void;
  onStartRename: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      role="option"
      aria-selected={isActive}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => {
        if (isEditing) return;
        onSelect();
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 10px',
        borderRadius: 3,
        cursor: isEditing ? 'default' : 'pointer',
        background: isActive ? 'var(--paper-2)' : 'transparent',
      }}
    >
      {isEditing ? (
        <input
          autoFocus
          value={draftName}
          onChange={(e) => onDraftChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommit();
            else if (e.key === 'Escape') onCancelEdit();
          }}
          className="serif"
          style={{
            flex: 1,
            fontStyle: 'italic',
            fontSize: 13.5,
            color: 'var(--ink)',
            background: 'transparent',
            border: 0,
            outline: 'none',
            borderBottom: '1px solid var(--ink)',
            padding: '1px 0',
            minWidth: 0,
          }}
        />
      ) : (
        <span
          className="serif"
          style={{
            fontStyle: 'italic',
            fontSize: 13.5,
            color: 'var(--ink-2)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {workflow.name}
        </span>
      )}

      {/* Row actions — only revealed on hover or while editing. They use
          mousedown to fire before the row's onClick (which would otherwise
          select the workflow). */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          opacity: hovered || isEditing ? 1 : 0,
          transition: 'opacity .15s',
        }}
      >
        {!isEditing && (
          <button
            type="button"
            title="rename"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => {
              e.stopPropagation();
              onStartRename();
            }}
            style={{
              background: 'transparent',
              border: 0,
              color: 'var(--ink-4)',
              cursor: 'pointer',
              fontSize: 12,
              padding: '0 4px',
              fontFamily: 'var(--serif)',
              fontStyle: 'italic',
            }}
          >
            ✎
          </button>
        )}
        <button
          type="button"
          title="delete"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          style={{
            background: 'transparent',
            border: 0,
            color: 'var(--ink-4)',
            cursor: 'pointer',
            fontSize: 13,
            padding: '0 4px',
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
