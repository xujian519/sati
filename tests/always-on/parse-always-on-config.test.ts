import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  defaultAlwaysOnConfig,
  parseAlwaysOnConfig,
} from "../../src/always-on/config/parseAlwaysOnConfig.js";
import type { PilotConfigDiagnostic } from "../../src/pilot/config/types.js";

test("parseAlwaysOnConfig returns undefined when section is absent", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const result = parseAlwaysOnConfig(undefined, diagnostics);
  assert.equal(result, undefined);
  assert.deepEqual(diagnostics, []);
});

test("parseAlwaysOnConfig fills defaults for empty section", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const result = parseAlwaysOnConfig({}, diagnostics);
  assert.ok(result);
  assert.deepEqual(result, defaultAlwaysOnConfig());
  assert.deepEqual(diagnostics, []);
});

test("parseAlwaysOnConfig accepts the flat documented schema", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const result = parseAlwaysOnConfig(
    {
      enabled: true,
      trigger: {
        enabled: true,
        tickIntervalMinutes: 7,
        cooldownMinutes: 30,
        dailyBudget: 6,
        heartbeatStaleSeconds: 60,
        recentUserMsgMinutes: 2,
        preferChannel: "tui",
      },
      dormancy: {
        enabled: false,
        debounceMs: 1500,
        ignoreGlobs: ["**/.git/**", "**/build/**"],
      },
      workspace: {
        gitWorktreeBaseDir: "/tmp/wt",
        snapshotBaseDir: "/tmp/snap",
        snapshotMaxBytes: 5_000_000,
        gitLfs: true,
      },
      execution: {
        maxTurns: 10,
        maxToolCalls: 50,
        timeoutMinutes: 5,
      },
      projects: {
        "/var/code/proj-a": { enabled: true },
      },
    },
    diagnostics,
  );

  assert.ok(result);
  assert.equal(result.enabled, true);
  assert.equal(result.trigger.preferChannel, "tui");
  assert.equal(result.dormancy.enabled, false);
  assert.deepEqual(result.dormancy.ignoreGlobs, ["**/.git/**", "**/build/**"]);
  assert.equal(result.workspace.gitWorktreeBaseDir, "/tmp/wt");
  assert.equal(result.workspace.snapshotMaxBytes, 5_000_000);
  assert.equal(result.workspace.gitLfs, true);
  assert.equal(result.execution.maxTurns, 10);
  assert.deepEqual(result.projects[resolve("/var/code/proj-a")], { enabled: true });
  assert.equal(diagnostics.length, 0);
});

test("parseAlwaysOnConfig flags removed fields with fatal diagnostics", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const result = parseAlwaysOnConfig(
    {
      enabled: true,
      discovery: { trigger: { enabled: true } },
      plan: { maxPlansPerFire: 3 },
      workspace: {
        strategy: "snapshot-copy",
        maxConcurrentEnvs: 1,
        retainSuccessfulEnvs: true,
        retainFailedEnvs: false,
      },
      execution: { permissionMode: "default" },
      projects: {
        "/var/code/proj-a": {
          enabled: true,
          sessionKey: "manual",
          workspace: { strategy: "git-worktree" },
        },
      },
    },
    diagnostics,
  );

  assert.ok(result);
  const codes = diagnostics.map((entry) => `${entry.code}:${entry.path ?? ""}`).sort();
  assert.deepEqual(codes, [
    "ALWAYS_ON_FIELD_REMOVED:alwaysOn.discovery",
    "ALWAYS_ON_FIELD_REMOVED:alwaysOn.execution.permissionMode",
    "ALWAYS_ON_FIELD_REMOVED:alwaysOn.plan",
    `ALWAYS_ON_FIELD_REMOVED:alwaysOn.projects.${"/var/code/proj-a"}.sessionKey`,
    `ALWAYS_ON_FIELD_REMOVED:alwaysOn.projects.${"/var/code/proj-a"}.workspace`,
    "ALWAYS_ON_FIELD_REMOVED:alwaysOn.workspace.maxConcurrentEnvs",
    "ALWAYS_ON_FIELD_REMOVED:alwaysOn.workspace.retainFailedEnvs",
    "ALWAYS_ON_FIELD_REMOVED:alwaysOn.workspace.retainSuccessfulEnvs",
    "ALWAYS_ON_FIELD_REMOVED:alwaysOn.workspace.strategy",
  ]);
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.severity, "fatal");
    assert.equal(diagnostic.recoverable, false);
  }
});

test("parseAlwaysOnConfig warns on unknown project field but only keeps enabled", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const result = parseAlwaysOnConfig(
    {
      enabled: true,
      projects: {
        "/var/code/proj-a": { enabled: true, color: "blue" },
      },
    },
    diagnostics,
  );
  assert.ok(result);
  assert.deepEqual(result.projects[resolve("/var/code/proj-a")], { enabled: true });
  const warnings = diagnostics.filter((entry) => entry.severity === "warning");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "ALWAYS_ON_PROJECT_UNKNOWN_FIELD");
});

test("parseAlwaysOnConfig parses valid language field", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const result = parseAlwaysOnConfig({ language: "zh-CN" }, diagnostics);
  assert.ok(result);
  assert.equal(result.language, "zh-CN");
  assert.equal(diagnostics.length, 0);
});

test("parseAlwaysOnConfig parses language: en", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const result = parseAlwaysOnConfig({ language: "en" }, diagnostics);
  assert.ok(result);
  assert.equal(result.language, "en");
  assert.equal(diagnostics.length, 0);
});

test("parseAlwaysOnConfig ignores invalid language with warning", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const result = parseAlwaysOnConfig({ language: "fr" }, diagnostics);
  assert.ok(result);
  assert.equal(result.language, undefined);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "ALWAYS_ON_LANGUAGE_INVALID");
  assert.equal(diagnostics[0].severity, "warning");
});

test("parseAlwaysOnConfig leaves language undefined when absent", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const result = parseAlwaysOnConfig({}, diagnostics);
  assert.ok(result);
  assert.equal(result.language, undefined);
  assert.equal(diagnostics.length, 0);
});

test("parseAlwaysOnConfig falls back on invalid numbers with warning diagnostics", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const result = parseAlwaysOnConfig(
    {
      trigger: {
        tickIntervalMinutes: -1,
      },
    },
    diagnostics,
  );
  assert.ok(result);
  assert.equal(result.trigger.tickIntervalMinutes, defaultAlwaysOnConfig().trigger.tickIntervalMinutes);
  const codes = diagnostics.map((entry) => entry.code);
  assert.ok(codes.includes("ALWAYS_ON_NUMBER_INVALID"));
});
