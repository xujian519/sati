import type { AlwaysOnConfig } from "../../always-on/config/parseAlwaysOnConfig.js";
import type { CronConfig } from "../../cron/config/parseCronConfig.js";
import type { ModelConfig } from "../../model/protocol/canonical.js";
import type { RouterConfig } from "../../router/config/schema.js";

export type PilotConfigSourceKind = "default" | "project" | "env";
export type PilotConfigSourcePhase = "bootstrap" | "merge";
export type PilotConfigDiagnosticSeverity = "info" | "warning" | "error" | "fatal";
export type PilotConfigChangeClass =
  | "runtime-live"
  | "next-request"
  | "next-runtime"
  | "restart-required"
  | "invalid";

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
  redactedValue?: string;
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
};

/**
 * Re-export of the router's structured config so callers that already depend
 * on `PilotConfig` keep a single import path. The actual definition lives in
 * `src/router/config/schema.ts`.
 */
export type PilotRouterConfig = RouterConfig;

export type PilotMemoryApiType = "openai-responses" | "responses" | "openai-completions";

export type PilotMemoryConfig = {
  enabled: boolean;
  provider: "edgeclaw";
  rootDir?: string;
  captureStrategy: "last_turn" | "full_session";
  includeAssistant: boolean;
  maxMessageChars?: number;
  /** "provider/model" string referencing model.providers, e.g. "openai/gpt-4.1-mini" */
  model?: string;
  apiType?: PilotMemoryApiType;
};

export type PilotGatewayConfig = {
  port: number;
  bindAddress: "127.0.0.1";
  idleSessionTimeoutMinutes: number;
  staticAssetsPath?: string;
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
  };
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
