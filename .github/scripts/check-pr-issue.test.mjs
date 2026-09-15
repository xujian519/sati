import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluatePrTraceability, stripInvisible } from "./check-pr-issue.mjs";

/** 便捷断言：期望命中的路径（或 null 表示不通过）。 */
function expectPath(title, body, path) {
  const result = evaluatePrTraceability(title, body);
  assert.equal(result.pass, path !== null, `pass 应为 ${path !== null}`);
  assert.equal(result.path, path, `path 应为 ${path}`);
}

/** 仓库真实 PR 模板（相对本测试文件定位，避免依赖 cwd）。 */
const PR_TEMPLATE = readFileSync(new URL("../PULL_REQUEST_TEMPLATE.md", import.meta.url), "utf8");

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

test("「No associated issue」豁免通过", () => {
  expectPath("", "No associated issue", "exempt");
});

test("无任何引用的正文不通过", () => {
  expectPath("chore: 改动", "## 说明\n本 PR 不涉及视觉变更（仅后端/文档/配置）", null);
});

test("标题与正文均为空不通过", () => {
  expectPath("", "", null);
});

// ---------------------------------------------------------------------------
// 负控制：本次修复针对的漏洞（issue #332）
// ---------------------------------------------------------------------------

test("【负控制】PR 模板原样（一个字未填）不通过", () => {
  // 模板的填写提示全在 HTML 注释里；剥离注释后无任何真实引用，必须失败。
  // 该用例直接读取真实模板文件，模板改到能找到漏洞的形态时会同步变红。
  expectPath("chore: 随手改点东西", PR_TEMPLATE, null);
});

test("【负控制】注释里的 `Closes #123` 不算可回溯来源", () => {
  expectPath("chore: 空白", "## 描述\n\n<!-- 例如 `Closes #123` / `Fixes #123` -->", null);
});

test("【负控制】注释里的「无关联 issue」提示不算显式豁免", () => {
  expectPath("chore: 空白", "<!-- 确无来源：声明「无关联 issue」 -->", null);
});

test("【负控制】未闭合注释（误删 `-->`）后续内容同样不计入", () => {
  // CommonMark 下未闭合的 HTML 注释一直延伸到文末，渲染后不可见。
  expectPath("chore: 空白", "<!-- 填写提示 `Closes #123`\n正文其它内容", null);
});

test("【负控制】裸 `N/A` 不再构成豁免", () => {
  expectPath("chore: 调整", "| 项 | 值 |\n|---|---|\n| 影响 | N/A |", null);
});

test("【负控制】英文行文 “no issue” 不再构成豁免", () => {
  expectPath("chore: 调整", "There is no issue with this approach.", null);
});

// ---------------------------------------------------------------------------
// 剥离函数本身
// ---------------------------------------------------------------------------

test("stripInvisible 只剥离注释，保留其外的引用", () => {
  const text = stripInvisible("<!-- Closes #999 -->\nCloses #123");
  assert.ok(!text.includes("#999"));
  assert.ok(text.includes("Closes #123"));
});

test("stripInvisible 保留闭合注释之后的正常文本", () => {
  const text = stripInvisible("<!-- 提示 -->\n关联 Issue: #7\n<!-- 尾注 -->");
  assert.equal(text.trim(), "关联 Issue: #7");
});
