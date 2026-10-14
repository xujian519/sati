/**
 * memory.knowledgeNoteSaveMode 配置解析（WS2 / T2.3 配置面）。
 *
 * 契约：draft（默认）= knowledge_note_save 走草稿闸门；direct = 直写逃生口；
 * 非法值 fail-loud（对齐同文件 captureStrategy 等枚举的读取语义）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseMemoryConfig } from "../../../src/pilot/config/parseMemoryConfig.js";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";

function parse(raw: unknown) {
  const diagnostics: PilotConfigDiagnostic[] = [];
  const config = parseMemoryConfig(raw, diagnostics, "/tmp/memory-root");
  return { config, diagnostics };
}

test("缺省 → draft（闸门默认开，D1 决策）", () => {
  const { config, diagnostics } = parse({});
  assert.equal(config?.knowledgeNoteSaveMode, "draft");
  assert.equal(
    diagnostics.some(d => d.path === "memory.knowledgeNoteSaveMode"),
    false,
    "缺省不应告警",
  );
});

test("显式 draft / direct 均解析", () => {
  assert.equal(parse({ knowledgeNoteSaveMode: "draft" }).config?.knowledgeNoteSaveMode, "draft");
  assert.equal(parse({ knowledgeNoteSaveMode: "direct" }).config?.knowledgeNoteSaveMode, "direct");
});

test("非法值 fail-loud 抛错", () => {
  assert.throws(() => parse({ knowledgeNoteSaveMode: "always" }), /knowledgeNoteSaveMode/);
});

test("字段在 KNOWN_FIELDS 内：不触发 CONFIG_MEMORY_UNKNOWN_FIELD", () => {
  const { diagnostics } = parse({ knowledgeNoteSaveMode: "direct" });
  assert.equal(
    diagnostics.some(d => d.code === "CONFIG_MEMORY_UNKNOWN_FIELD" && d.path === "memory.knowledgeNoteSaveMode"),
    false,
  );
});
