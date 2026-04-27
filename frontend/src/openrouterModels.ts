/**
 * Fetches the list of model ids available on OpenRouter once per tab and
 * caches in memory + sessionStorage so the autocomplete dropdown is instant
 * on subsequent focuses. The /models endpoint is public, so no key needed.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/models';
const SESSION_KEY = 'orchestra:openrouter-models';

export interface OpenRouterModel {
  id: string;
  name?: string;
}

let inflight: Promise<OpenRouterModel[]> | null = null;
let cache: OpenRouterModel[] | null = null;

function readSessionCache(): OpenRouterModel[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((m) => m && typeof m.id === 'string');
  } catch {
    return null;
  }
}

function writeSessionCache(models: OpenRouterModel[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(models));
  } catch {
    /* quota — ignore */
  }
}

export async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  if (cache) return cache;
  if (!cache) {
    const session = readSessionCache();
    if (session) {
      cache = session;
      return session;
    }
  }
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await fetch(ENDPOINT, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`openrouter /models ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ id?: string; name?: string }> };
    const models: OpenRouterModel[] = (json.data ?? [])
      .filter((m): m is { id: string; name?: string } => typeof m?.id === 'string')
      .map((m) => ({ id: m.id, name: m.name }));
    cache = models;
    writeSessionCache(models);
    return models;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
