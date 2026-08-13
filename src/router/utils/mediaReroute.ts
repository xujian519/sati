import type { CanonicalModelRequest } from "../../model/protocol/canonical.js";
import type { InputModality } from "../../model/protocol/multimodal.js";
import type { RouterFallbackConfig, RouterModelRef } from "../config/schema.js";
import type { RouterScenarioType } from "../protocol/decision.js";
import { collectRequiredInputModalities } from "./mediaRequirements.js";

/**
 * 媒体重路由决策（纯函数，从 RouterRuntime 闭包提取以便单测）。
 *
 * 判定含图/PDF/音频等媒体块的请求，是否应把决策选中的模型替换为
 * 支持该媒体的候选。`supports` 由调用方注入（RouterRuntime 用
 * getMultimodal 实现），候选列表由调用方按场景解析（fallback 链）。
 */
export type MediaRerouteResult =
  | { status: "no_media" }
  | { status: "already_supports" }
  | { status: "no_candidate"; required: InputModality[] }
  | { status: "routed"; required: InputModality[]; from: string; to: RouterModelRef };

export function resolveMediaReroute(
  selected: { provider: string; model: string },
  messages: CanonicalModelRequest["messages"],
  candidates: RouterModelRef[],
  supports: (ref: RouterModelRef, required: readonly InputModality[]) => boolean,
): MediaRerouteResult {
  const required = collectRequiredInputModalities(messages);
  if (required.length === 0) {
    return { status: "no_media" };
  }

  const selectedRef: RouterModelRef = {
    id: `${selected.provider}/${selected.model}`,
    provider: selected.provider,
    model: selected.model,
  };
  if (supports(selectedRef, required)) {
    return { status: "already_supports" };
  }

  const replacement = candidates.find(ref => supports(ref, required));
  if (!replacement) {
    return { status: "no_candidate", required: [...required] };
  }

  return {
    status: "routed",
    required: [...required],
    from: selectedRef.id,
    to: replacement,
  };
}

/**
 * 媒体重路由的候选列表（纯函数，从 RouterRuntime 闭包提取以便单测）。
 *
 * 顺序即优先级：media（跨场景多模态候选）> 场景键 > default。
 * 去重按 provider+model 维度，与 RouterRuntime 原有语义一致。
 * 注意：此列表仅用于媒体升级，故障降级走 runFallbackChain.ts 的 planFallback，
 * 不经过本函数——media 键因此天然不进故障链。
 */
export function buildMediaRerouteCandidates(
  fallback: RouterFallbackConfig | undefined,
  scenarioType: RouterScenarioType,
): RouterModelRef[] {
  const candidates: RouterModelRef[] = [];
  const add = (refs: RouterModelRef[] | undefined) => {
    for (const ref of refs ?? []) {
      const id = ref.id || `${ref.provider}/${ref.model}`;
      if (!candidates.some(candidate => candidate.provider === ref.provider && candidate.model === ref.model)) {
        candidates.push({ ...ref, id });
      }
    }
  };
  add(fallback?.media);
  add(fallback?.[scenarioType]);
  add(fallback?.default);
  return candidates;
}
