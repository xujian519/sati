import { useEffect, useMemo, useState } from "react";
import { buildModelOptionsFromConfig, buildModelOptionsFromConfigDynamic, type ModelOption } from "./modelOptions";

/**
 * Provider 集合签名：pid + url + 已声明模型数。仅当配置的 provider 集合
 * 变化时才重新拉取实时模型列表——编辑模型参数等不触发重复请求。
 */
function providerSignature(config: unknown): string {
  if (!config || typeof config !== "object") return "";
  const model = (config as Record<string, unknown>).model;
  if (!model || typeof model !== "object") return "";
  const providers = (model as Record<string, unknown>).providers;
  if (!providers || typeof providers !== "object") return "";
  return Object.entries(providers as Record<string, unknown>)
    .map(([pid, prov]) => {
      const p = prov && typeof prov === "object" ? (prov as Record<string, unknown>) : {};
      const declared =
        p.models && typeof p.models === "object" ? Object.keys(p.models as Record<string, unknown>).length : 0;
      return `${pid}:${typeof p.url === "string" ? p.url : ""}:${declared}`;
    })
    .sort()
    .join("|");
}

/**
 * 模型选择器选项：初始为同步的 catalog + 配置显式列表，随后异步合并各
 * provider 实时可用的模型（/api/config/models，Ollama 走 /api/tags）。
 * 拉取失败时保持同步兜底列表，不阻塞 UI。
 */
export function useDynamicModelOptions(config: unknown): ModelOption[] {
  const [options, setOptions] = useState<ModelOption[]>(() => buildModelOptionsFromConfig(config));
  const signature = useMemo(() => providerSignature(config), [config]);

  useEffect(() => {
    let cancelled = false;
    buildModelOptionsFromConfigDynamic(config)
      .then(next => {
        if (!cancelled) setOptions(next);
      })
      .catch(() => {
        /* 拉取失败：保持同步兜底选项 */
      });
    return () => {
      cancelled = true;
    };
    // config 作为闭包读取；仅当 provider 集合（signature）变化时重拉，
    // 编辑模型参数等局部变更不应反复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return options;
}
