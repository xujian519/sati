import type { ModelConfig } from "../../model/protocol/canonical.js";

export type PolitConfigSourceKind = "default" | "project" | "env";
export type PolitConfigSourcePhase = "bootstrap" | "merge";
export type PolitConfigDiagnosticSeverity = "info" | "warning" | "error" | "fatal";
export type PolitConfigChangeClass =
  | "runtime-live"
  | "next-request"
  | "next-runtime"
  | "restart-required"
  | "invalid";

export type PolitConfigSource = {
  kind: PolitConfigSourceKind;
  priority: number;
  loadedAt: Date;
  path?: string;
  contentHash?: string;
  phase?: PolitConfigSourcePhase;
};

export type PolitConfigDiagnostic = {
  code: string;
  severity: PolitConfigDiagnosticSeverity;
  message: string;
  path?: string;
  source?: Pick<PolitConfigSource, "kind" | "path" | "phase">;
  hint?: string;
  redactedValue?: string;
  recoverable?: boolean;
};

export type PolitRawConfig = {
  schemaVersion?: unknown;
  agent?: unknown;
  model?: unknown;
  extension?: unknown;
  memory?: unknown;
  gateway?: unknown;
  adapters?: unknown;
};

export type PolitExtensionConfig = {
  builtinPluginsEnabled: Record<string, boolean>;
  includeHookEvents: boolean;
};

export type PolitAgentModelSelection = {
  id: string;
  provider: string;
  model: string;
};

export type PolitAgentConfig = {
  model: PolitAgentModelSelection;
  fallbackModel?: PolitAgentModelSelection;
};

export type PolitMemoryLlmConfig = {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  apiType?: "openai-responses" | "responses" | "openai-completions";
};

export type PolitMemoryConfig = {
  enabled: boolean;
  provider: "edgeclaw";
  rootDir?: string;
  captureStrategy: "last_turn" | "full_session";
  includeAssistant: boolean;
  maxMessageChars?: number;
  llm?: PolitMemoryLlmConfig;
};

export type PolitGatewayConfig = {
  port: number;
  bindAddress: "127.0.0.1";
  tokenPath?: string;
  idleSessionTimeoutMinutes: number;
  staticAssetsPath?: string;
};

export type PolitAdaptersConfig = {
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
  };
};

export type PolitConfig = {
  agent: PolitAgentConfig;
  model: ModelConfig;
  extension: PolitExtensionConfig;
  memory?: PolitMemoryConfig;
  gateway?: PolitGatewayConfig;
  adapters?: PolitAdaptersConfig;
};

export type PolitConfigSnapshot = {
  version: number;
  schemaVersion: number;
  loadedAt: Date;
  contentHash: string;
  sources: PolitConfigSource[];
  diagnostics: PolitConfigDiagnostic[];
  config: PolitConfig;
};

export type PolitConfigLoadOptions = {
  env?: Record<string, string | undefined>;
  projectRoot?: string;
  version?: number;
};

export type PolitConfigReloadEvent = {
  previousSnapshot: PolitConfigSnapshot;
  nextSnapshot: PolitConfigSnapshot;
  changedPaths: string[];
  changeClasses: PolitConfigChangeClass[];
};

export class PolitConfigError extends Error {
  readonly name = "PolitConfigError";

  constructor(
    readonly code: string,
    message: string,
    readonly diagnostics: PolitConfigDiagnostic[] = [],
  ) {
    super(message);
  }
}
