import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePrTraceability } from "./check-pr-issue.mjs";

/** 便捷断言：期望命中的路径（或 null 表示不通过）。 */
function expectPath(title, body, path) {
  const result = evaluatePrTraceability(title, body);
  assert.equal(result.pass, path !== null, `pass 应为 ${path !== null}`);
  assert.equal(result.path, path, `path 应为 ${path}`);
}

test("关键词 + 编号（标题）通过", () => {
  expectPath("fix: Closes #123 修复问题", "", "issue-link");
});

test("模板原生「关联 Issue: #123」通过", () => {
  expectPath("feat: xxx", "关联 Issue: #123", "issue-link");
});

test("「关联 #42」通过", () => {
  expectPath("", "关联 #42", "issue-link");
});

test("「Fixes #42」通过", () => {
  expectPath("Fixes #42", "", "issue-link");
});

test("裸「#123」引用通过", () => {
  expectPath("", "见 #123 说明", "bare-number");
});

test("技术债编号 TD-PATENT-N06 通过（本次故障回归）", () => {
  expectPath("", "消除技术债务 **TD-PATENT-N06**", "tech-debt");
});

test("多个技术债编号通过", () => {
  expectPath("", "清理 TD-ADAPTERS-N01 / TD-AGENT-101", "tech-debt");
});

test("「无关联 issue」豁免通过", () => {
  expectPath("", "本 PR 无关联 issue", "exempt");
});

test("无任何引用的正文不通过", () => {
  expectPath("chore: 改动", "## 说明\n本 PR 不涉及视觉变更（仅后端/文档/配置）", null);
});

test("标题与正文均为空不通过", () => {
  expectPath("", "", null);
});
