/**
 * Settings live in browser localStorage and are sent to the backend as
 * headers on every request. Source of truth is the browser, so the keys
 * never get persisted server-side.
 */
import type { Settings } from './types';

const KEY = 'orchestra:settings';
export const SETTINGS_CHANGED_EVENT = 'orchestra:settings-changed';

const EMPTY: Settings = {
  openrouter_api_key: '',
  parallel_api_key: '',
  default_orchestrator_model: '',
  default_node_model: '',
};

export function loadSettings(): Settings {
  if (typeof window === 'undefined') return { ...EMPTY };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw);
    return {
      openrouter_api_key: parsed.openrouter_api_key ?? '',
      parallel_api_key: parsed.parallel_api_key ?? '',
      default_orchestrator_model: parsed.default_orchestrator_model ?? '',
      default_node_model: parsed.default_node_model ?? '',
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveSettings(s: Settings): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(KEY, JSON.stringify(s));
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT));
}

export function clearSettings(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(KEY);
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT));
}

/** Headers to include on every request that may end up calling an LLM. */
export function settingsHeaders(): Record<string, string> {
  const s = loadSettings();
  const h: Record<string, string> = {};
  if (s.openrouter_api_key) h['X-Openrouter-Key'] = s.openrouter_api_key;
  if (s.parallel_api_key) h['X-Parallel-Key'] = s.parallel_api_key;
  if (s.default_orchestrator_model) h['X-Orchestrator-Model'] = s.default_orchestrator_model;
  if (s.default_node_model) h['X-Node-Model'] = s.default_node_model;
  return h;
}
