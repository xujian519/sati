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

export type PolitConfig = {
  agent: PolitAgentConfig;
  model: ModelConfig;
  extension: PolitExtensionConfig;
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
