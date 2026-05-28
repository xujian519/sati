import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTelemetryCollector, sanitizeProperties } from "../../src/telemetry/collector.js";
import { hashTelemetryId } from "../../src/telemetry/context.js";

function createTempHome(): string {
  return mkdtempSync(join(tmpdir(), "pilotdeck-telemetry-test-"));
}

test("telemetry collector sends to configured endpoint", async () => {
  const pilotHome = createTempHome();
  const requests: Array<{ url: string; body: unknown }> = [];
  const collector = createTelemetryCollector({
    pilotHome,
    env: {
      ANALYTICS_ENABLED: "true",
      ANALYTICS_BASE_URL: "http://example.internal:3000",
      ANALYTICS_BATCH_SIZE: "1",
      ANALYTICS_FLUSH_INTERVAL_MS: "60000",
      ANALYTICS_TIMEOUT_MS: "1000",
      ANALYTICS_MAX_RETRIES: "1",
      ANALYTICS_MAX_QUEUE_SIZE: "10",
      COMMIT_HASH: "abc123",
      PILOTDECK_VERSION: "0.9.0",
      PILOT_HOME: pilotHome,
    },
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return { ok: true, status: 202 } as Response;
    }) as typeof fetch,
  });

  const rawSessionId = "tui:project=/Users/foo/work/repo:default";
  collector.trackFeatureUsed({
    module: "router",
    loopStage: "model_response",
    outcome: "success",
    sessionId: rawSessionId,
    metadata: { provider: "openai" },
  });
  await collector.flush();

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "http://example.internal:3000/collect");
  const payload = requests[0]?.body as Array<{
    eventName: string;
    commitHash: string;
    deploymentMode: string;
    instanceId: string;
    sessionId: string;
    projectPath?: string;
    projectCommitHash?: string;
    properties: { module: string; loopStage: string };
  }>;
  assert.equal(payload[0]?.eventName, "feature_used");
  assert.equal(payload[0]?.commitHash, "abc123");
  assert.equal(typeof payload[0]?.deploymentMode, "string");
  assert.equal(typeof payload[0]?.instanceId, "string");
  assert.equal(payload[0]?.properties.module, "router");
  assert.equal(payload[0]?.properties.loopStage, "model_response");
  assert.equal(payload[0]?.projectPath, undefined);
  assert.equal(payload[0]?.projectCommitHash, undefined);
  assert.equal(payload[0]?.sessionId, hashTelemetryId(rawSessionId));
  assert.notEqual(payload[0]?.sessionId, rawSessionId);
  await collector.shutdown();
  rmSync(pilotHome, { recursive: true, force: true });
});

test("telemetry collector retries failed uploads", async () => {
  const pilotHome = createTempHome();
  let callCount = 0;
  const collector = createTelemetryCollector({
    pilotHome,
    env: {
      ANALYTICS_ENABLED: "true",
      ANALYTICS_BATCH_SIZE: "2",
      ANALYTICS_FLUSH_INTERVAL_MS: "60000",
      ANALYTICS_MAX_RETRIES: "2",
      ANALYTICS_TIMEOUT_MS: "1000",
      PILOT_HOME: pilotHome,
    },
    fetchImpl: (async () => {
      callCount += 1;
      if (callCount === 1) {
        return { ok: false, status: 500 } as Response;
      }
      return { ok: true, status: 202 } as Response;
    }) as typeof fetch,
  });

  collector.track("session_active", { source: "test" }, { sessionId: "s-2" });
  await collector.flush();
  const first = collector.snapshot();
  assert.equal(first.sendFailures, 1);
  assert.equal(first.retries, 1);
  assert.equal(first.queueDepth, 1);

  await collector.flush();
  const second = collector.snapshot();
  assert.equal(second.sent, 1);
  assert.equal(second.queueDepth, 0);
  await collector.shutdown();
  rmSync(pilotHome, { recursive: true, force: true });
});

test("trackError omits message and stack", async () => {
  const pilotHome = createTempHome();
  const requests: Array<{ body: unknown }> = [];
  const collector = createTelemetryCollector({
    pilotHome,
    env: {
      ANALYTICS_ENABLED: "true",
      ANALYTICS_BASE_URL: "http://example.internal:3000",
      ANALYTICS_BATCH_SIZE: "10",
      ANALYTICS_FLUSH_INTERVAL_MS: "60000",
      PILOT_HOME: pilotHome,
    },
    fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return { ok: true, status: 202 } as Response;
    }) as typeof fetch,
  });

  const err = new Error("failed at /Users/secret/project");
  err.name = "ToolExecutionError";
  collector.trackError(err, {
    module: "session",
    loopStage: "tool_call",
    errorCategory: "tool_runtime_error",
    metadata: { cwd: "/Users/secret/project", runId: "run-1" },
  });
  await collector.flush();

  const events = requests[0]?.body as Array<{
    eventName: string;
    properties: Record<string, unknown>;
  }>;
  const errorEvent = events?.find((e) => e.eventName === "error_occurred");
  assert.ok(errorEvent);
  assert.equal(errorEvent.properties.code, "ToolExecutionError");
  assert.equal(errorEvent.properties.errorCategory, "tool_runtime_error");
  assert.equal(errorEvent.properties.message, undefined);
  assert.equal(errorEvent.properties.stack, undefined);
  assert.equal(errorEvent.properties.cwd, undefined);

  const failedFeature = events?.find(
    (e) => e.eventName === "feature_used" && e.properties.outcome === "failed",
  );
  assert.ok(failedFeature);
  assert.equal(failedFeature.properties.code, "ToolExecutionError");
  assert.equal(failedFeature.properties.runId, undefined);

  await collector.shutdown();
  rmSync(pilotHome, { recursive: true, force: true });
});

test("sanitizeProperties strips path-like keys and absolute paths", () => {
  const sanitized = sanitizeProperties({
    provider: "openai",
    cwd: "/Users/foo",
    projectRoot: "/var/project",
    nested: { filePath: "/tmp/x", ok: 1 },
    labels: ["/abs/path", "safe"],
  });
  assert.equal(sanitized.provider, "openai");
  assert.equal(sanitized.cwd, undefined);
  assert.equal(sanitized.projectRoot, undefined);
  assert.deepEqual(sanitized.nested, { ok: 1 });
  assert.deepEqual(sanitized.labels, ["safe"]);
});
