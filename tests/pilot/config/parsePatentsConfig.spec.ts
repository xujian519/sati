/**
 * TASK-P2-05 测试：patents.* 配置解析三态。
 *
 * - 未配置 → undefined（快照不含该节）；
 * - 配置 downloadDir → 非空字符串原样保留（trim）；
 * - 非法类型（非对象 / 空字符串 / 非字符串）→ fatal diagnostic + 字段缺失；
 * - 未知字段 → warning 容忍。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parsePatentsConfig } from "../../../src/pilot/config/parsePatentsConfig.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";

test("未配置：patents 节缺失 → undefined（快照不含该节）", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const config = parsePatentsConfig(undefined, diagnostics);

  assert.equal(config, undefined);
  assert.deepEqual(diagnostics, []);
});

test("配置：downloadDir 非空字符串保留（trim）", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const config = parsePatentsConfig({ downloadDir: "  ~/Patents  " }, diagnostics);

  assert.deepEqual(config, { downloadDir: "~/Patents" });
  assert.deepEqual(diagnostics, []);
});

test("非法类型：downloadDir 为空字符串 → fatal，字段不落快照", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const config = parsePatentsConfig({ downloadDir: "" }, diagnostics);

  assert.deepEqual(config, undefined);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "PATENTS_DOWNLOAD_DIR_INVALID");
  assert.equal(diagnostics[0]?.severity, "fatal");
});

test("非法类型：downloadDir 非字符串（数字）→ fatal", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  parsePatentsConfig({ downloadDir: 42 }, diagnostics);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "PATENTS_DOWNLOAD_DIR_INVALID");
  assert.equal(diagnostics[0]?.path, "patents.downloadDir");
});

test("非法类型：patents 非对象（字符串）→ fatal PATENTS_CONFIG_INVALID", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  parsePatentsConfig("~/Patents", diagnostics);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "PATENTS_CONFIG_INVALID");
});

test("未知字段 → warning 容忍，不影响已知字段", () => {
  const diagnostics: PilotConfigDiagnostic[] = [];

  const config = parsePatentsConfig({ downloadDir: "/tmp/p", futureField: 1 }, diagnostics);

  assert.deepEqual(config, { downloadDir: "/tmp/p" });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "PATENTS_UNKNOWN_FIELD");
  assert.equal(diagnostics[0]?.severity, "warning");
});
