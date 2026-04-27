import { useEffect, useState } from 'react';
import type { Settings } from '../types';
import { loadSettings, saveSettings } from '../localSettings';
import { ModelInput } from './ModelInput';

const EMPTY: Settings = {
  openrouter_api_key: '',
  parallel_api_key: '',
  default_orchestrator_model: '',
  default_node_model: '',
};

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings>(EMPTY);
  const [saved, setSaved] = useState(false);
  const [revealKeys, setRevealKeys] = useState(false);

  useEffect(() => {
    setS(loadSettings());
  }, []);

  const save = () => {
    saveSettings(s);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'auto', background: 'var(--paper)' }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '40px 32px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
          <span className="smallcaps">settings</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h2
            className="serif"
            style={{
              margin: '4px 0 28px',
              fontSize: 30,
              fontWeight: 400,
              letterSpacing: '-0.01em',
              color: 'var(--ink)',
            }}
          >
            keys & defaults.
          </h2>
          <button onClick={onClose} className="btn-ghost">
            close
          </button>
        </div>

        <p
          className="serif"
          style={{
            fontStyle: 'italic',
            color: 'var(--ink-3)',
            fontSize: 13.5,
            margin: '0 0 24px',
            lineHeight: 1.55,
          }}
        >
          your keys live in this browser's <span className="mono" style={{ fontStyle: 'normal' }}>localStorage</span>{' '}
          — the backend never persists them. they're sent as headers on each request.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <Field
            label="openrouter api key"
            value={s.openrouter_api_key}
            onChange={(v) => setS({ ...s, openrouter_api_key: v })}
            secret={!revealKeys}
            hint="used for every call_llm — orchestrator and node code alike."
          />
          <Field
            label="parallel.ai api key"
            value={s.parallel_api_key}
            onChange={(v) => setS({ ...s, parallel_api_key: v })}
            secret={!revealKeys}
            hint="used by the web_search tool."
          />

          <label
            className="serif"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontStyle: 'italic',
              fontSize: 13,
              color: 'var(--ink-3)',
              cursor: 'pointer',
              marginTop: -8,
            }}
          >
            <input
              type="checkbox"
              checked={revealKeys}
              onChange={(e) => setRevealKeys(e.target.checked)}
            />
            reveal keys
          </label>

          <ModelField
            label="default orchestrator model"
            value={s.default_orchestrator_model}
            onChange={(v) => setS({ ...s, default_orchestrator_model: v })}
            hint="used by the orchestrator. e.g. anthropic/claude-sonnet-4.5"
          />
          <ModelField
            label="default node model"
            value={s.default_node_model}
            onChange={(v) => setS({ ...s, default_node_model: v })}
            hint="default for ctx.call_llm inside nodes when no model is specified."
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
            <button onClick={save} className="btn-ink">
              save <span className="italic-em">→</span>
            </button>
            {saved && (
              <span
                className="serif"
                style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--state-ok)' }}
              >
                saved to this browser.
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, hint, secret,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  secret?: boolean;
}) {
  return (
    <div>
      <label className="smallcaps" style={{ display: 'block', marginBottom: 6 }}>
        {label}
      </label>
      <input
        type={secret ? 'password' : 'text'}
        className="mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        style={{
          width: '100%',
          background: 'transparent',
          border: 0,
          borderBottom: '1px solid var(--rule)',
          padding: '8px 0',
          fontSize: 13,
          color: 'var(--ink)',
          outline: 'none',
        }}
      />
      {hint && (
        <div
          className="serif"
          style={{ fontStyle: 'italic', fontSize: 12, color: 'var(--ink-4)', marginTop: 6 }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

function ModelField({
  label, value, onChange, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className="smallcaps" style={{ display: 'block', marginBottom: 6 }}>
        {label}
      </label>
      <ModelInput value={value} onChange={onChange} ariaLabel={label} />
      {hint && (
        <div
          className="serif"
          style={{ fontStyle: 'italic', fontSize: 12, color: 'var(--ink-4)', marginTop: 6 }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
