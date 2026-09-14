/**
 * issue 自动分类器的负控制测试。
 *
 * 重点不在"能打出标签"，而在**不误判**：
 * 契约影响节里有 4–6 个复选框，若分类器越界读取就会给议题糊上错误的 scope 标签，
 * 而错误的自动标签比没有标签更糟（筛选结果失真且无人察觉）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyIssue, loadAllowedScopes } from "./classify-issue.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOWED = new Set(["agent", "ui", "patent", "other"]);

const bodyWith = scopeSection => ["## 问题描述", "", "现象", "", "## 影响 scope", "", scopeSection].join("\n");

test("勾选的 scope 转为标签，并补默认状态", () => {
  const labels = classifyIssue({
    body: bodyWith("- [x] agent\n- [ ] ui\n- [x] patent"),
    allowedScopes: ALLOWED,
  });
  assert.deepEqual(labels, ["scope:agent", "scope:patent", "status: triage"]);
});

test("「其他」带补充说明仍映射为 scope:other", () => {
  const labels = classifyIssue({
    body: bodyWith("- [x] 其他: 桌面端安装器"),
    allowedScopes: ALLOWED,
  });
  assert.deepEqual(labels, ["scope:other", "status: triage"]);
});

test("未勾选任何 scope 时只补默认状态", () => {
  const labels = classifyIssue({ body: bodyWith("- [ ] agent\n- [ ] ui"), allowedScopes: ALLOWED });
  assert.deepEqual(labels, ["status: triage"]);
});

test("无「影响 scope」节时只补默认状态", () => {
  const labels = classifyIssue({ body: "## 问题描述\n\n纯文本", allowedScopes: ALLOWED });
  assert.deepEqual(labels, ["status: triage"]);
});

test("负控制：不越界读取「契约影响」节的复选框", () => {
  const body = [
    "## 影响 scope",
    "",
    "- [ ] agent",
    "",
    "## 契约影响（重要）",
    "",
    "- [x] 工具 `inputSchema`（含描述文本）→ 需重录 llm-replay fixture",
    "- [x] AgentEvent / gateway frames → 需重新生成事件矩阵",
  ].join("\n");
  assert.deepEqual(classifyIssue({ body, allowedScopes: ALLOWED }), ["status: triage"]);
});

test("负控制：白名单外的勾选项被忽略", () => {
  const labels = classifyIssue({ body: bodyWith("- [x] 未声明模块"), allowedScopes: ALLOWED });
  assert.deepEqual(labels, ["status: triage"]);
});

test("已有标签不重复添加", () => {
  const labels = classifyIssue({
    body: bodyWith("- [x] agent"),
    existingLabels: ["scope:agent", "status: in-progress"],
    allowedScopes: ALLOWED,
  });
  assert.deepEqual(labels, []);
});

test("已有状态标签时不再补 triage（尊重人工分诊）", () => {
  const labels = classifyIssue({
    body: bodyWith("- [x] ui"),
    existingLabels: ["status: blocked"],
    allowedScopes: ALLOWED,
  });
  assert.deepEqual(labels, ["scope:ui"]);
});

test("集成：仓库清单声明的 scope 与模板勾选项一致", () => {
  const scopes = loadAllowedScopes(ROOT);
  assert.ok(scopes.has("agent"));
  assert.ok(scopes.has("other"));
  assert.ok(scopes.size >= 15);
});
