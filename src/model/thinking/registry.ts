import type {
  CanonicalModelRequest,
  CanonicalThinkingConfig,
  ModelDefinition,
  ProviderConfig,
} from "../protocol/canonical.js";
import { ModelRequestError } from "../protocol/errors.js";

export type ThinkingMode = NonNullable<CanonicalThinkingConfig["mode"]>;

export type ThinkingPlan = {
  mode: ThinkingMode;
  enabled: boolean;
  budgetTokens?: number;
  preserve?: boolean;
  splitReasoning?: boolean;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  thinkingType?: "enabled" | "disabled" | "adaptive";
  thinkingLevel?: "low" | "medium" | "high";
  useGeminiBudget?: boolean;
  useGeminiLevel?: boolean;
  useOpenAIReasoning?: boolean;
  useOpenAICompatibleThinking?: boolean;
  bodyPatch?: Record<string, unknown>;
  useAnthropicOutputEffort?: boolean;
  omitTemperature?: boolean;
  unsupportedReason?: string;
};

const GEMINI_25_BUDGETS: Partial<Record<ThinkingMode, number>> = {
  minimal: 1024,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 24576,
  max: 24576,
};

const QWEN_BUDGETS: Partial<Record<ThinkingMode, number>> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 24576,
  xhigh: 38912,
  max: 38912,
};

/**
 * 推理模型（reasoning-only）白名单：官方约束 temperature 不可修改
 * （kimi-k3/k2.7-code 固定 1.0、kimi-k2.6 思考 1.0/非思考 0.6，传其他值报错；
 * deepseek-v4 思考模式下 temperature 被静默忽略）。统一省略显式温度。
 * 仅对白名单内模型省略，避免误伤可接受 temperature 的非推理模型
 * （如 deepseek-chat 温度范围 0-2）。
 */
function isReasoningOnlyModel(modelId: string): boolean {
  return /deepseek-v4|deepseek-reasoner|kimi-k2|kimi-k3/.test(modelId.toLowerCase());
}

export function normalizeThinkingMode(thinking?: CanonicalThinkingConfig): ThinkingMode {
  if (!thinking) return "default";
  if (thinking.mode) return thinking.mode;
  if (thinking.enabled === true) return "medium";
  return "default";
}

export function resolveThinkingPlan(
  requestThinking: CanonicalThinkingConfig | undefined,
  provider: ProviderConfig,
  model: ModelDefinition,
): ThinkingPlan {
  const requestedMode = normalizeThinkingMode(requestThinking);
  const explicitMode = requestThinking?.mode !== undefined;
  const providerId = provider.id.toLowerCase();
  const providerUrl = (provider.url ?? "").toLowerCase();
  const modelId = model.id.toLowerCase();
  const enabledByLegacy = requestThinking?.enabled === true && requestedMode === "default";
  const mode = enabledByLegacy ? "medium" : requestedMode;

  if (mode === "default") {
    // 推理模型官方约束 temperature 不可修改（kimi 传其他值报错、deepseek-v4
    // 思考模式静默忽略），default 模式下仍须省略显式 temperature，否则带
    // temperature 的调用（如 session-title 的 temperature: 0）会报错。
    // 只按 modelId 白名单判断，避免误伤 provider 名含 "deepseek" 的非推理模型。
    const reasoningOnly = isReasoningOnlyModel(modelId);
    const omitTemperature = reasoningOnly ? { omitTemperature: true } : {};
    // deepseek-v4 官方默认开启思考（thinking 默认 enabled）；default 若不显式传
    // `thinking:{type:"disabled"}`，长输出会把最终 content 榨干为 0（reasoning_content
    // 与 content 共享 max_tokens）。default（未显式请求思考）应显式关闭，而非交模型默认。
    if (/deepseek-v4/.test(modelId)) {
      return { mode, enabled: false, thinkingType: "disabled", useOpenAICompatibleThinking: true, ...omitTemperature };
    }
    return { mode, enabled: false, ...omitTemperature };
  }

  const budgetTokens =
    typeof requestThinking?.budgetTokens === "number" && Number.isFinite(requestThinking.budgetTokens)
      ? requestThinking.budgetTokens
      : undefined;
  const explicitlyUnsupported =
    (model.capabilities as { supportsThinkingExplicit?: boolean }).supportsThinkingExplicit === false;

  if (explicitMode && explicitlyUnsupported) {
    return {
      mode,
      enabled: false,
      unsupportedReason: `Model ${model.id} does not support thinking mode '${mode}'. Switch thinking strength back to Default.`,
    };
  }

  if (provider.protocol === "openai-responses" || isOpenAIProvider(providerId, providerUrl)) {
    return openAIPlan(mode, modelId, isOpenAIProvider(providerId, providerUrl));
  }
  if (provider.protocol === "anthropic" || /anthropic|claude/.test(providerId + providerUrl + modelId)) {
    return anthropicPlan(mode, modelId, budgetTokens);
  }
  if (provider.protocol === "google" || /google|gemini|generativelanguage/.test(providerId + providerUrl + modelId)) {
    return googlePlan(mode, modelId, budgetTokens);
  }
  if (/zhipu|bigmodel|z\.ai|z-ai|glm/.test(providerId + providerUrl + modelId)) {
    return glmPlan(mode, modelId);
  }
  if (/qwen|dashscope|aliyun|alibaba|tongyi/.test(providerId + providerUrl + modelId)) {
    return qwenPlan(mode, modelId, providerUrl, budgetTokens);
  }
  if (/deepseek/.test(providerId + providerUrl + modelId)) {
    return deepSeekPlan(mode, modelId);
  }
  if (/kimi|moonshot/.test(providerId + providerUrl + modelId)) {
    return kimiPlan(mode, modelId);
  }
  if (/minimax/.test(providerId + providerUrl + modelId)) {
    return minimaxPlan(mode, modelId);
  }

  if (explicitMode) {
    return genericThinkingPlan(mode, budgetTokens);
  }
  return { mode, enabled: false };
}

export function throwIfUnsupportedThinkingPlan(plan: ThinkingPlan, request: CanonicalModelRequest): void {
  if (!plan.unsupportedReason) return;
  throw new ModelRequestError("unsupported_thinking", plan.unsupportedReason, {
    provider: request.provider,
    model: request.model,
    thinkingMode: plan.mode,
  });
}

function isOpenAIProvider(providerId: string, providerUrl: string): boolean {
  return /(^|[^a-z])openai([^a-z]|$)|api\.openai\.com/.test(providerId + " " + providerUrl);
}

function genericThinkingPlan(mode: ThinkingMode, budgetTokens?: number): ThinkingPlan {
  if (mode === "off") return { mode, enabled: false, bodyPatch: { enable_thinking: false } };
  return {
    mode,
    enabled: true,
    budgetTokens: budgetTokens ?? QWEN_BUDGETS[mode] ?? effortBudget(mode),
    bodyPatch: {
      enable_thinking: true,
      thinking_budget: budgetTokens ?? QWEN_BUDGETS[mode] ?? effortBudget(mode),
    },
  };
}

function openAIPlan(mode: ThinkingMode, modelId: string, officialOpenAIProvider: boolean): ThinkingPlan {
  if (mode === "off") {
    return /gpt-5\.[56]/.test(modelId)
      ? { mode, enabled: true, effort: "none", useOpenAIReasoning: true }
      : {
          mode,
          enabled: false,
          unsupportedReason: `OpenAI model ${modelId} does not support an explicit off thinking mode. Switch thinking strength back to Default.`,
        };
  }
  if (modelId.includes("gpt-5.5-pro")) {
    return {
      mode,
      enabled: true,
      effort: clampEffort(mode, ["medium", "high", "xhigh", "max"]),
      useOpenAIReasoning: true,
    };
  }
  if (modelId.includes("gpt-5.6")) {
    return {
      mode,
      enabled: true,
      effort: clampEffort(mode, ["none", "low", "medium", "high", "xhigh", "max"]),
      useOpenAIReasoning: true,
    };
  }
  if (modelId.includes("gpt-5.5")) {
    return {
      mode,
      enabled: true,
      effort: clampEffort(mode, ["none", "low", "medium", "high", "xhigh", "max"]),
      useOpenAIReasoning: true,
    };
  }
  if (modelId.includes("gpt-5")) {
    return {
      mode,
      enabled: true,
      effort: clampEffort(mode, ["none", "low", "medium", "high"]),
      useOpenAIReasoning: true,
    };
  }
  if (/^(?:o1|o3|o4)(?:\b|[-_])/.test(modelId)) {
    return { mode, enabled: true, effort: clampEffort(mode, ["low", "medium", "high"]), useOpenAIReasoning: true };
  }
  if (officialOpenAIProvider && modelId.startsWith("gpt")) {
    return {
      mode,
      enabled: false,
      unsupportedReason: `OpenAI-compatible model ${modelId} does not advertise a known thinking mode adapter. Switch thinking strength back to Default.`,
    };
  }
  return genericThinkingPlan(mode);
}

function anthropicPlan(mode: ThinkingMode, modelId: string, budgetTokens?: number): ThinkingPlan {
  if (mode === "off") return { mode, enabled: false };
  if (/opus-4\.6|opus-4\.7|opus-4\.8|opus-5|sonnet-4\.6|sonnet-5|fable-5|mythos-5/.test(modelId)) {
    return {
      mode,
      enabled: true,
      thinkingType: "adaptive",
      effort: clampEffort(mode, ["low", "medium", "high", "max"]),
      useAnthropicOutputEffort: true,
    };
  }
  return { mode, enabled: true, thinkingType: "enabled", budgetTokens: budgetTokens ?? effortBudget(mode) };
}

function googlePlan(mode: ThinkingMode, modelId: string, budgetTokens?: number): ThinkingPlan {
  if (/gemini-?3|gemini.*3\./.test(modelId)) {
    if (mode === "off") return { mode, enabled: false };
    return { mode, enabled: true, thinkingLevel: clampLevel(mode), useGeminiLevel: true };
  }
  if (/gemini-?2\.5|gemini.*2\.5/.test(modelId)) {
    if (mode === "off") return { mode, enabled: true, budgetTokens: 0, useGeminiBudget: true };
    return {
      mode,
      enabled: true,
      budgetTokens: budgetTokens ?? GEMINI_25_BUDGETS[mode] ?? 8192,
      useGeminiBudget: true,
    };
  }
  if (mode === "off") return { mode, enabled: false };
  return { mode, enabled: true, budgetTokens, useGeminiBudget: true };
}

function glmPlan(mode: ThinkingMode, modelId: string): ThinkingPlan {
  if (mode === "off" || mode === "minimal") {
    return { mode, enabled: false, thinkingType: "disabled", useOpenAICompatibleThinking: true };
  }
  const plan: ThinkingPlan = { mode, enabled: true, thinkingType: "enabled", useOpenAICompatibleThinking: true };
  if (/glm-?5\.2|glm.*5\.2/.test(modelId)) {
    plan.effort = mode === "xhigh" || mode === "max" ? "max" : "high";
  }
  return plan;
}

function qwenPlan(mode: ThinkingMode, modelId: string, providerUrl: string, budgetTokens?: number): ThinkingPlan {
  const isAliLlmCenter = providerUrl.includes("llm-center.ali.modelbest.cn") || /^qwen_/.test(modelId);
  if (isAliLlmCenter) {
    if (mode === "off") {
      return { mode, enabled: false, thinkingType: "disabled", useOpenAICompatibleThinking: true, preserve: true };
    }
    return {
      mode,
      enabled: true,
      thinkingType: "enabled",
      effort: clampEffort(mode, ["minimal", "low", "medium", "high", "xhigh"]),
      useOpenAICompatibleThinking: true,
      preserve: true,
    };
  }
  const thinkingOnly = /thinking|qwq|qvq/.test(modelId) && !/hybrid/.test(modelId);
  if (mode === "off" && thinkingOnly) return { mode, enabled: false };
  if (mode === "off") return { mode, enabled: false, bodyPatch: { enable_thinking: false } };
  return {
    mode,
    enabled: true,
    budgetTokens: budgetTokens ?? QWEN_BUDGETS[mode] ?? 8192,
    preserve: true,
    bodyPatch: {
      enable_thinking: true,
      thinking_budget: budgetTokens ?? QWEN_BUDGETS[mode] ?? 8192,
    },
  };
}

function deepSeekPlan(mode: ThinkingMode, modelId: string): ThinkingPlan {
  const isAliLlmCenter = /^deepseek_/.test(modelId);
  // deepseek-reasoner 为始终思考的旧模型，不支持关闭思考（与 kimi-k3 处理一致）。
  const alwaysThinking = /deepseek-reasoner/.test(modelId);
  if (mode === "off") {
    if (alwaysThinking) {
      return {
        mode,
        enabled: false,
        unsupportedReason: `Model ${modelId} always thinks and does not support an explicit off thinking mode. Switch thinking strength back to Default.`,
      };
    }
    return {
      mode,
      enabled: false,
      thinkingType: "disabled",
      useOpenAICompatibleThinking: true,
      preserve: true,
      // 仅推理模型（v4/reasoner）省略显式温度；deepseek-chat 等接受 0-2。
      ...(isReasoningOnlyModel(modelId) ? { omitTemperature: true } : {}),
    };
  }
  if (isAliLlmCenter) {
    return {
      mode,
      enabled: true,
      thinkingType: "enabled",
      useOpenAICompatibleThinking: true,
      preserve: true,
      ...(isReasoningOnlyModel(modelId) ? { omitTemperature: true } : {}),
    };
  }
  // 官方 v4（文档 2026-08 thinking_mode）：reasoning_effort 仅 low/high/max 三档，
  // flash 与 pro 的 effort 映射完全一致（low→low, medium→high, high→high, xhigh→high, max→max）。
  // 旧模型（deepseek-chat 等）保持 high/max 两档语义，避免对旧 API 发送 low。
  const allowedEffort: ThinkingPlan["effort"][] = /deepseek-v4/.test(modelId)
    ? ["low", "high", "max"]
    : ["high", "max"];
  // medium 按官方映射到 high；xhigh/max 取最高档 max，其余 clamp。
  let effort: NonNullable<ThinkingPlan["effort"]>;
  if (mode === "xhigh" || mode === "max") {
    effort = "max";
  } else if (mode === "medium") {
    effort = "high";
  } else {
    effort = clampEffort(mode, allowedEffort);
  }
  return {
    mode,
    enabled: true,
    thinkingType: "enabled",
    effort,
    preserve: true,
    useOpenAICompatibleThinking: true,
    ...(isReasoningOnlyModel(modelId) ? { omitTemperature: true } : {}),
  };
}

function kimiPlan(mode: ThinkingMode, modelId: string): ThinkingPlan {
  // kimi-k3 / kimi-k2.7-code(-highspeed) 为始终思考（always-thinking）模型，
  // 官方不支持关闭思考；其中仅 kimi-k3 支持顶层 reasoning_effort
  // （low/high/max，默认 max），kimi-k2.7-code 系列不支持 reasoning_effort
  // （官方 models-overview：reasoning_effort 仅 kimi-k3 支持）。
  const isK3 = /kimi-k3/.test(modelId);
  const alwaysThinking = /kimi-k3|kimi-k2\.7-code/.test(modelId);
  if (alwaysThinking) {
    if (mode === "off") {
      return {
        mode,
        enabled: false,
        unsupportedReason: `Model ${modelId} always thinks and does not support an explicit off thinking mode. Switch thinking strength back to Default or use kimi-k2.6.`,
      };
    }
    const plan: ThinkingPlan = { mode, enabled: true, omitTemperature: true };
    if (isK3) {
      // k3 官方仅 low/high/max 三档；medium 就近取 high（与 DeepSeek 官方映射一致）。
      let effort: NonNullable<ThinkingPlan["effort"]>;
      if (mode === "xhigh" || mode === "max") {
        effort = "max";
      } else if (mode === "medium") {
        effort = "high";
      } else {
        effort = clampEffort(mode, ["low", "high", "max"]);
      }
      plan.effort = effort;
      plan.bodyPatch = { reasoning_effort: effort };
    }
    return plan;
  }
  if (mode === "off") {
    return {
      mode,
      enabled: false,
      thinkingType: "disabled",
      preserve: true,
      useOpenAICompatibleThinking: true,
      // 仅推理模型（k2.6/k3 等）省略显式温度；kimi-moonshot-v1 等旧模型接受 0-2。
      ...(isReasoningOnlyModel(modelId) ? { omitTemperature: true } : {}),
    };
  }
  return {
    mode,
    enabled: mode !== "default",
    preserve: true,
    useOpenAICompatibleThinking: false,
    ...(isReasoningOnlyModel(modelId) ? { omitTemperature: true } : {}),
  };
}

function minimaxPlan(mode: ThinkingMode, modelId: string): ThinkingPlan {
  // M3 支持 thinking: {type: "adaptive"|"disabled"}；M2.x 思考无法关闭（无用户
  // 可控开关），显式 off 必须拒绝，不得发送 thinking.type=disabled（否则 400）。
  const isM2x = /^minimax-m2(\.|-|$)/.test(modelId);
  if (mode === "off") {
    if (isM2x) {
      return {
        mode,
        enabled: false,
        unsupportedReason: `Model ${modelId} always thinks and does not support an explicit off thinking mode. Switch thinking strength back to Default.`,
      };
    }
    return { mode, enabled: false, thinkingType: "disabled", useOpenAICompatibleThinking: true };
  }
  if (mode === "default") return { mode, enabled: false };
  return { mode, enabled: true, splitReasoning: true };
}

function clampEffort(mode: ThinkingMode, allowed: ThinkingPlan["effort"][]): NonNullable<ThinkingPlan["effort"]> {
  if (mode === "max" && allowed.includes("max")) {
    return "max";
  }
  const normalized = mode === "max" ? "xhigh" : mode;
  if (allowed.includes(normalized as ThinkingPlan["effort"])) {
    return normalized as NonNullable<ThinkingPlan["effort"]>;
  }
  const rank: Record<string, number> = { none: 0, off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };
  const requested = rank[mode] ?? 3;
  let best = allowed[0] as NonNullable<ThinkingPlan["effort"]>;
  let bestDistance = Infinity;
  for (const effort of allowed) {
    if (!effort) continue;
    const distance = Math.abs((rank[effort] ?? 3) - requested);
    if (distance < bestDistance) {
      best = effort;
      bestDistance = distance;
    }
  }
  return best;
}

function clampLevel(mode: ThinkingMode): "low" | "medium" | "high" {
  if (mode === "minimal" || mode === "low") return "low";
  if (mode === "high" || mode === "xhigh" || mode === "max") return "high";
  return "medium";
}

function effortBudget(mode: ThinkingMode): number {
  if (mode === "minimal" || mode === "low") return 1024;
  if (mode === "high") return 8192;
  if (mode === "xhigh" || mode === "max") return 16000;
  return 4096;
}
