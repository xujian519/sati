import type { CanonicalModelRequest, InputModality, ModelRuntime } from "../../model/index.js";
import { cloneMessages, downgradeUnsupportedContent, resolveModelInfo } from "../../model/index.js";
import type { RouterModelRef } from "../config/schema.js";
import { missingInputModalities } from "../utils/mediaRequirements.js";

/**
 * 「某个 provider/model 到底支不支持这几种输入模态」的唯一查询口。
 *
 * 从 `RouterRuntime` 闭包抽出（债务 #343 / TD-ROUTER-001）：这三个函数原本捕获
 * 闭包里的 `deps.modelRuntime`，无法脱离 runtime 实例单测。现在 `modelRuntime` 走
 * 显式入参，逐条可测；`decide`（媒体重路由）与 `execute`（候选分档 / 不支持媒体的
 * 降级重发）共用同一份实现，不再各写一遍。
 */

export function missingForModel(
  ref: RouterModelRef,
  required: readonly InputModality[],
  modelRuntime: ModelRuntime,
): InputModality[] {
  if (required.length === 0) {
    return [];
  }
  // 阶段四 T3：统一能力解析（config → catalog → 协议默认），未知模型不再
  // 被盲目当作 text-only——catalog 已声明的视觉模型可保留其媒体能力。
  return missingInputModalities(resolveModelInfo(modelRuntime, ref.provider, ref.model).multimodal, required);
}

export function supportsMediaRequirements(
  ref: RouterModelRef,
  required: readonly InputModality[],
  modelRuntime: ModelRuntime,
): boolean {
  return missingForModel(ref, required, modelRuntime).length === 0;
}

export function downgradeRequestForAttempt(
  request: CanonicalModelRequest,
  attempt: RouterModelRef,
  modelRuntime: ModelRuntime,
): CanonicalModelRequest {
  // 阶段四 T3：统一能力解析（config → catalog → 协议默认）。
  const multimodal = resolveModelInfo(modelRuntime, attempt.provider, attempt.model).multimodal;
  const messages = cloneMessages(request.messages);
  downgradeUnsupportedContent(messages, multimodal);
  return { ...request, messages };
}
