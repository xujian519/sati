import type { CatalogProviderProtocol } from "../../../../../shared/catalogProviders";

export type V2Provider = {
  protocol?: CatalogProviderProtocol;
  url?: string;
  apiKey?: string;
  models?: Record<string, Record<string, unknown> | null>;
  retry?: {
    requestMaxRetries?: number;
    streamMaxRetries?: number;
    streamIdleTimeoutMs?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
};

export type SatiConfig = {
  agent?: {
    model?: string;
    maxContextTokens?: number;
    subagents?: { default?: string };
  };
  model?: {
    providers?: Record<string, V2Provider>;
  };
  memory?: {
    enabled?: boolean;
    model?: string;
    autoIndexIntervalMinutes?: number;
    autoDreamIntervalMinutes?: number;
    /** 知识库语义增强（可选）；未配置时关键词检索照常工作。 */
    embedding?: {
      enabled?: boolean;
      /** 引用 model.providers 的 url/apiKey（与 baseUrl 二选一）。 */
      provider?: string;
      /** 独立 OpenAI 兼容端点（与 provider 二选一），如 http://localhost:11434/v1。 */
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      dimensions?: number;
      timeoutMs?: number;
      batchSize?: number;
      indexMemory?: boolean;
      indexWiki?: boolean;
      rerank?: {
        enabled?: boolean;
        provider?: string;
        baseUrl?: string;
        apiKey?: string;
        model?: string;
        timeoutMs?: number;
        topN?: number;
      };
    };
  };
  alwaysOn?: {
    enabled?: boolean;
    trigger?: {
      enabled?: boolean;
      tickIntervalMinutes?: number;
      cooldownMinutes?: number;
      dailyBudget?: number;
      heartbeatStaleSeconds?: number;
      recentUserMsgMinutes?: number;
      preferChannel?: string;
    };
    dormancy?: {
      enabled?: boolean;
      debounceMs?: number;
      ignoreGlobs?: string[];
    };
    workspace?: {
      gitWorktreeBaseDir?: string;
      snapshotBaseDir?: string;
      snapshotMaxBytes?: number;
      maxPlansPerCycle?: number;
      gitLfs?: boolean;
    };
    execution?: {
      maxTurns?: number;
      maxToolCalls?: number;
      timeoutMinutes?: number;
    };
    projects?: Record<string, { enabled?: boolean }>;
  };
  cron?: {
    enabled?: boolean;
    timezone?: string;
    maxConcurrentRuns?: number;
  };
  tools?: {
    webSearch?: {
      enabled?: boolean;
      provider?: "glm" | "tavily" | "custom";
      apiKey?: string;
      endpoint?: string;
      customProvider?: {
        name?: string;
        auth?: "bearer" | "bodyApiKey" | "queryApiKey" | "none";
        method?: "GET" | "POST";
        queryParam?: string;
        apiKeyParam?: string;
        resultsPath?: string;
        titleField?: string;
        urlField?: string;
        snippetField?: string;
        sourceField?: string;
        publishedAtField?: string;
      };
    };
  };
  gateway?: {
    enabled?: boolean;
    home?: string;
  };
  proxy?: {
    url?: string;
    noProxy?: string;
  };
  webui?: {
    runtime?: {
      host?: string;
      serverPort?: number;
      vitePort?: number;
      apiTimeoutMs?: number;
      databasePath?: string;
      workspacesRoot?: string;
    };
    officePreview?: {
      service?: "builtin" | "libreoffice" | string;
      binaryPath?: string;
    };
  };
  customEnv?: Record<string, string>;
  router?: {
    enabled?: boolean;
    scenarios?: Record<string, string>;
    fallback?: Record<string, string[]>;
    zeroUsageRetry?: {
      enabled?: boolean;
      maxAttempts?: number;
    };
    transientRetry?: {
      enabled?: boolean;
      maxAttempts?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
    };
    autoOrchestrate?: {
      enabled?: boolean;
      triggerTiers?: string[];
      slimSystemPrompt?: boolean;
    };
    stats?: {
      enabled?: boolean;
      modelPricing?: Record<string, { input?: number; output?: number; cacheRead?: number }>;
    };
    tokenSaver?: {
      enabled?: boolean;
      defaultTier?: string;
      judgeTimeoutMs?: number;
      rules?: string[];
      subagent?: {
        policy?: string;
      };
      judge?: string;
      tiers?: Record<string, { model?: string; description?: string }>;
    };
  };
};
