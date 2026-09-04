/**
 * 精确能力解析（阶段四 T3）。
 *
 * resolveModelInfo 是按「当前路由 → 模型」解析最终能力（capabilities +
 * multimodal）的唯一入口，解析顺序：
 *   1. config 声明（parse 期已合并 catalog + 用户覆盖）——source: config
 *   2. 内置 catalog（pass-through 模型未在 config 声明时的回退）——source: catalog
 *   3. provider 协议默认 / DEFAULT（未知 provider）——source: default
 * 显式省略即负能力：未知模型按 DEFAULT（input: [text]）处理，绝不猜测端点
 * 接受何种输入。与 dsh 的 resolveModelInfo 语义对应。
 */
import type { ModelCapabilities, ModelSpeed } from "./protocol/capabilities.js";
import { DEFAULT_MODEL_CAPABILITIES } from "./protocol/capabilities.js";
import type { MultimodalConstraints } from "./protocol/multimodal.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "./protocol/multimodal.js";
import { lookupCatalogModel } from "./catalog/lookup.js";
import { inferModelSpeed } from "./catalog/speedMapping.js";
import { ANTHROPIC_DEFAULT_MULTIMODAL } from "./providers/anthropic/defaults.js";
import { GOOGLE_DEFAULT_MULTIMODAL } from "./providers/google/defaults.js";
import { OPENAI_DEFAULT_MULTIMODAL } from "./providers/openai/defaults.js";
import type { ModelRuntime } from "./ModelRuntime.js";

/** 解析来源：config 声明 > 内置 catalog > provider 协议默认。 */
export type ModelInfoSource = "config" | "catalog" | "default";

/** 一次能力解析的结果：最终能力 + 来源标注。 */
export type ResolvedModelInfo = {
  capabilities: ModelCapabilities;
  multimodal: MultimodalConstraints;
  /** 速度档（catalog 显式覆盖 > 命名规则推断；模型固有属性，与配置无关）。 */
  speed: ModelSpeed;
  /** 命中哪一层（诊断与审计用）。 */
  source: ModelInfoSource;
};

/**
 * 解析一个 provider/model 的最终能力。config 声明优先；未知模型回退 catalog；
 * 再回退 provider 协议默认。解析过程不抛错——能力查询是纯查询，调用方按结果
 * 决策（如模态门禁），而非按异常分支。
 *
 * @param runtime - 提供 config 层能力查询的 runtime（getMultimodal/getCapabilities）。
 * @param providerId - 目标 provider。
 * @param modelId - 目标 model。
 * @returns 最终能力与来源。
 */
export function resolveModelInfo(
  runtime: Pick<ModelRuntime, "getCapabilities" | "getMultimodal" | "getProviderProtocol">,
  providerId: string,
  modelId: string,
): ResolvedModelInfo {
  try {
    return {
      capabilities: runtime.getCapabilities(providerId, modelId),
      multimodal: runtime.getMultimodal(providerId, modelId),
      speed: catalogModelSpeed(providerId, modelId),
      source: "config",
    };
  } catch {
    // config 未声明该模型：继续 catalog / 默认。
  }
  const catalog = lookupCatalogModel(providerId, modelId);
  if (catalog.model !== undefined) {
    return {
      capabilities: catalog.model.capabilities,
      multimodal: catalog.model.multimodal,
      speed: catalogModelSpeed(providerId, modelId),
      source: "catalog",
    };
  }
  const protocol = runtime.getProviderProtocol(providerId);
  const multimodal = protocolDefaultMultimodal(protocol);
  return {
    capabilities: DEFAULT_MODEL_CAPABILITIES,
    multimodal,
    speed: inferModelSpeed(modelId),
    source: "default",
  };
}

/** catalog 条目显式 speed 优先，否则按命名规则推断。 */
function catalogModelSpeed(providerId: string, modelId: string): ModelSpeed {
  const catalog = lookupCatalogModel(providerId, modelId);
  return inferModelSpeed(modelId, catalog.model?.speed);
}

/** provider 协议 → 该协议默认多模态约束（未知协议回退 text-only）。 */
function protocolDefaultMultimodal(protocol: string | undefined): MultimodalConstraints {
  switch (protocol) {
    case "anthropic":
      return ANTHROPIC_DEFAULT_MULTIMODAL;
    case "google":
      return GOOGLE_DEFAULT_MULTIMODAL;
    case "openai":
    case "openai-responses":
      return OPENAI_DEFAULT_MULTIMODAL;
    default:
      return DEFAULT_MULTIMODAL_CONSTRAINTS;
  }
}
