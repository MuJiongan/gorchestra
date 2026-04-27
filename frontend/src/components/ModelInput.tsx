import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchOpenRouterModels, type OpenRouterModel } from '../openrouterModels';

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Visual style — `underline` matches the Settings page, `bordered` matches the NodePanel cell. */
  variant?: 'underline' | 'bordered';
  ariaLabel?: string;
}

const MAX_RESULTS = 80;

export function ModelInput({
  value,
  onChange,
  placeholder,
  variant = 'underline',
  ariaLabel,
}: Props) {
  const [models, setModels] = useState<OpenRouterModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Lazy-load the model list the first time the input is focused.
  const loadModels = () => {
    if (models || error) return;
    fetchOpenRouterModels()
      .then((m) => setModels(m))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  // Outside-click closes the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const matches = useMemo(() => {
    if (!models) return [];
    const q = value.trim().toLowerCase();
    const all = models;
    const filtered = q
      ? all.filter((m) => m.id.toLowerCase().includes(q) || (m.name && m.name.toLowerCase().includes(q)))
      : all;
    return filtered.slice(0, MAX_RESULTS);
  }, [models, value]);

  // Keep highlighted item in range when the result list shrinks.
  useEffect(() => {
    if (highlight >= matches.length) setHighlight(0);
  }, [matches.length, highlight]);

  // Scroll highlighted item into view as user arrows through.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  const commit = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => Math.min(h + 1, Math.max(matches.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && matches[highlight]) {
        e.preventDefault();
        commit(matches[highlight].id);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  };

  const inputStyle: React.CSSProperties =
    variant === 'underline'
      ? {
          width: '100%',
          background: 'transparent',
          border: 0,
          borderBottom: '1px solid var(--rule)',
          padding: '8px 0',
          fontSize: 13,
          color: 'var(--ink)',
          outline: 'none',
        }
      : {
          width: '100%',
          background: 'transparent',
          border: '1px solid var(--rule)',
          borderRadius: 3,
          padding: '5px 9px',
          fontSize: 12,
          color: 'var(--ink-2)',
          outline: 'none',
        };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <input
        type="text"
        className="mono"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        onFocus={() => {
          loadModels();
          setOpen(true);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          if (!open) setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
        style={inputStyle}
      />
      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="shadow-card fade-in"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 4,
            maxHeight: 280,
            overflowY: 'auto',
            background: 'var(--paper)',
            border: '1px solid var(--rule)',
            borderRadius: 4,
            padding: 4,
            zIndex: 100,
          }}
        >
          {error && (
            <div
              className="serif"
              style={{ padding: 10, fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 12.5 }}
            >
              couldn't load openrouter models — {error}.
            </div>
          )}
          {!error && !models && (
            <div
              className="serif"
              style={{ padding: 10, fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 12.5 }}
            >
              loading models…
            </div>
          )}
          {!error && models && matches.length === 0 && (
            <div
              className="serif"
              style={{ padding: 10, fontStyle: 'italic', color: 'var(--ink-4)', fontSize: 12.5 }}
            >
              no matches.
            </div>
          )}
          {!error &&
            models &&
            matches.map((m, i) => {
              const active = i === highlight;
              return (
                <div
                  key={m.id}
                  role="option"
                  aria-selected={active}
                  data-idx={i}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(m.id);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  style={{
                    padding: '6px 8px',
                    borderRadius: 3,
                    cursor: 'pointer',
                    background: active ? 'var(--paper-2)' : 'transparent',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  {m.name && m.name !== m.id ? (
                    <>
                      <span
                        className="serif"
                        style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--ink)' }}
                      >
                        {m.name}
                      </span>
                      <span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)' }}>
                        {m.id}
                      </span>
                    </>
                  ) : (
                    <span className="mono" style={{ fontSize: 12, color: 'var(--ink)' }}>
                      {m.id}
                    </span>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
