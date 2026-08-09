import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelemetryCollector, TelemetrySender, hashTelemetryId } from "../../src/telemetry/index.js";
import type { AnalyticsEvent } from "../../src/telemetry/index.js";
import type { TelemetryConfig } from "../../src/telemetry/types.js";

type CapturedCall = { url: string; body: AnalyticsEvent[] };

function makeEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ANALYTICS_ENABLED: "1",
    ANALYTICS_BASE_URL: "http://telemetry.test",
    ANALYTICS_FLUSH_INTERVAL_MS: "60000",
    ANALYTICS_BATCH_SIZE: "20",
    ANALYTICS_MAX_RETRIES: "3",
    ANALYTICS_MAX_QUEUE_SIZE: "100",
    COMMIT_HASH: "abc1234",
    npm_package_version: "9.9.9",
    ...overrides,
  };
}

function okFetch(calls: CapturedCall[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as AnalyticsEvent[]) : [];
    calls.push({ url: String(url), body });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
}

function makePilotHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "sati-telemetry-"));
  tempDirs.push(dir);
  return dir;
}

const tempDirs: string[] = [];

test.afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

test("enabled collector sends feature_used events with contract shape", async () => {
  const calls: CapturedCall[] = [];
  const pilotHome = makePilotHome();
  const collector = createTelemetryCollector({
    env: makeEnv(),
    pilotHome,
    fetchImpl: okFetch(calls),
    enabled: true,
  });
  collector.track(
    "feature_used",
    { module: "session", loopStage: "loop_start", ok: true },
    { sessionId: "raw-session-key" },
  );
  await collector.flush();
  await collector.shutdown();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://telemetry.test/collect");
  const event = calls[0]!.body[0]!;
  assert.equal(event.schemaVersion, "analytics.v2");
  assert.equal(event.eventName, "feature_used");
  assert.equal(event.commitHash, "abc1234");
  assert.equal(event.appVersion, "9.9.9");
  assert.equal(event.platform, process.platform);
  assert.ok(event.installationId.length > 0);
  assert.ok(event.instanceId.length > 0);
  assert.match(event.eventId, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(event.occurredAt)));
  // sessionId must be a 24-char hash, never the raw key
  assert.match(event.sessionId ?? "", /^[0-9a-f]{24}$/);
  assert.notEqual(event.sessionId, "raw-session-key");
  assert.equal(event.sessionId, hashTelemetryId("raw-session-key"));
  assert.deepEqual(event.properties, { module: "session", loopStage: "loop_start", ok: true });
});

test("outbound events never contain raw filesystem paths", async () => {
  const calls: CapturedCall[] = [];
  const pilotHome = makePilotHome();
  const collector = createTelemetryCollector({
    env: makeEnv(),
    pilotHome,
    fetchImpl: okFetch(calls),
    enabled: true,
  });
  collector.track("feature_used", {
    module: "session",
    loopStage: "loop_end",
    cwd: "/tmp/secret-project",
    filePath: "/etc/passwd",
    projectRoot: "/home/user/repo",
    safe: "value",
  });
  await collector.flush();
  await collector.shutdown();

  const event = calls[0]!.body[0]!;
  const raw = JSON.stringify(event);
  assert.equal(raw.includes("/tmp/secret-project"), false);
  assert.equal(raw.includes("/etc/passwd"), false);
  assert.equal(raw.includes("/home/user/repo"), false);
  assert.deepEqual(event.properties, { module: "session", loopStage: "loop_end", safe: "value" });
});

test("error_occurred excludes message and stack", async () => {
  const calls: CapturedCall[] = [];
  const pilotHome = makePilotHome();
  const collector = createTelemetryCollector({
    env: makeEnv(),
    pilotHome,
    fetchImpl: okFetch(calls),
    enabled: true,
  });
  collector.trackError(new Error("super-secret-message"), {
    module: "session",
    code: "E123",
    loopStage: "loop_end",
    toolName: "read_file",
  });
  await collector.flush();
  await collector.shutdown();

  const event = calls[0]!.body[0]!;
  assert.equal(event.eventName, "error_occurred");
  const raw = JSON.stringify(event);
  assert.equal(raw.includes("super-secret-message"), false);
  assert.equal(raw.includes("stack"), false);
  assert.equal(event.properties.message, undefined);
  assert.equal(event.properties.stack, undefined);
  assert.equal(event.properties.module, "session");
  assert.equal(event.properties.ownerModule, "session");
  assert.equal(event.properties.code, "E123");
  assert.equal(event.properties.errorCategory, "runtime_error");
  assert.equal(event.properties.loopStage, "loop_end");
  assert.equal(event.properties.toolName, "read_file");
});

test("feature_used two-layer model fills ownerModule and passes metadata", async () => {
  const calls: CapturedCall[] = [];
  const pilotHome = makePilotHome();
  const collector = createTelemetryCollector({
    env: makeEnv(),
    pilotHome,
    fetchImpl: okFetch(calls),
    enabled: true,
  });
  collector.trackFeatureUsed({
    module: "session",
    ownerModule: "always_on",
    executionKind: "always_on",
    phase: "discovery",
    loopStage: "loop_start",
    outcome: "success",
    metadata: { provider: "anthropic", model: "claude", providerBaseUrl: "https://api.anthropic.com/" },
  });
  await collector.flush();
  await collector.shutdown();

  const props = calls[0]!.body[0]!.properties;
  assert.equal(props.module, "session");
  assert.equal(props.ownerModule, "always_on");
  assert.equal(props.executionKind, "always_on");
  assert.equal(props.phase, "discovery");
  assert.equal(props.loopStage, "loop_start");
  assert.equal(props.outcome, "success");
  assert.equal(props.provider, "anthropic");
  assert.equal(props.model, "claude");
  assert.equal(props.providerBaseUrl, "https://api.anthropic.com/");
});

test("disabled collector enqueues nothing", async () => {
  const calls: CapturedCall[] = [];
  const pilotHome = makePilotHome();
  const collector = createTelemetryCollector({
    env: makeEnv({ ANALYTICS_ENABLED: "0" }),
    pilotHome,
    fetchImpl: okFetch(calls),
    enabled: false,
  });
  collector.track("feature_used", { module: "session", loopStage: "loop_end" });
  assert.equal(collector.snapshot().queued, 0);
  await collector.flush();
  assert.equal(calls.length, 0);
  await collector.shutdown();
});

test("sender retries failed batches up to maxRetries then drops", async () => {
  const pilotHome = makePilotHome();
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    throw new Error("network down");
  }) as typeof fetch;
  const config: TelemetryConfig = {
    enabled: true,
    baseUrl: "http://telemetry.test",
    flushIntervalMs: 60000,
    batchSize: 20,
    timeoutMs: 1000,
    maxRetries: 2,
    maxQueueSize: 100,
    queueFilePath: join(pilotHome, "telemetry", "queue.jsonl"),
  };
  const sender = new TelemetrySender(config, { fetchImpl });
  sender.enqueue({
    schemaVersion: "analytics.v2",
    eventId: "e1",
    eventName: "feature_used",
    occurredAt: new Date().toISOString(),
    installationId: "i",
    instanceId: "n",
    deploymentMode: "source",
    commitHash: "abc",
    appVersion: "1.0",
    platform: process.platform,
    properties: {},
  });
  await sender.flush();
  assert.equal(attempts, 1);
  const metrics = sender.snapshot();
  assert.equal(metrics.sendFailures, 1);
  assert.equal(metrics.retries, 1);
  assert.equal(metrics.dropped, 0);
  assert.equal(metrics.queueDepth, 1);

  await sender.flush();
  assert.equal(attempts, 2);
  const afterSecond = sender.snapshot();
  assert.equal(afterSecond.sendFailures, 2);
  assert.equal(afterSecond.retries, 2);
  assert.equal(afterSecond.queueDepth, 1);

  await sender.flush();
  assert.equal(attempts, 3);
  const afterThird = sender.snapshot();
  assert.equal(afterThird.sendFailures, 3);
  assert.equal(afterThird.retries, 2); // no more retries
  assert.equal(afterThird.dropped, 1);
  assert.equal(afterThird.queueDepth, 0);
  await sender.shutdown();
});

test("shutdown persists queue and a new sender restores it", async () => {
  const pilotHome = makePilotHome();
  const queueFilePath = join(pilotHome, "telemetry", "queue.jsonl");
  const baseConfig: TelemetryConfig = {
    enabled: true,
    baseUrl: "http://telemetry.test",
    flushIntervalMs: 60000,
    batchSize: 20,
    timeoutMs: 1000,
    maxRetries: 3,
    maxQueueSize: 100,
    queueFilePath,
  };
  // A failing fetch keeps the queue intact through shutdown so it can be persisted.
  const failingFetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  const sender = new TelemetrySender(baseConfig, { fetchImpl: failingFetch });
  sender.enqueue({
    schemaVersion: "analytics.v2",
    eventId: "persisted-1",
    eventName: "feature_used",
    occurredAt: new Date().toISOString(),
    installationId: "i",
    instanceId: "n",
    deploymentMode: "source",
    commitHash: "abc",
    appVersion: "1.0",
    platform: process.platform,
    properties: {},
  });
  await sender.shutdown();
  assert.equal(existsSync(queueFilePath), true);
  assert.ok(readFileSync(queueFilePath, "utf8").includes("persisted-1"));

  const restored = new TelemetrySender({ ...baseConfig, enabled: false }, { fetchImpl: okFetch([]) });
  assert.equal(restored.snapshot().queueDepth, 1);
  await restored.shutdown();
});

test("enqueue over maxQueueSize drops events", async () => {
  const pilotHome = makePilotHome();
  const config: TelemetryConfig = {
    enabled: true,
    baseUrl: "http://telemetry.test",
    flushIntervalMs: 60000,
    batchSize: 20,
    timeoutMs: 1000,
    maxRetries: 3,
    maxQueueSize: 2,
    queueFilePath: join(pilotHome, "telemetry", "queue.jsonl"),
  };
  const sender = new TelemetrySender(config, { fetchImpl: okFetch([]) });
  const event = (id: string): AnalyticsEvent => ({
    schemaVersion: "analytics.v2",
    eventId: id,
    eventName: "feature_used",
    occurredAt: new Date().toISOString(),
    installationId: "i",
    instanceId: "n",
    deploymentMode: "source",
    commitHash: "abc",
    appVersion: "1.0",
    platform: process.platform,
    properties: {},
  });
  sender.enqueue(event("a"));
  sender.enqueue(event("b"));
  sender.enqueue(event("c"));
  assert.equal(sender.snapshot().queued, 2);
  assert.equal(sender.snapshot().dropped, 1);
  await sender.shutdown();
});
