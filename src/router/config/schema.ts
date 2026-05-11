import type { ModelConfig } from "../../model/index.js";
import type { RouterScenarioType } from "../protocol/decision.js";

export type RouterModelRef = {
  /** Original "provider/model" string. */
  id: string;
  provider: string;
  model: string;
};

export type RouterScenariosConfig = {
  default: RouterModelRef;
};

export type RouterTierConfig = {
  model: RouterModelRef;
  description?: string;
};

export type RouterTokenSaverSubagentPolicy = "skip" | "judge";

export const DEFAULT_SUBAGENT_POLICY: RouterTokenSaverSubagentPolicy = "judge";

export type RouterTokenSaverConfig = {
  enabled: boolean;
  judge: RouterModelRef;
  defaultTier: string;
  tiers: Record<string, RouterTierConfig>;
  rules?: string[];
  subagent?: {
    policy: RouterTokenSaverSubagentPolicy;
  };
  judgeTimeoutMs: number;
};

export type RouterAutoOrchestrateConfig = {
  enabled: boolean;
  mainAgentModel?: RouterModelRef;
  skillExtensionId?: string;
  triggerTiers: string[];
  /** Whitelist — only these tools are kept for the orchestrator. Takes precedence over blockedTools. */
  allowedTools?: string[];
  /** Blacklist — these tools are removed. Ignored when allowedTools is set. */
  blockedTools?: string[];
  slimSystemPrompt: boolean;
  subagentMaxTokens?: number;
};

export const DEFAULT_SUBAGENT_MAX_TOKENS = 48000;

export type RouterStatsConfig = {
  enabled: boolean;
  modelPricing?: Record<string, { input?: number; output?: number; cacheRead?: number }>;
  /** Override the default ~/.pilotdeck/router-stats.json path (useful for tests). */
  filePath?: string;
};

export type RouterFallbackConfig = Partial<Record<RouterScenarioType, RouterModelRef[]>>;

export type RouterCustomRouterConfig = {
  extensionId: string;
};

export type RouterConfig = {
  scenarios: RouterScenariosConfig;
  fallback?: RouterFallbackConfig;
  zeroUsageRetry?: { enabled: boolean; maxAttempts: number };
  tokenSaver?: RouterTokenSaverConfig;
  autoOrchestrate?: RouterAutoOrchestrateConfig;
  stats?: RouterStatsConfig;
  customRouter?: RouterCustomRouterConfig;
};

export const DEFAULT_JUDGE_TIMEOUT_MS = 5000;
export const DEFAULT_ZERO_USAGE_MAX_ATTEMPTS = 5;
export const DEFAULT_TRIGGER_TIERS = ["COMPLEX", "REASONING"];
export const DEFAULT_ALLOWED_TOOLS = [
  "Agent", "Task", "Read", "Grep", "Glob", "TodoRead", "TodoWrite",
];
export const DEFAULT_BLOCKED_TOOLS = [
  "mcp__browser-use__",
  "WebSearch",
  "WebFetch",
];

export type ResolveProviderRefIssue = {
  code: string;
  path: string;
  message: string;
};

/**
 * Parse "provider/model" string into a structured ref and verify it exists in
 * the supplied ModelConfig. Returns either a valid ref or a list of issues
 * (caller is responsible for emitting them as PilotConfigDiagnostic).
 */
export function resolveProviderRef(
  raw: unknown,
  path: string,
  modelConfig: ModelConfig,
): { ref?: RouterModelRef; issues: ResolveProviderRefIssue[] } {
  const issues: ResolveProviderRefIssue[] = [];
  if (typeof raw !== "string" || raw.length === 0) {
    issues.push({
      code: "ROUTER_REF_INVALID",
      path,
      message: `${path} must be a non-empty provider/model string.`,
    });
    return { issues };
  }

  const separator = raw.indexOf("/");
  const provider = separator >= 0 ? raw.slice(0, separator) : "";
  const model = separator >= 0 ? raw.slice(separator + 1) : "";
  if (!provider || !model) {
    issues.push({
      code: "ROUTER_REF_FORMAT",
      path,
      message: `${path} must use provider/model format; got ${raw}.`,
    });
    return { issues };
  }

  const providerEntry = modelConfig.providers[provider];
  if (!providerEntry) {
    issues.push({
      code: "ROUTER_REF_PROVIDER_NOT_FOUND",
      path,
      message: `${path} references unknown provider ${provider}.`,
    });
    return { issues };
  }
  if (!providerEntry.models[model]) {
    issues.push({
      code: "ROUTER_REF_MODEL_NOT_FOUND",
      path,
      message: `${path} references unknown model ${model} for provider ${provider}.`,
    });
    return { issues };
  }

  return { ref: { id: raw, provider, model }, issues };
}
