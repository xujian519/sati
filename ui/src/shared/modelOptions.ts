import { findCatalogProviderById, type CatalogProviderProtocol } from "./catalogProviders";
import { fetchProviderModels, type ApiModelListItem } from "./modelListApi";

export type ModelOption = {
  value: string;
  label: string;
  supportsImage?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从模型定义（provider.models[id]）提取用户声明的 multimodal.input（未声明时 undefined）。 */
function declaredMultimodalInput(modelDef: unknown): string[] | undefined {
  if (!isRecord(modelDef)) return undefined;
  const multimodal = modelDef.multimodal;
  if (!isRecord(multimodal)) return undefined;
  const input = multimodal.input;
  return Array.isArray(input) ? input.filter((s): s is string => typeof s === "string") : undefined;
}

/** 从自定义模型定义判断是否声明支持 image 输入。 */
function modelSupportsImage(modelDef: unknown): boolean {
  return declaredMultimodalInput(modelDef)?.includes("image") ?? false;
}

const KNOWN_PROTOCOLS: CatalogProviderProtocol[] = ["openai", "openai-responses", "anthropic", "google"];

/**
 * Build the model selector options for a single configured provider.
 * Catalog models (when the provider id matches the built-in catalog) plus
 * any custom models declared in `provider.models`. Labels use the catalog
 * display names and fall back to the raw `providerId/modelId` ref.
 */
function buildModelOptionsForProvider(pid: string, prov: Record<string, unknown>): ModelOption[] {
  const catalog = findCatalogProviderById(pid);
  const seen = new Set<string>();
  const out: ModelOption[] = [];

  if (catalog) {
    for (const catalogModel of catalog.models) {
      seen.add(catalogModel.id);
      // 用户在 provider.models 里声明的 multimodal 覆盖优先，否则用 catalog 手维护值。
      const userDeclared = isRecord(prov.models) ? declaredMultimodalInput(prov.models[catalogModel.id]) : undefined;
      const supportsImage = userDeclared !== undefined ? userDeclared.includes("image") : catalogModel.supportsImage;
      out.push({
        value: `${pid}/${catalogModel.id}`,
        label: `${catalog.displayName}: ${catalogModel.displayName}`,
        supportsImage,
      });
    }
  }

  // provider.models 必须是记录（键 → 模型配置）；数组（YAML 列表）无法
  // 推导模型 ref，跳过而非把索引当成模型名。
  if (isRecord(prov.models)) {
    for (const mid of Object.keys(prov.models)) {
      if (seen.has(mid)) continue;
      out.push({
        value: `${pid}/${mid}`,
        label: catalog ? `${catalog.displayName}: ${mid}` : `${pid}/${mid}`,
        supportsImage: modelSupportsImage(prov.models[mid]),
      });
    }
  }
  return out;
}

/**
 * Build the model selector options from a sati.yaml config shape.
 * Each configured provider contributes its catalog models (when the
 * provider id matches the built-in catalog) plus any custom models
 * declared in `provider.models`.
 *
 * Mirrors the engine-side resolution: options are `providerId/modelId`
 * refs, which is exactly what `agent.model` and router refs accept.
 *
 * This is the synchronous fallback used while the dynamic list loads and
 * when a provider's live model list can't be fetched.
 */
export function buildModelOptionsFromConfig(config: unknown): ModelOption[] {
  if (!isRecord(config)) return [];
  const model = config.model;
  if (!isRecord(model)) return [];
  const providers = model.providers;
  if (!isRecord(providers)) return [];

  const out: ModelOption[] = [];
  for (const [pid, prov] of Object.entries(providers)) {
    if (!isRecord(prov)) continue;
    out.push(...buildModelOptionsForProvider(pid, prov));
  }
  return out;
}

function normalizeProtocol(prov: Record<string, unknown>): CatalogProviderProtocol | null {
  const protocol = typeof prov.protocol === "string" ? prov.protocol : "";
  return KNOWN_PROTOCOLS.includes(protocol as CatalogProviderProtocol) ? (protocol as CatalogProviderProtocol) : null;
}

/**
 * Build model selector options with live model discovery: for each
 * configured provider, fetch the models actually available from its API
 * (`/api/config/models`; Ollama walks `/api/tags`), so the picker reflects
 * real availability instead of a hard-coded catalog snapshot.
 *
 * Merge policy per provider:
 *  - fetch succeeds → live models first, then any user-declared models
 *    (`provider.models`) that the live list didn't include;
 *  - fetch fails / no base URL / unknown protocol → catalog + declared
 *    models (the synchronous fallback), never blocking the picker.
 */
export async function buildModelOptionsFromConfigDynamic(
  config: unknown,
  options: { fetchModels?: typeof fetchProviderModels } = {},
): Promise<ModelOption[]> {
  if (!isRecord(config)) return [];
  const model = config.model;
  if (!isRecord(model)) return [];
  const providers = model.providers;
  if (!isRecord(providers)) return [];

  const entries = Object.entries(providers).filter(([, prov]) => isRecord(prov)) as Array<
    [string, Record<string, unknown>]
  >;
  const fetchModels = options.fetchModels ?? fetchProviderModels;

  const results = await Promise.all(
    entries.map(([pid, prov]) => {
      const protocol = normalizeProtocol(prov);
      const url = typeof prov.url === "string" ? prov.url.trim() : "";
      if (!protocol || !url) return Promise.resolve(null);
      return fetchModels({
        protocol,
        baseUrl: url,
        apiKey: typeof prov.apiKey === "string" ? prov.apiKey : "",
        providerId: pid,
      }).catch(() => null);
    }),
  );

  const out: ModelOption[] = [];
  entries.forEach(([pid, prov], index) => {
    const live = results[index];
    if (Array.isArray(live) && live.length > 0) {
      const catalog = findCatalogProviderById(pid);
      const displayName = catalog?.displayName ?? pid;
      const liveValues = new Set<string>();
      const liveOptions = live.map((m: ApiModelListItem) => {
        const value = `${pid}/${m.id}`;
        liveValues.add(value);
        const supportsImage = catalog?.models.find(cm => cm.id === m.id)?.supportsImage;
        return { value, label: `${displayName}: ${m.displayName}`, supportsImage };
      });
      // live 列表替换 catalog 写死模型；配置显式声明的模型（不在 live 中）保留
      out.push(...liveOptions);
      if (isRecord(prov.models)) {
        for (const mid of Object.keys(prov.models)) {
          const value = `${pid}/${mid}`;
          if (liveValues.has(value)) continue;
          out.push({
            value,
            label: catalog ? `${catalog.displayName}: ${mid}` : value,
            supportsImage: modelSupportsImage(prov.models[mid]),
          });
        }
      }
    } else {
      out.push(...buildModelOptionsForProvider(pid, prov));
    }
  });
  return out;
}
