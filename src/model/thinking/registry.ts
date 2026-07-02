import type { CanonicalThinkingConfig, ModelDefinition, ProviderConfig } from "../protocol/canonical.js";

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
  useExtraBody?: boolean;
  useAnthropicOutputEffort?: boolean;
  omitTemperature?: boolean;
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

export function normalizeThinkingMode(thinking?: CanonicalThinkingConfig): ThinkingMode {
  if (!thinking) return "default";
  if (thinking.mode) return thinking.mode;
  if (thinking.enabled === false) return "off";
  if (thinking.enabled === true) return "medium";
  return "default";
}

export function resolveThinkingPlan(
  requestThinking: CanonicalThinkingConfig | undefined,
  provider: ProviderConfig,
  model: ModelDefinition,
): ThinkingPlan {
  const requestedMode = normalizeThinkingMode(requestThinking);
  const providerId = provider.id.toLowerCase();
  const providerUrl = (provider.url ?? "").toLowerCase();
  const modelId = model.id.toLowerCase();
  const enabledByLegacy = requestThinking?.enabled === true && requestedMode === "default";
  const mode = enabledByLegacy ? "medium" : requestedMode;

  if (mode === "default") {
    return { mode, enabled: false };
  }

  const budgetTokens = typeof requestThinking?.budgetTokens === "number" && Number.isFinite(requestThinking.budgetTokens)
    ? requestThinking.budgetTokens
    : undefined;
  const isOff = mode === "off";

  if (provider.protocol === "openai-responses" || isOpenAIProvider(providerId, providerUrl)) {
    return openAIPlan(mode, modelId);
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
    return qwenPlan(mode, modelId, budgetTokens);
  }
  if (/deepseek/.test(providerId + providerUrl + modelId)) {
    return deepSeekPlan(mode, modelId);
  }
  if (/kimi|moonshot/.test(providerId + providerUrl + modelId)) {
    return kimiPlan(mode, modelId);
  }
  if (/minimax/.test(providerId + providerUrl + modelId)) {
    return minimaxPlan(mode);
  }

  if (model.capabilities.supportsThinking && !isOff) {
    return { mode, enabled: true, budgetTokens };
  }
  return { mode, enabled: false };
}

function isOpenAIProvider(providerId: string, providerUrl: string): boolean {
  return /(^|[^a-z])openai([^a-z]|$)|api\.openai\.com/.test(providerId + " " + providerUrl);
}

function openAIPlan(mode: ThinkingMode, modelId: string): ThinkingPlan {
  if (mode === "off") {
    return modelId.includes("gpt-5.5")
      ? { mode, enabled: true, effort: "none", useOpenAIReasoning: true }
      : { mode, enabled: false };
  }
  if (modelId.includes("gpt-5.5-pro")) {
    return { mode, enabled: true, effort: clampEffort(mode, ["medium", "high", "xhigh"]), useOpenAIReasoning: true };
  }
  if (modelId.includes("gpt-5.5")) {
    return { mode, enabled: true, effort: clampEffort(mode, ["none", "low", "medium", "high", "xhigh"]), useOpenAIReasoning: true };
  }
  if (modelId.includes("gpt-5")) {
    return { mode, enabled: true, effort: clampEffort(mode, ["minimal", "low", "medium", "high"]), useOpenAIReasoning: true };
  }
  return { mode, enabled: false };
}

function anthropicPlan(mode: ThinkingMode, modelId: string, budgetTokens?: number): ThinkingPlan {
  if (mode === "off") return { mode, enabled: false };
  if (/opus-4\.8|opus-4\.7|sonnet-5|claude-.*(4\.8|4\.7|5)/.test(modelId)) {
    return {
      mode,
      enabled: true,
      thinkingType: "adaptive",
      effort: clampEffort(mode, ["low", "medium", "high", "xhigh"]),
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
    return { mode, enabled: true, budgetTokens: budgetTokens ?? GEMINI_25_BUDGETS[mode] ?? 8192, useGeminiBudget: true };
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

function qwenPlan(mode: ThinkingMode, modelId: string, budgetTokens?: number): ThinkingPlan {
  const thinkingOnly = /thinking|qwq|qvq/.test(modelId) && !/hybrid/.test(modelId);
  if (mode === "off" && thinkingOnly) return { mode, enabled: true, useExtraBody: true };
  if (mode === "off") return { mode, enabled: false, useExtraBody: true };
  return {
    mode,
    enabled: true,
    budgetTokens: budgetTokens ?? QWEN_BUDGETS[mode] ?? 8192,
    preserve: true,
    useExtraBody: true,
  };
}

function deepSeekPlan(mode: ThinkingMode, _modelId: string): ThinkingPlan {
  if (mode === "off" || mode === "minimal") {
    return { mode, enabled: false, thinkingType: "disabled", useExtraBody: true, preserve: true };
  }
  return {
    mode,
    enabled: true,
    thinkingType: "enabled",
    effort: mode === "xhigh" || mode === "max" ? "max" : "high",
    preserve: true,
    useExtraBody: true,
  };
}

function kimiPlan(mode: ThinkingMode, _modelId: string): ThinkingPlan {
  if (mode === "off") {
    return { mode, enabled: false, thinkingType: "disabled", preserve: true, useOpenAICompatibleThinking: true, omitTemperature: true };
  }
  return { mode, enabled: mode !== "default", preserve: true, useOpenAICompatibleThinking: false, omitTemperature: true };
}

function minimaxPlan(mode: ThinkingMode): ThinkingPlan {
  if (mode === "off" || mode === "default") return { mode, enabled: false };
  return { mode, enabled: true, splitReasoning: true };
}

function clampEffort(mode: ThinkingMode, allowed: ThinkingPlan["effort"][]): NonNullable<ThinkingPlan["effort"]> {
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
