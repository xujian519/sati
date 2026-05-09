import assert from "node:assert/strict";
import test from "node:test";
import { defaultCronConfig, parseCronConfig } from "../../src/cron/index.js";
import type { PolitConfigDiagnostic } from "../../src/polit/config/types.js";

test("parseCronConfig returns undefined when section is absent", () => {
  const diagnostics: PolitConfigDiagnostic[] = [];
  assert.equal(parseCronConfig(undefined, diagnostics), undefined);
  assert.deepEqual(diagnostics, []);
});

test("parseCronConfig fills defaults for empty section", () => {
  const diagnostics: PolitConfigDiagnostic[] = [];
  assert.deepEqual(parseCronConfig({}, diagnostics), defaultCronConfig());
  assert.deepEqual(diagnostics, []);
});

test("parseCronConfig accepts documented fields", () => {
  const diagnostics: PolitConfigDiagnostic[] = [];
  const config = parseCronConfig(
    { enabled: false, timezone: "Asia/Shanghai", maxConcurrentRuns: 3 },
    diagnostics,
  );
  assert.deepEqual(config, {
    enabled: false,
    timezone: "Asia/Shanghai",
    maxConcurrentRuns: 3,
  });
  assert.deepEqual(diagnostics, []);
});

test("parseCronConfig warns and falls back on invalid values", () => {
  const diagnostics: PolitConfigDiagnostic[] = [];
  const config = parseCronConfig({ timezone: "", maxConcurrentRuns: 0, extra: true }, diagnostics);
  assert.deepEqual(config, defaultCronConfig());
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.code).sort(),
    ["CRON_NUMBER_INVALID", "CRON_STRING_INVALID", "CRON_UNKNOWN_FIELD"],
  );
});
