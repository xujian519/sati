export type RouterScenarioType =
  | "default"
  | "background"
  | "think"
  | "longContext"
  | "webSearch"
  | "subagent"
  | "explicit";

export type RouterDecisionResolution =
  | "explicit"
  | "scenario"
  | "tokenSaver"
  | "custom"
  | "fallback";

export type RouterMutationsLog = {
  systemPromptSlim?: { from: number; to: number; preservedKeywords: string[] };
  toolsStripped?: { before: number; after: number; patterns: string[] };
  orchestrationPromptInjected?: { tier: string; chars: number };
  asyncAgentLaunchedRewritten?: boolean;
  subagentTagStripped?: boolean;
};

export type RouterDecision = {
  provider: string;
  model: string;
  scenarioType: RouterScenarioType;
  tokenSaverTier?: string;
  isSubagent: boolean;
  orchestrating: boolean;
  resolvedFrom: RouterDecisionResolution;
  mutations: RouterMutationsLog;
};

export type SessionRoutingState = {
  sessionId: string;
  isSubagent: boolean;
  tokenSaverTier?: string;
  stickyProvider?: string;
  stickyModel?: string;
  orchestrating: boolean;
  lastUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  updatedAt: number;
};

export type RouterDecisionInputUsageHint = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type RouterDecisionInput = {
  request: import("../../model/protocol/canonical.js").CanonicalModelRequest;
  sessionId: string;
  isMainAgent: boolean;
  metadata?: {
    lastUsage?: RouterDecisionInputUsageHint;
    explicitProvider?: string;
    explicitModel?: string;
  };
};

export type RouterExecuteContext = {
  sessionId: string;
  turnId: string;
  abortSignal?: AbortSignal;
};
