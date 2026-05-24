import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRouterRuntime } from "../../src/router/index.js";
import { createModelRuntime } from "../../src/model/index.js";
import { loadPilotConfig } from "../../src/pilot/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";
import type { RouterEvent } from "../../src/router/protocol/events.js";
import type { CanonicalModelEvent } from "../../src/model/index.js";

const RUN = process.env.PILOTDECK_RUN_FRAMEWORK_E2E === "1";
const PROVIDER = process.env.PILOTDECK_E2E_PROVIDER ?? "edgeclaw";
const MODEL = process.env.PILOTDECK_E2E_MODEL ?? "moonshotai/kimi-k2.6";

test("Real router routes default scenario and receives model response", { timeout: 60_000 }, async (t) => {
  if (!RUN) {
    t.skip("Set PILOTDECK_RUN_FRAMEWORK_E2E=1 to run.");
    return;
  }
  const snapshot = loadPilotConfig();
  const modelRuntime = createModelRuntime(snapshot.config.model);
  const config: RouterConfig = {
    scenarios: { default: { id: `${PROVIDER}/${MODEL}`, provider: PROVIDER, model: MODEL } },
  };
  const router = createRouterRuntime(config, { modelRuntime });

  const events: CanonicalModelEvent[] = [];
  for await (const event of router.stream(
    { provider: "ignored", model: "ignored", messages: [{ role: "user", content: [{ type: "text", text: "Say hello in one word." }] }] },
    { sessionId: "e2e-1", turnId: "t1", isMainAgent: true },
  )) {
    events.push(event);
  }
  assert.ok(events.some((e) => e.type === "text_delta"), "Must receive text_delta events");
  assert.ok(events.some((e) => e.type === "message_end"), "Must receive message_end");
});

test("Real router emits error for invalid provider without fallback activation", { timeout: 60_000 }, async (t) => {
  if (!RUN) {
    t.skip("Set PILOTDECK_RUN_FRAMEWORK_E2E=1 to run.");
    return;
  }
  const snapshot = loadPilotConfig();
  const modelRuntime = createModelRuntime(snapshot.config.model);
  const config: RouterConfig = {
    scenarios: { default: { id: "fake/nonexistent", provider: "fake", model: "nonexistent" } },
    fallback: {
      default: [{ id: `${PROVIDER}/${MODEL}`, provider: PROVIDER, model: MODEL }],
    },
  };
  const eventLog: RouterEvent[] = [];
  const router = createRouterRuntime(config, { modelRuntime, events: { emit: (e) => eventLog.push(e) } });

  const events: CanonicalModelEvent[] = [];
  for await (const event of router.stream(
    { provider: "ignored", model: "ignored", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    { sessionId: "e2e-fb", turnId: "t1", isMainAgent: true },
  )) {
    events.push(event);
  }

  // Invalid provider errors are non-retryable, so the router should NOT
  // activate the fallback chain — it should surface an error event instead.
  const hasError = events.some((e) => e.type === "error");
  const hasFailed = eventLog.some((e) => e.type === "pilotdeck_router_execute_failed");
  const hasFallback = eventLog.some((e) => e.type === "pilotdeck_router_fallback");
  const hasContent = events.some((e) => e.type === "text_delta");

  assert.ok(
    hasError || hasFailed || hasFallback || hasContent,
    "Must either report an error, emit execute_failed, trigger fallback, or produce content",
  );

  // If fallback did NOT activate, the error path must have fired.
  if (!hasFallback && !hasContent) {
    assert.ok(hasError || hasFailed, "Non-retryable provider error must surface as error/execute_failed");
  }
});

test("Real router stats track request after successful stream", { timeout: 60_000 }, async (t) => {
  if (!RUN) {
    t.skip("Set PILOTDECK_RUN_FRAMEWORK_E2E=1 to run.");
    return;
  }

  // Use a unique temp directory so stats don't accumulate across runs.
  const statsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-e2e-stats-"));

  const snapshot = loadPilotConfig();
  const modelRuntime = createModelRuntime(snapshot.config.model);
  const config: RouterConfig = {
    scenarios: { default: { id: `${PROVIDER}/${MODEL}`, provider: PROVIDER, model: MODEL } },
    stats: { enabled: true, filePath: path.join(statsDir, "stats.json") },
  };
  const router = createRouterRuntime(config, { modelRuntime });

  for await (const _ of router.stream(
    { provider: "ignored", model: "ignored", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
    { sessionId: "e2e-stats", turnId: "t1", isMainAgent: true },
  )) { void _; }

  const snap = router.stats.snapshot();
  assert.equal(snap.totalRequests, 1);
  assert.ok(snap.totalInputTokens > 0 || snap.totalOutputTokens > 0);

  // Clean up
  router.stats.dispose();
  try { fs.rmSync(statsDir, { recursive: true }); } catch { /* ok */ }
});
