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

export const DEFAULT_JUDGE_TIMEOUT_MS = 15_000;
export const DEFAULT_ZERO_USAGE_MAX_ATTEMPTS = 2;
export const DEFAULT_TRIGGER_TIERS = ["complex"];

/**
 * Default 4-tier classification descriptions, validated against PinchBench
 * 22-task benchmark (95%+ accuracy). COMPLEX is reserved exclusively for
 * sub-agent orchestration; single-agent deep work goes to REASONING.
 */
export const DEFAULT_TIER_DESCRIPTIONS: Record<string, string> = {
  simple: "Simple greetings, confirmations, single-step Q&A, trivial file writes, remembering rules",
  medium: "Single tool call, short text generation, 1-2 file read/write, code generation",
  complex: "Needs sub-agent orchestration: parallel workstreams, delegation to specialized agents",
  reasoning: "Deep single-agent work: multi-file operations, data analysis, multi-step workflows, web research, structured reports from many sources",
};

export const DEFAULT_TIER_RULES: string[] = [
  "complex is ONLY for tasks that need sub-agent orchestration or parallel delegation — do NOT use it for single-agent multi-step work",
  "Multi-file operations, data analysis, and multi-step workflows without orchestration should be reasoning",
  "Simple file creation (1-2 files) or single code generation is medium",
  "Trivial greetings, confirmations, remembering rules, or reading one file and answering a short question is simple",
];

export const DEFAULT_TIER_NAME = "medium";
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
