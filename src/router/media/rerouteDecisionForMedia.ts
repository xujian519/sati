import type { CanonicalModelRequest, ModelRuntime } from "../../model/index.js";
import type { RouterConfig } from "../config/schema.js";
import type { RouterDecision, RouterMutationsLog } from "../protocol/decision.js";
import { buildMediaRerouteCandidates, resolveMediaReroute } from "../utils/mediaReroute.js";
import { supportsMediaRequirements } from "./modelMediaSupport.js";

/**
 * 把媒体重路由的判定结果写回决策对象（`provider`/`model`/`resolvedFrom`）并登记
 * 一条 mutation。判定本身在 `utils/mediaReroute.ts` 的纯函数里，这里只是副作用
 * 外壳；`supports` 谓词按 `resolveMediaReroute` 的设计注入。
 */

export function rerouteDecisionForMedia(
  decision: RouterDecision,
  messages: CanonicalModelRequest["messages"],
  mutations: RouterMutationsLog,
  config: RouterConfig,
  modelRuntime: ModelRuntime,
): RouterMutationsLog {
  const result = resolveMediaReroute(
    { provider: decision.provider, model: decision.model },
    messages,
    buildMediaRerouteCandidates(config.fallback, decision.scenarioType),
    (ref, required) => supportsMediaRequirements(ref, required, modelRuntime),
  );

  if (result.status !== "routed") {
    return mutations;
  }

  decision.provider = result.to.provider;
  decision.model = result.to.model;
  decision.resolvedFrom = "fallback";
  return {
    ...mutations,
    mediaCapabilityRerouted: {
      required: result.required,
      from: result.from,
      to: result.to.id,
    },
  };
}
