import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { resolvePilotHome } from "../pilot/paths.js";
import { resolveTelemetryRuntimeContext } from "./context.js";
import { TelemetrySender } from "./sender.js";
import {
  ANALYTICS_SCHEMA_VERSION,
  type AnalyticsEvent,
  type AnalyticsEventName,
  type AnalyticsEventProperties,
  type TelemetryClient,
  type TelemetryConfig,
  type TelemetryErrorCategory,
  type TelemetryErrorInput,
  type TelemetryFeatureUsedInput,
  type TelemetryLoopStage,
  type TelemetryModule,
  type TelemetryOutcome,
  type TelemetryRuntimeContext,
  type TelemetryTrackContext,
} from "./types.js";

type CreateTelemetryCollectorInput = {
  env?: Record<string, string | undefined>;
  pilotHome?: string;
  fetchImpl?: typeof fetch;
};

const DEFAULT_BASE_URL = "http://123.56.15.233:3000";

export function createTelemetryCollector(
  input: CreateTelemetryCollectorInput = {},
): TelemetryClient {
  const env = input.env ?? process.env;
  const config = resolveTelemetryConfig(env, input.pilotHome);
  const runtimeContext = resolveTelemetryRuntimeContext({ env, pilotHome: input.pilotHome });
  const sender = new TelemetrySender(config, { fetchImpl: input.fetchImpl });

  return {
    track(eventName, properties = {}, context = {}) {
      if (!config.enabled) return;
      sender.enqueue(buildEvent({
        eventName,
        properties,
        context,
        runtimeContext,
      }));
    },
    trackFeatureUsed(inputFeature) {
      this.trackFeatureLoopStage(inputFeature);
    },
    trackFeatureLoopStage(inputFeature) {
      const {
        module,
        loopStage,
        outcome = "success",
        errorCategory,
        metadata = {},
        ...context
      } = inputFeature;
      this.track("feature_used", {
        module,
        loopStage,
        outcome,
        ...(errorCategory ? { errorCategory } : {}),
        ...metadata,
      }, context);
    },
    trackError(error, inputError = {}) {
      const err = normalizeError(error);
      const metadata = inputError.metadata ?? {};
      const module = inputError.module ?? "runtime";
      const loopStage = inputError.loopStage ?? "loop_end";
      const errorCategory = inputError.errorCategory ?? "runtime_error";
      this.track("error_occurred", {
        module,
        loopStage,
        errorCategory,
        code: inputError.code ?? err.code,
        message: err.message,
        stack: err.stack,
        ...metadata,
      }, inputError);
      this.trackFeatureLoopStage({
        module: normalizeModule(module),
        loopStage: normalizeLoopStage(loopStage),
        outcome: "failed",
        errorCategory: normalizeErrorCategory(errorCategory),
        sessionId: inputError.sessionId,
        projectPath: inputError.projectPath,
        metadata: {
          code: inputError.code ?? err.code,
          ...metadata,
        },
      });
    },
    trackAppStarted(metadata = {}) {
      this.track("app_started", metadata, {});
    },
    flush() {
      return sender.flush();
    },
    shutdown() {
      return sender.shutdown();
    },
    snapshot() {
      return sender.snapshot();
    },
    getConfig() {
      return { ...config };
    },
  };
}

function resolveTelemetryConfig(
  env: Record<string, string | undefined>,
  pilotHomeOverride?: string,
): TelemetryConfig {
  const enabled = parseEnabledFlag(env.ANALYTICS_ENABLED, true);
  const pilotHome = pilotHomeOverride ?? resolvePilotHome(env);
  const queueFilePath = env.ANALYTICS_QUEUE_FILE
    ? resolve(env.ANALYTICS_QUEUE_FILE)
    : join(pilotHome, "telemetry", "queue.jsonl");

  return {
    enabled,
    baseUrl: env.ANALYTICS_BASE_URL || DEFAULT_BASE_URL,
    flushIntervalMs: parsePositiveInt(env.ANALYTICS_FLUSH_INTERVAL_MS, 5000),
    batchSize: parsePositiveInt(env.ANALYTICS_BATCH_SIZE, 20),
    timeoutMs: parsePositiveInt(env.ANALYTICS_TIMEOUT_MS, 4000),
    maxRetries: parseNonNegativeInt(env.ANALYTICS_MAX_RETRIES, 3),
    maxQueueSize: parsePositiveInt(env.ANALYTICS_MAX_QUEUE_SIZE, 2000),
    queueFilePath,
  };
}

function buildEvent(input: {
  eventName: AnalyticsEventName;
  properties: AnalyticsEventProperties;
  context: TelemetryTrackContext;
  runtimeContext: TelemetryRuntimeContext;
}): AnalyticsEvent {
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    eventId: randomUUID(),
    eventName: input.eventName,
    occurredAt: new Date().toISOString(),
    installationId: input.runtimeContext.installationId,
    instanceId: input.runtimeContext.instanceId,
    deploymentMode: input.runtimeContext.deploymentMode,
    sessionId: input.context.sessionId,
    commitHash: input.runtimeContext.commitHash,
    appVersion: input.runtimeContext.appVersion,
    platform: input.runtimeContext.platform,
    projectPath: input.context.projectPath,
    properties: input.properties,
  };
}

function normalizeError(error: unknown): { code: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      code: error.name || "Error",
      message: truncateText(error.message),
      stack: error.stack ? sanitizeStack(error.stack) : undefined,
    };
  }
  const text = truncateText(String(error));
  return { code: "UnknownError", message: text };
}

function sanitizeStack(stack: string): string {
  return truncateText(
    stack
      .replace(/([A-Za-z]:)?\/[^)\n]+/g, "<path>")
      .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "<jwt>"),
    2000,
  );
}

function truncateText(input: string, max = 500): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}...`;
}

function parseEnabledFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "off") return false;
  if (normalized === "1" || normalized === "true" || normalized === "on") return true;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeModule(value: string): TelemetryModule {
  if (
    value === "router" ||
    value === "always_on" ||
    value === "memory" ||
    value === "cron_job" ||
    value === "session"
  ) {
    return value;
  }
  return "session";
}

function normalizeLoopStage(value: string): TelemetryLoopStage {
  if (
    value === "module_event" ||
    value === "loop_start" ||
    value === "model_request" ||
    value === "model_response" ||
    value === "tool_prepare" ||
    value === "tool_call" ||
    value === "permission_check" ||
    value === "loop_end"
  ) {
    return value;
  }
  return "loop_end";
}

function normalizeErrorCategory(value: string): TelemetryErrorCategory {
  if (
    value === "model_request_error" ||
    value === "permission_error" ||
    value === "tool_param_error" ||
    value === "tool_runtime_error" ||
    value === "tool_result_parse_error" ||
    value === "loop_error" ||
    value === "runtime_error"
  ) {
    return value;
  }
  return "runtime_error";
}
