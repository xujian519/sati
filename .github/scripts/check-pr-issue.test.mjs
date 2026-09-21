import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluatePrTraceability, stripInvisible } from "./check-pr-issue.mjs";

/** 便捷断言：期望命中的路径（或 null 表示不通过）。 */
function expectPath(title, body, path, author) {
  const result = evaluatePrTraceability(title, body, author);
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
// 自动化依赖升级 bot 豁免（2026-09-21）。判据用真实 PR 正文形态：
// 下面三段 body 分别取自本轮 dependabot PR #490（ws，正文无 `#编号`）与
// #487（react-router-dom，changelog 里恰好带 `#15498`）—— 同一批 PR 的判定
// 结果本不应由上游 changelog 的写法决定。
// ---------------------------------------------------------------------------

/** 真实形态：release notes 里**没有** `#编号`（对应 #490 ws）。 */
const BOT_BODY_NO_REF = [
  "Bumps [ws](https://github.com/websockets/ws) from 8.21.1 to 8.21.3.",
  "<details><summary>Release notes</summary>",
  "<li>The server now correctly rejects permessage-deflate offers (e97a20ea).</li>",
  "</details>",
].join("\n");

/** 真实形态：changelog 里**恰好有** `#编号`（对应 #487 react-router-dom）。 */
const BOT_BODY_WITH_REF = [
  "Bumps [react-router-dom](https://github.com/remix-run/react-router) from 7.18.2 to 7.18.4.",
  '<li>Release v7.18.4 (<a href="...">#15498</a>)</li>',
].join("\n");

test("dependabot 的依赖升级 PR 通过（正文无任何 issue 引用）", () => {
  expectPath("chore(deps): bump ws from 8.21.1 to 8.21.3 in /ui", BOT_BODY_NO_REF, "bot", "dependabot[bot]");
});

test("dependabot 的依赖升级 PR 通过（changelog 恰好带 #编号，同样是 bot 路径）", () => {
  // 与上一条同为 bot，必须走同一条路径 —— 判定结果不随上游 changelog 写法摆动。
  expectPath("chore(deps): bump react-router-dom from 7.18.2 to 7.18.4", BOT_BODY_WITH_REF, "bot", "dependabot[bot]");
});

test("Renovate 的依赖升级 PR 通过", () => {
  expectPath("chore(deps): update dependency ws to v8.21.3", "", "bot", "renovate[bot]");
});

test("【负控制】人类账号即使正文与 dependabot 完全一致也不豁免", () => {
  // 同一份 body、换成人类作者 ⇒ 必须回到「无引用即失败」。
  // 若豁免写成按正文形态（而非作者身份）判定，本用例会转绿而漏放行。
  expectPath("chore(deps): bump ws from 8.21.1 to 8.21.3", BOT_BODY_NO_REF, null, "xujian519");
});

test("【负控制】昵称含 dependabot 的人类账号不豁免（缺少 [bot] 后缀）", () => {
  // 豁免面只开给 GitHub App 身份；`dependabot-fan` 这类账号必须照常判失败。
  expectPath("chore: 随手改点东西", "## 说明\n本次调整若干配置", null, "dependabot-fan");
});

test("【负控制】空作者不触发 bot 分支", () => {
  expectPath("chore: 改动", "## 说明\n不涉及视觉变更", null, "");
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
