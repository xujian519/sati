import { authenticatedFetch } from '../utils/api';
import type { CatalogModel, CatalogProviderProtocol } from './catalogProviders';

export type ApiModelListItem = Pick<CatalogModel, 'id' | 'displayName'>;

function normalizeModelListItem(model: unknown): ApiModelListItem | null {
  if (!model || typeof model !== 'object') return null;
  const record = model as Record<string, unknown>;
  const id = typeof record.id === 'string'
    ? record.id.trim()
    : typeof record.name === 'string'
      ? record.name.replace(/^models\//, '').trim()
      : '';
  if (!id) return null;
  const displayName = typeof record.displayName === 'string' && record.displayName.trim()
    ? record.displayName.trim()
    : typeof record.display_name === 'string' && record.display_name.trim()
      ? record.display_name.trim()
      : id;
  return { id, displayName };
}

function normalizeModelList(models: unknown[]): ApiModelListItem[] {
  const seen = new Set<string>();
  const normalized: ApiModelListItem[] = [];
  for (const model of models) {
    const item = normalizeModelListItem(model);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    normalized.push(item);
  }
  return normalized;
}

export async function fetchRemoteDefaultModels(providerId: string): Promise<ApiModelListItem[]> {
  if (providerId !== 'openrouter') return [];
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `HTTP ${response.status}`;
      throw new Error(String(message));
    }
    const models = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    return normalizeModelList(models);
  } finally {
    window.clearTimeout(timer);
  }
}

export async function fetchProviderModels({
  protocol,
  baseUrl,
  apiKey,
  providerId,
}: {
  protocol: CatalogProviderProtocol;
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
}): Promise<ApiModelListItem[]> {
  const res = await authenticatedFetch('/api/config/models', {
    method: 'POST',
    body: JSON.stringify({
      providerType: protocol,
      baseUrl,
      apiKey,
      providerId,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || 'Failed to fetch model list.');
  }
  const models = Array.isArray(data?.models) ? data.models : [];
  return normalizeModelList(models);
}
