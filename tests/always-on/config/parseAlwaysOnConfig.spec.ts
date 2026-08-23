import assert from "node:assert/strict";
import test from "node:test";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";
import { parseAlwaysOnConfig } from "../../../src/always-on/config/parseAlwaysOnConfig.js";

test("enabled without trigger warns that discovery cycles stay off", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseAlwaysOnConfig({ enabled: true }, diagnostics);
  assert.ok(config);
  assert.equal(config.enabled, true);
  assert.equal(config.trigger.enabled, false);
  const warn = diagnostics.find(d => d.code === "ALWAYS_ON_TRIGGER_NOT_ENABLED");
  assert.ok(warn, "expected ALWAYS_ON_TRIGGER_NOT_ENABLED diagnostic");
  assert.equal(warn.severity, "warning");
});

test("enabled with explicit trigger.enabled true produces no warning", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseAlwaysOnConfig({ enabled: true, trigger: { enabled: true } }, diagnostics);
  assert.ok(config);
  assert.equal(config.trigger.enabled, true);
  assert.equal(
    diagnostics.some(d => d.code === "ALWAYS_ON_TRIGGER_NOT_ENABLED"),
    false,
  );
});

test("trigger section present but without explicit enabled still warns", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseAlwaysOnConfig({ enabled: true, trigger: { tickIntervalMinutes: 30 } }, diagnostics);
  assert.ok(config);
  assert.equal(config.trigger.enabled, false);
  assert.ok(
    diagnostics.some(d => d.code === "ALWAYS_ON_TRIGGER_NOT_ENABLED"),
    "expected warning when trigger exists but is not enabled",
  );
});

test("trigger explicitly disabled still warns", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  parseAlwaysOnConfig({ enabled: true, trigger: { enabled: false } }, diagnostics);
  assert.ok(diagnostics.some(d => d.code === "ALWAYS_ON_TRIGGER_NOT_ENABLED"));
});

test("disabled alwaysOn produces no trigger warning", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  parseAlwaysOnConfig({ enabled: false }, diagnostics);
  assert.equal(
    diagnostics.some(d => d.code === "ALWAYS_ON_TRIGGER_NOT_ENABLED"),
    false,
  );
});

test("execution.maxToolCalls is parsed but flagged as not honored", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseAlwaysOnConfig({ execution: { maxToolCalls: 50 } }, diagnostics);
  assert.ok(config);
  assert.equal(config.execution.maxToolCalls, 50);
  const warn = diagnostics.find(d => d.code === "ALWAYS_ON_EXECUTION_MAX_TOOL_CALLS_IGNORED");
  assert.ok(warn, "expected ALWAYS_ON_EXECUTION_MAX_TOOL_CALLS_IGNORED diagnostic");
  assert.equal(warn.severity, "warning");
});

test("workspace.gitLfs is parsed but flagged as not honored", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseAlwaysOnConfig({ workspace: { gitLfs: true } }, diagnostics);
  assert.ok(config);
  assert.equal(config.workspace.gitLfs, true);
  const warn = diagnostics.find(d => d.code === "ALWAYS_ON_WORKSPACE_GIT_LFS_IGNORED");
  assert.ok(warn, "expected ALWAYS_ON_WORKSPACE_GIT_LFS_IGNORED diagnostic");
  assert.equal(warn.severity, "warning");
});
