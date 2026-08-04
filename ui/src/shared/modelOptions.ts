import { findCatalogProviderById } from "./catalogProviders";

export type ModelOption = {
  value: string;
  label: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build the model selector options from a sati.yaml config shape.
 * Each configured provider contributes its catalog models (when the
 * provider id matches the built-in catalog) plus any custom models
 * declared in `provider.models`. Labels use the catalog display names
 * and fall back to the raw `providerId/modelId` ref.
 *
 * Mirrors the engine-side resolution: options are `providerId/modelId`
 * refs, which is exactly what `agent.model` and router refs accept.
 */
export function buildModelOptionsFromConfig(config: unknown): ModelOption[] {
  const out: ModelOption[] = [];
  if (!isRecord(config)) return out;
  const model = config.model;
  if (!isRecord(model)) return out;
  const providers = model.providers;
  if (!isRecord(providers)) return out;

  for (const [pid, prov] of Object.entries(providers)) {
    if (!isRecord(prov)) continue;
    const catalog = findCatalogProviderById(pid);
    const seen = new Set<string>();

    if (catalog) {
      for (const catalogModel of catalog.models) {
        seen.add(catalogModel.id);
        out.push({
          value: `${pid}/${catalogModel.id}`,
          label: `${catalog.displayName}: ${catalogModel.displayName}`,
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
        });
      }
    }
  }
  return out;
}
