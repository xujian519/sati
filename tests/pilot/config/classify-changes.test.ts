import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyConfigChanges,
  diffConfigSnapshots,
} from "../../../src/pilot/config/classifyChanges.js";
import type { PilotConfigSnapshot } from "../../../src/pilot/config/types.js";

test("alwaysOn.* changes are classified as next-runtime", () => {
  const classes = classifyConfigChanges([
    "alwaysOn.enabled",
    "alwaysOn.trigger.intervalMinutes",
    "alwaysOn.projects./some/path.enabled",
  ]);
  assert.deepEqual(classes, ["next-runtime"]);
});

test("cron.* changes are classified as next-runtime (not restart-required)", () => {
  const classes = classifyConfigChanges([
    "cron.enabled",
    "cron.maxConcurrentRuns",
  ]);
  assert.deepEqual(classes, ["next-runtime"]);
});

test("mixed alwaysOn + agent changes produce both classes", () => {
  const classes = classifyConfigChanges([
    "alwaysOn.enabled",
    "agent.model",
  ]);
  assert.ok(classes.includes("next-runtime"));
  assert.ok(classes.includes("next-request"));
  assert.equal(classes.length, 2);
});

test("diffConfigSnapshots detects alwaysOn changes", () => {
  const base = makeMinimalSnapshot({
    alwaysOn: { enabled: false, trigger: { enabled: true } },
  });
  const next = makeMinimalSnapshot({
    alwaysOn: { enabled: true, trigger: { enabled: true } },
  });
  const paths = diffConfigSnapshots(base, next);
  assert.ok(paths.includes("alwaysOn.enabled"));
});

function makeMinimalSnapshot(
  overrides: Record<string, unknown>,
): PilotConfigSnapshot {
  return {
    version: 1,
    schemaVersion: 1,
    loadedAt: new Date(),
    contentHash: "test",
    sources: [],
    diagnostics: [],
    config: {
      agent: { model: { id: "a", provider: "p", model: "m" }, params: {} },
      model: { providers: {} },
      extension: {
        builtinPluginsEnabled: {},
        includeHookEvents: false,
      },
      ...overrides,
    } as PilotConfigSnapshot["config"],
  };
}
