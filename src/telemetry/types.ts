export const ANALYTICS_SCHEMA_VERSION = "analytics.v1" as const;

export type AnalyticsSchemaVersion = typeof ANALYTICS_SCHEMA_VERSION;

export type TelemetryDeploymentMode =
  | "source"
  | "docker"
  | "curl_installer"
  | "desktop_installer"
  | "npm_binary"
  | "unknown";

export type TelemetryModule =
  | "router"
  | "always_on"
  | "memory"
  | "cron_job"
  | "session";

export type TelemetryLoopStage =
  | "module_event"
  | "loop_start"
  | "model_request"
  | "model_response"
  | "tool_prepare"
  | "tool_call"
  | "permission_check"
  | "loop_end";

export type TelemetryOutcome =
  | "success"
  | "failed"
  | "aborted"
  | "timeout"
  | "denied";

export type TelemetryErrorCategory =
  | "model_request_error"
  | "permission_error"
  | "tool_param_error"
  | "tool_runtime_error"
  | "tool_result_parse_error"
  | "loop_error"
  | "runtime_error";

export type AnalyticsEventName =
  | "app_started"
  | "feature_used"
  | "error_occurred"
  | "session_active";

export type AnalyticsEventProperties = Record<string, unknown>;

export type AnalyticsEvent = {
  schemaVersion: AnalyticsSchemaVersion;
  eventId: string;
  eventName: AnalyticsEventName;
  occurredAt: string;
  installationId: string;
  instanceId: string;
  deploymentMode: TelemetryDeploymentMode;
  /** Hashed anonymous session key (24-char hex), not the raw sessionKey. */
  sessionId?: string;
  commitHash: string;
  appVersion: string;
  platform: NodeJS.Platform;
  properties: AnalyticsEventProperties;
};

export type AnalyticsEventEnvelope = {
  event: AnalyticsEvent;
  attempts: number;
};

export type TelemetryTrackContext = {
  /** Raw session key; hashed before outbound events. */
  sessionId?: string;
};

export type TelemetryFeatureUsedInput = TelemetryTrackContext & {
  module: TelemetryModule;
  loopStage: TelemetryLoopStage;
  outcome?: TelemetryOutcome;
  errorCategory?: TelemetryErrorCategory;
  metadata?: Record<string, unknown>;
};

export type TelemetryErrorInput = TelemetryTrackContext & {
  module?: TelemetryModule | "runtime" | "ui";
  loopStage?: TelemetryLoopStage;
  errorCategory?: TelemetryErrorCategory;
  code?: string;
  metadata?: Record<string, unknown>;
};

export type TelemetryRuntimeContext = {
  installationId: string;
  instanceId: string;
  deploymentMode: TelemetryDeploymentMode;
  commitHash: string;
  appVersion: string;
  platform: NodeJS.Platform;
};

export type TelemetrySenderMetrics = {
  queued: number;
  sent: number;
  sendFailures: number;
  retries: number;
  dropped: number;
  queueDepth: number;
  lastSuccessAt?: string;
};

export type TelemetryConfig = {
  enabled: boolean;
  baseUrl: string;
  flushIntervalMs: number;
  batchSize: number;
  timeoutMs: number;
  maxRetries: number;
  maxQueueSize: number;
  queueFilePath: string;
};

export type TelemetryClient = {
  track(
    eventName: AnalyticsEventName,
    properties?: AnalyticsEventProperties,
    context?: TelemetryTrackContext,
  ): void;
  trackFeatureUsed(input: TelemetryFeatureUsedInput): void;
  trackFeatureLoopStage(input: TelemetryFeatureUsedInput): void;
  trackError(error: unknown, input?: TelemetryErrorInput): void;
  trackAppStarted(metadata?: Record<string, unknown>): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  snapshot(): TelemetrySenderMetrics;
  getConfig(): TelemetryConfig;
};
