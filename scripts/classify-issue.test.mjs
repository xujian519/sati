/**
 * issue 自动分类器的负控制测试。
 *
 * 重点不在"能打出标签"，而在**不误判**：
 * 契约影响节里有 4–6 个复选框，若分类器越界读取就会给议题糊上错误的 scope 标签，
 * 而错误的自动标签比没有标签更糟（筛选结果失真且无人察觉）。
 *
 * 其次是把 `scope:*` 与 `priority:*` 的**投影语义**钉死：分类器每次从正文重推、且只增不减，
 * 因此「摘掉标签」对 `scope:*` 与「严重级」推出的 `priority:*` 不成立（下一次 `edited`
 * 会加回来）。规范正文见 `docs/issue-management.md` §5——那里写错过一次，这些用例就是防它再写错。
 *
 * #406 起「严重级」节成为 `priority:*` 的唯一生产者（此前该维度无生产者、可被整体跳过）；
 * 新增用例覆盖它的四条边界：越界取值 / 缺节 / 多选 / 已有 priority 时不覆盖人工结论。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyIssue, loadAllowedPriorities, loadAllowedScopes } from "./classify-issue.mjs";

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

test("分类器不再产出 priority:/tech-debt——除「严重级」节外（#406）", () => {
  // 「priority:* / tech-debt 摘掉即生效」在实现侧的根据：正文里没有对应的节就没有生产者。
  // #406 起「严重级」节成为 priority 的唯一生产者，故这里刻意**不带**该节。
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

// ---- 严重级 → priority: pN（#406）----
// 四维里 priority 曾是唯一无生产者的一维：「定级」可被整体跳过且无人发现。
// 下面把新规则的边界（越界取值 / 缺节 / 多选 / 不越界 / 不覆盖人工结论）逐条钉死。

const PRIORITIES = new Set(["p0", "p1", "p2", "p3"]);

/** 拼一个「严重级」节在「影响 scope」节之后的正文（模板真实顺序）。 */
const bodyWithSeverity = (severitySection, scopeSection = "- [ ] agent") =>
  ["## 影响 scope", "", scopeSection, "", "## 风险与影响", "", "现象", "", "## 严重级", "", severitySection].join("\n");

test("勾选严重级转为 priority: pN（标签名带空格，与 status: 同风格）", () => {
  const labels = classifyIssue({
    body: bodyWithSeverity("- [ ] P0 堵塞\n- [x] P1 高：主链路性能/可维护性明显受损（处置：短期排期）"),
    allowedScopes: ALLOWED,
    allowedPriorities: PRIORITIES,
  });
  // 顺序契约：作用域按正文顺序 → 再严重级 → 状态在末尾。
  assert.deepEqual(labels, ["priority: p1", "status: triage"]);
});

test("多选取最严重的一档（同一维度至多一个标签）", () => {
  const labels = classifyIssue({
    body: bodyWithSeverity("- [x] P3 低\n- [x] P1 高\n- [x] P2 中"),
    allowedScopes: ALLOWED,
    allowedPriorities: PRIORITIES,
  });
  assert.deepEqual(labels, ["priority: p1", "status: triage"]);
});

test("负控制：越界取值（模式外与白名单外）都不产出 priority", () => {
  // ① 认不出级别前缀：`P9`（超出 P0–P3）、`P4`、无级别词的描述
  for (const option of ["P9 紧急：线上事故", "P4 未知档", "紧急但不写级别"]) {
    const labels = classifyIssue({
      body: bodyWithSeverity(`- [x] ${option}`),
      allowedScopes: ALLOWED,
      allowedPriorities: PRIORITIES,
    });
    assert.deepEqual(labels, ["status: triage"], `「${option}」不应产出 priority`);
  }
  // ② 认得出级别但清单没声明该标签（白名单过滤，防止打出不存在的标签）
  const labels = classifyIssue({
    body: bodyWithSeverity("- [x] P2 中"),
    allowedScopes: ALLOWED,
    allowedPriorities: new Set(["p0", "p1"]),
  });
  assert.deepEqual(labels, ["status: triage"]);
});

test("负控制：无「严重级」节时只补默认状态", () => {
  const labels = classifyIssue({
    body: bodyWith("- [x] agent"),
    allowedScopes: ALLOWED,
    allowedPriorities: PRIORITIES,
  });
  assert.deepEqual(labels, ["scope:agent", "status: triage"]);
});

test("负控制：不越界读取其它节的级别勾选", () => {
  // 「触发还债条件」节里出现 P1 的字样，但「严重级」节一个都没勾。
  const body = [
    "## 影响 scope",
    "",
    "- [ ] agent",
    "",
    "## 严重级",
    "",
    "- [ ] P0 堵塞",
    "- [ ] P1 高",
    "",
    "## 触发还债条件（必填）",
    "",
    "- [x] 下次改 P1 模块时顺带还清",
  ].join("\n");
  assert.deepEqual(classifyIssue({ body, allowedScopes: ALLOWED, allowedPriorities: PRIORITIES }), ["status: triage"]);
});

test("已有 priority:* 时不加第二个（分诊结论优先于模板勾选）", () => {
  // §1 规定同一维度至多一个标签：若正文说 P0、人工已定 P2，再加一个会同时挂两档。
  const labels = classifyIssue({
    body: bodyWithSeverity("- [x] P0 堵塞"),
    existingLabels: ["priority: p2", "status: in-progress"],
    allowedScopes: ALLOWED,
    allowedPriorities: PRIORITIES,
  });
  assert.deepEqual(labels, []);
});

test("集成：清单声明的 priority 白名单覆盖 p0–p3", () => {
  const priorities = loadAllowedPriorities(ROOT);
  // 标签名带空格（`priority: p0`）——只按 startsWith("priority:") 匹配的单测输入
  // 掩盖不了这一点，故这里对**真实清单**断言取值。
  assert.deepEqual([...priorities].sort(), ["p0", "p1", "p2", "p3"]);
});

test("集成：真模板勾选 P1 → CLI 输出 priority: p1（独占一行）", () => {
  const template = readFileSync(join(ROOT, ".github/ISSUE_TEMPLATE/tech_debt.md"), "utf8");
  assert.ok(template.includes("- [ ] P1 高"), "模板的严重级选项文本变了——本用例的同源断言需同步");
  const body = template.replace("- [ ] P1 高", "- [x] P1 高");
  const labels = runCli({ ISSUE_TITLE: "tech-debt: 端到端", ISSUE_BODY: body, ISSUE_LABELS: "" });
  assert.deepEqual(labels, ["priority: p1", "status: triage"]);
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
