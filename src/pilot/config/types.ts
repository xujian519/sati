import type { AlwaysOnConfig } from "../../always-on/config/parseAlwaysOnConfig.js";
import type { CronConfig } from "../../cron/config/parseCronConfig.js";
import type { ModelConfig } from "../../model/protocol/canonical.js";
import type { RouterConfig } from "../../router/config/schema.js";

export type PilotConfigSourceKind = "default" | "project" | "env";
export type PilotConfigSourcePhase = "bootstrap" | "merge";
export type PilotConfigDiagnosticSeverity = "info" | "warning" | "error" | "fatal";
export type PilotConfigChangeClass = "runtime-live" | "next-request" | "next-runtime" | "restart-required" | "invalid";

export type PilotConfigSource = {
  kind: PilotConfigSourceKind;
  priority: number;
  loadedAt: Date;
  path?: string;
  contentHash?: string;
  phase?: PilotConfigSourcePhase;
};

export type PilotConfigDiagnostic = {
  code: string;
  severity: PilotConfigDiagnosticSeverity;
  message: string;
  path?: string;
  source?: Pick<PilotConfigSource, "kind" | "path" | "phase">;
  hint?: string;
  recoverable?: boolean;
};

export type PilotRawConfig = {
  schemaVersion?: unknown;
  agent?: unknown;
  model?: unknown;
  extension?: unknown;
  memory?: unknown;
  gateway?: unknown;
  adapters?: unknown;
  router?: unknown;
  alwaysOn?: unknown;
  cron?: unknown;
  tools?: unknown;
  telemetry?: unknown;
  proxy?: unknown;
  webui?: unknown;
  patents?: unknown;
};

export type PilotExtensionConfig = {
  builtinPluginsEnabled: Record<string, boolean>;
  includeHookEvents: boolean;
};

export type PilotAgentModelSelection = {
  id: string;
  provider: string;
  model: string;
};

export type PilotAgentConfig = {
  model: PilotAgentModelSelection;
  /**
   * Override the model catalog's context window size (tokens). When set,
   * auto-compaction thresholds (80% warn / 95% block) are computed against
   * this value instead of the catalog default. Useful for proxy providers
   * or when you want compaction to kick in earlier.
   */
  maxContextTokens?: number;
  /** Override the selected model catalog's output-token cap. */
  maxOutputTokens?: number;
  thinking?: { enabled: boolean; budgetTokens?: number };
  subagents?: {
    /** Optional default model/caps for forked subagents. Omitted or "inherit" means inherit the parent agent's model. */
    default?: PilotAgentModelSelection;
    timeoutMs?: number;
  };
};

export type PilotMemoryApiType = "openai-responses" | "responses" | "openai-completions" | "anthropic" | "google";
export type PilotMemoryReasoningMode = "answer_first" | "accuracy_first";

export type PilotMemoryScheduleConfig = {
  reasoningMode?: PilotMemoryReasoningMode;
  autoIndexIntervalMinutes?: number;
  autoDreamIntervalMinutes?: number;
};

/**
 * 重排（rerank）配置（阶段 C，可选）。
 *
 * 召回（embedding top-k / FTS / 关键词）之后的重排阶段：用 cross-encoder
 * 对候选与 query 做 token 级交互打分，提升 top-N 精度。默认兼容
 * HuggingFace TEI 的 `/rerank` 端点（本地部署 bge-reranker-v2-m3）。
 * 未配置或端点不可用时保持原召回顺序（RRF 融合结果）。
 */
export type PilotMemoryRerankConfig = {
  enabled: boolean;
  /** 引用 model.providers 的 providerId（如 tei）。 */
  provider?: string;
  /** 重排模型名；TEI 单模型服务可留空（留空不发送 model 字段）；jina 风格必填。 */
  model?: string;
  /** 独立端点基地址（如 http://localhost:8080；oMLX 用 http://localhost:8000/v1）。 */
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** 参与重排的候选上限（默认 16）。 */
  topN?: number;
  /**
   * 请求风格（缺省 tei）：
   * - "tei"：body { query, texts }（HuggingFace TEI /rerank）；
   * - "jina"：body { query, documents } + model（oMLX /v1/rerank 等）。
   */
  style?: "tei" | "jina";
};

/**
 * 语义检索（embedding）配置。
 *
 * 两种形态：
 *   1. `provider` 形态：引用 model.providers 的 url/apiKey（如 ollama）；
 *   2. `baseUrl` 形态：独立端点（url + apiKey + model 直配）。
 * 未配置或校验失败时语义检索自动关闭，现有 keyword 路径原样工作。
 */
export type PilotMemoryEmbeddingConfig = {
  enabled: boolean;
  /** 引用 model.providers 的 providerId（如 "ollama"）。 */
  provider?: string;
  /** embedding 模型名（如 "bge-m3"）。 */
  model: string;
  /** 独立端点基地址（如 http://localhost:11434/v1）。 */
  baseUrl?: string;
  apiKey?: string;
  /** 向量维度（bge-m3 dense = 1024）；缺省从首次响应推断。 */
  dimensions?: number;
  timeoutMs?: number;
  batchSize?: number;
  /** 是否索引记忆正文（默认 true）。 */
  indexMemory?: boolean;
  /** 是否索引专利 wiki 卡片（默认 true）。 */
  indexWiki?: boolean;
  /** 重排（可选，阶段 C）：召回后对候选做 cross-encoder 重排。 */
  rerank?: PilotMemoryRerankConfig;
};

/**
 * 项目知识偏好（memory.knowledgeProfile，可选）。
 *
 * 供不同客户/技术领域项目声明知识侧重：knowledge provider 注入时据此
 * 强制注入相关审查标准，弥补"全局知识 × 当前 query"的盲区。
 */
export type PilotKnowledgeProfileConfig = {
  /** IPC 部（A-H）：query 命中该部候选时强制注入对应审查标准。 */
  ipcSections?: string[];
};

export type PilotMemoryConfig = {
  enabled: boolean;
  provider: "edgeclaw";
  rootDir?: string;
  captureStrategy: "last_turn" | "full_session";
  includeAssistant: boolean;
  maxMessageChars?: number;
  retrievalTimeoutMs?: number;
  /** "provider/model" string referencing model.providers, e.g. "openai/gpt-4.1-mini" */
  model?: string;
  apiType?: PilotMemoryApiType;
  schedule?: PilotMemoryScheduleConfig;
  heartbeatBatchSize?: number;
  /** 语义检索（embedding）配置；未配置则关闭语义召回。 */
  embedding?: PilotMemoryEmbeddingConfig;
  /** 项目知识偏好（可选；未配置则知识注入无项目侧加权）。 */
  knowledgeProfile?: PilotKnowledgeProfileConfig;
};

export type PilotGatewayConfig = {
  port: number;
  bindAddress: "127.0.0.1";
  idleSessionTimeoutMinutes: number;
  idleSweepIntervalSeconds: number;
  memoryDiagnostics: boolean;
  staticAssetsPath?: string;
  /**
   * Maximum number of concurrent per-session MCP instances (e.g. browser-use
   * browser processes).  When the limit is reached, new sessions fall back
   * to the shared project-level MCP runtime.  Default 5.
   */
  maxPerSessionMcpInstances?: number;
};

export type PilotWebSearchProvider = "glm" | "tavily" | "custom";
export type PilotWebSearchCustomAuth = "bearer" | "bodyApiKey" | "queryApiKey" | "none";
export type PilotWebSearchCustomMethod = "GET" | "POST";

export type PilotWebSearchCustomProviderConfig = {
  name?: string;
  auth?: PilotWebSearchCustomAuth;
  method?: PilotWebSearchCustomMethod;
  queryParam?: string;
  apiKeyParam?: string;
  resultsPath?: string;
  titleField?: string;
  urlField?: string;
  snippetField?: string;
  sourceField?: string;
  publishedAtField?: string;
};

/**
 * Per-tool runtime config for `web_search`. Exactly one provider is active at
 * runtime; `apiKey` and `endpoint` apply to the selected provider.
 */
export type PilotWebSearchConfig = {
  /** Defaults to true when omitted. False removes web_search from the tool registry. */
  enabled?: boolean;
  provider?: PilotWebSearchProvider;
  apiKey?: string;
  endpoint?: string;
  customProvider?: PilotWebSearchCustomProviderConfig;
};

/** 按源开关（缺省全部启用），与 CreateLiteratureRegistryOptions 同形。 */
export type PilotPaperSearchConfig = {
  /** Defaults to true when omitted. False removes the literature tools. */
  enabled?: boolean;
  /** arXiv 开关（默认 true）。 */
  arxiv?: boolean;
  /** OpenAlex 开关（默认 true）。 */
  openalex?: boolean;
  /** Semantic Scholar 开关（默认 true）。 */
  semanticScholar?: boolean;
  /** Crossref 开关（默认 true）。 */
  crossref?: boolean;
  /** OpenAlex polite pool 标识邮箱（可选，默认回退 OPENALEX_MAILTO env）。 */
  openalexMailto?: string;
  /** Semantic Scholar 提额 key（可选，默认回退 SEMANTIC_SCHOLAR_API_KEY env）。 */
  semanticScholarApiKey?: string;
};

export type PilotToolsConfig = {
  webSearch?: PilotWebSearchConfig;
  paperSearch?: PilotPaperSearchConfig;
};

export type PilotProxyConfig = {
  url: string;
  noProxy?: string;
};

export type PilotPlatformAdapterConfig = {
  enabled: boolean;
  token?: string;
  apiKey?: string;
  webhookUrl?: string;
  extra?: Record<string, unknown>;
};

export type PilotAdaptersConfig = {
  cli?: {
    autoConnectServer: boolean;
  };
  tui?: {
    autoConnectServer: boolean;
  };
  feishu?: {
    enabled: boolean;
    appId?: string;
    appSecret?: string;
    encryptKey?: string;
    verifyToken?: string;
    defaultSessionLabel: string;
    connectionMode?: "stream" | "webhook";
    domainName?: "feishu" | "lark";
  };
  weixin?: { enabled: boolean };
  qq?: {
    enabled: boolean;
    appId?: string;
    clientSecret?: string;
    allowGroups?: string[];
    triggerPrefixes?: string[];
    maxMessageLength?: number;
  };
  telegram?: PilotPlatformAdapterConfig;
  discord?: PilotPlatformAdapterConfig;
  slack?: PilotPlatformAdapterConfig;
  matrix?: PilotPlatformAdapterConfig;
  mattermost?: PilotPlatformAdapterConfig;
  signal?: PilotPlatformAdapterConfig;
  whatsapp?: PilotPlatformAdapterConfig;
  bluebubbles?: PilotPlatformAdapterConfig;
  dingtalk?: PilotPlatformAdapterConfig;
  wecom?: PilotPlatformAdapterConfig;
  wecomCallback?: PilotPlatformAdapterConfig;
  email?: PilotPlatformAdapterConfig;
  sms?: PilotPlatformAdapterConfig;
  homeassistant?: PilotPlatformAdapterConfig;
  apiServer?: PilotPlatformAdapterConfig;
  webhook?: PilotPlatformAdapterConfig;
};

export type PilotTelemetryConfig = {
  enabled: boolean;
};

/** 专利域全局配置（patents.*，可选）。 */
export type PilotPatentsConfig = {
  /** patent_pdf_download 未显式传 outputDir 时的全局下载目录。 */
  downloadDir?: string;
  /**
   * per-node 模型覆盖（P2-1 模型分层 / judgeModels 多模型共识）：modelHint 名 →
   * provider/model。patent_workflow_run（图模式 judgeModels）与 patent_workflow
   * （manifest 原子 modelHint）在会话模型之上按 hint 覆盖；缺省空 = 全部走会话模型。
   */
  modelHints?: Record<string, { provider?: string; model: string }>;
};

export type PilotConfig = {
  agent: PilotAgentConfig;
  model: ModelConfig;
  extension: PilotExtensionConfig;
  memory?: PilotMemoryConfig;
  gateway?: PilotGatewayConfig;
  adapters?: PilotAdaptersConfig;
  router?: RouterConfig;
  alwaysOn?: AlwaysOnConfig;
  cron?: CronConfig;
  tools?: PilotToolsConfig;
  telemetry?: PilotTelemetryConfig;
  proxy?: PilotProxyConfig;
  patents?: PilotPatentsConfig;
};

export type PilotConfigSnapshot = {
  version: number;
  schemaVersion: number;
  loadedAt: Date;
  contentHash: string;
  sources: PilotConfigSource[];
  diagnostics: PilotConfigDiagnostic[];
  config: PilotConfig;
};

export type PilotConfigLoadOptions = {
  env?: Record<string, string | undefined>;
  projectRoot?: string;
  version?: number;
};

export type PilotConfigReloadEvent = {
  previousSnapshot: PilotConfigSnapshot;
  nextSnapshot: PilotConfigSnapshot;
  changedPaths: string[];
  changeClasses: PilotConfigChangeClass[];
};

export class PilotConfigError extends Error {
  readonly name = "PilotConfigError";

  constructor(
    readonly code: string,
    message: string,
    readonly diagnostics: PilotConfigDiagnostic[] = [],
  ) {
    super(message);
  }
}
