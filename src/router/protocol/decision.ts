export type RouterScenarioType = "default" | "subagent" | "explicit";

export type RouterDecisionResolution = "explicit" | "scenario" | "tokenSaver" | "custom" | "fallback";

export type RouterMutationsLog = {
  systemPromptSlim?: { from: number; to: number; preservedKeywords: string[] };
  toolsStripped?: { before: number; after: number; mode?: "allowlist" | "blocklist"; patterns: string[] };
  orchestrationPromptInjected?: { tier: string; chars: number };
  orchestrationActivated?: { tier: string; continued: boolean };
  asyncAgentLaunchedRewritten?: boolean;
  subagentTagStripped?: boolean;
  mediaCapabilityRerouted?: {
    required: import("../../model/protocol/multimodal.js").InputModality[];
    from: string;
    to: string;
  };
  cacheAwareSwitch?: {
    action: "kept_sticky" | "switched";
    from: string;
    to: string;
    cachedCost: number;
    prefillCost: number;
    estimatedInputTokens: number;
  };
};

export type RouterRequestPatch = Pick<
  import("../../model/protocol/canonical.js").CanonicalModelRequest,
  "messages" | "tools" | "systemPrompt"
>;

export type RouterDecision = {
  provider: string;
  model: string;
  scenarioType: RouterScenarioType;
  tokenSaverTier?: string;
  isSubagent: boolean;
  orchestrating: boolean;
  resolvedFrom: RouterDecisionResolution;
  mutations: RouterMutationsLog;
  requestPatch?: Partial<RouterRequestPatch>;
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
  /** 回合取消时中止在途的判官（judge）请求，避免降级到 fallback tier。 */
  abortSignal?: AbortSignal;
  metadata?: {
    lastUsage?: RouterDecisionInputUsageHint;
    explicitProvider?: string;
    explicitModel?: string;
    /** Tier from the previous turn; fed to the judge for context-aware classification. */
    previousTier?: string;
    previousProvider?: string;
    previousModel?: string;
  };
};

/**
 * 逐 attempt 施于请求的改写标签（执行期事实，不是决策意图）。
 *
 * 词汇表刻意窄：每个标签只声明「它可能改掉快照的哪几个字段」，由调用方
 * （`src/agent/loop/requestInvariant.ts`）映射成允许差异字段集。新增改写
 * 必须在此登记并在映射表里给字段，否则派发点对拍会 fail-loud——这正是
 * 该契约的用途：**改写必须被声明**。
 */
export type RouterTransformTag =
  /** 非首个 attempt：provider/model 换成 fallback 目标。 */
  | "fallbackAttempt"
  /** 按 attempt 能力剥离不支持的媒体块（改 messages）。 */
  | "mediaDowngraded"
  /** `mutations.subagentTagStripped`：剥离子代理标记（改 messages）。 */
  | "subagentTagStripped"
  /** 请求的输出上限被夹到模型能力上限。 */
  | "maxOutputTokensClamped"
  /** `requestPatch.messages`（决策声明的消息替换）。 */
  | "requestPatch:messages"
  /** `requestPatch.tools`（决策声明的工具集替换）。 */
  | "requestPatch:tools"
  /** `requestPatch.systemPrompt`（决策声明的系统提示替换）。 */
  | "requestPatch:systemPrompt";

/**
 * 派发报告：真正交给 `modelRuntime` 之前一刻的请求实况。
 *
 * 与「请求头快照」的落盘点（`AgentLoop` 发送前）**不是同一个点**：落盘点记录
 * 的是 loop 装配态，本报告记录的是路由决策级改写与逐 attempt 降级之后、
 * 即将上网的形态。两侧由不同入参派生，故对拍可能失败——这是它区别于
 * 「同一对入参自比」的关键。
 */
export type RouterDispatchReport = {
  /** 即将交给 `modelRuntime` 的请求。 */
  request: import("../../model/protocol/canonical.js").CanonicalModelRequest;
  /** 该 attempt 的有效决策（provider/model 即实际路由目标）。 */
  decision: RouterDecision;
  /** 本 attempt 实际施行的改写标签，按施行顺序。 */
  transforms: readonly RouterTransformTag[];
};

export type RouterExecuteContext = {
  sessionId: string;
  turnId: string;
  projectPath?: string;
  abortSignal?: AbortSignal;
  /**
   * 每个 attempt 送出首字节前调用一次（两条派发路径都调）。缺省不调用，
   * 因此未开启对拍时零开销。回调抛错会中止本 attempt 的流。
   */
  onDispatchRequest?: (report: RouterDispatchReport) => void;
};
