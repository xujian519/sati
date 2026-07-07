import { authenticatedFetch } from '../utils/api';
import type { CatalogModel, CatalogProviderProtocol } from './catalogProviders';

export type ApiModelListItem = Pick<CatalogModel, 'id' | 'displayName'>;

export async function fetchProviderModels({
  protocol,
  baseUrl,
  apiKey,
  providerId,
}: {
  protocol: CatalogProviderProtocol;
  baseUrl: string;
  apiKey: string;
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
  return models
    .map((model: unknown) => {
      if (!model || typeof model !== 'object') return null;
      const record = model as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id.trim() : '';
      if (!id) return null;
      return {
        id,
        displayName: typeof record.displayName === 'string' && record.displayName.trim()
          ? record.displayName.trim()
          : id,
      };
    })
    .filter((model: ApiModelListItem | null): model is ApiModelListItem => Boolean(model));
}
