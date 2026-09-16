/**
 * issue 自动分类器的负控制测试。
 *
 * 重点不在"能打出标签"，而在**不误判**：
 * 契约影响节里有 4–6 个复选框，若分类器越界读取就会给议题糊上错误的 scope 标签，
 * 而错误的自动标签比没有标签更糟（筛选结果失真且无人察觉）。
 *
 * 其次是把 `scope:*` 的**投影语义**钉死：分类器每次从正文重推、且只增不减，
 * 因此「摘掉标签」对 `scope:*` 不成立（下一次 `edited` 会加回来）。规范正文见
 * `docs/issue-management.md` §5——那里写错过一次，这些用例就是防它再写错。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

// ---- `scope:*` 的投影语义（docs/issue-management.md §5）----
// 规范曾写「自动打错的标签，人工摘掉即可，脚本不会再打回」——这对 `scope:*` **不成立**。
// 下面三条把真实语义钉死：正文是唯一输入，分类器只增不减。

test("scope:* 是正文的投影：只摘标签不改正文，重新分类会再次打上", () => {
  // issue-triage.yml 的触发条件含 `edited`，所以摘掉标签后任何一次正文/标题编辑都会走到这里。
  // 真实场景里议题上还留着 priority:/status:，因此这里不能用"空标签"简化——
  // 那会掩盖「有标签就整体短路」这类错误实现。
  const labels = classifyIssue({
    body: bodyWith("- [x] agent"),
    existingLabels: ["status: triage", "priority: p2"],
    allowedScopes: ALLOWED,
  });
  assert.deepEqual(labels, ["scope:agent"]);
});

test("反向：取消正文勾选不会摘掉已打的标签（分类器从不删标签）", () => {
  const labels = classifyIssue({
    body: bodyWith("- [ ] agent"),
    existingLabels: ["scope:agent", "status: in-progress"],
    allowedScopes: ALLOWED,
  });
  assert.deepEqual(labels, []);
});

test("分类器只产出正文派生的 scope:* 与默认状态，永不产出 priority:/tech-debt", () => {
  // 这是「priority:* / tech-debt 摘掉即生效」在实现侧的根据：它们根本没有生产者。
  const labels = classifyIssue({
    body: bodyWith("- [x] agent\n- [x] 其他: 补个说明"),
    existingLabels: [],
    allowedScopes: ALLOWED,
  });
  assert.ok(
    labels.every(label => label.startsWith("scope:") || label === "status: triage"),
    `意外产出：${labels}`,
  );
});

test("集成：仓库清单声明的 scope 与模板勾选项一致", () => {
  const scopes = loadAllowedScopes(ROOT);
  assert.ok(scopes.has("agent"));
  assert.ok(scopes.has("other"));
  // desktop 是「独立交付边界」判据补上的模块（apps/desktop + 独立 CI job），
  // 少掉它意味着桌面端议题只能落 scope:other。
  assert.ok(scopes.has("desktop"));
  assert.ok(scopes.size >= 15);
});

/** 以 workflow 同款环境变量跑 CLI，返回逐行标签。 */
function runCli(env) {
  const stdout = execFileSync(process.execPath, ["scripts/classify-issue.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return stdout.split("\n").filter(line => line.length > 0);
}

// 回归：CLI 输出的每个标签必须独占一行。标签名合法地包含空格（status: triage），
// 若改用空格/逗号拼接传输，workflow 侧就会把它拆成 'status:' + 'triage' 两个不存在的
// 标签（2026-09-14 实际导致 issue-triage 首次运行失败）。纯函数测试覆盖不到这一层。
test("CLI 契约：带空格的标签独占一行，不被空格拼接", () => {
  const labels = runCli({
    ISSUE_TITLE: "feat: CLI 契约",
    ISSUE_BODY: bodyWith("- [x] agent"),
    ISSUE_LABELS: "",
  });
  assert.deepEqual(labels, ["scope:agent", "status: triage"]);
});

test("CLI 契约：无待添加标签时输出为空", () => {
  const labels = runCli({
    ISSUE_TITLE: "feat: 无新增",
    ISSUE_BODY: bodyWith("- [x] agent"),
    ISSUE_LABELS: "scope:agent,status: in-progress",
  });
  assert.deepEqual(labels, []);
});
