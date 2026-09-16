/**
 * 标签体系门禁的负控制测试。
 *
 * 核心断言不是"函数能返回字符串"，而是"门禁真的拦得住"：
 * 每条校验规则都配一份**必须变红**的输入，以及一份**必须放行**的对照。
 * 最后的集成用例直接对仓库真实文件跑一遍，防止清单与模板悄悄漂移。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadLabels, loadTemplates, normalizeScopeOption, parseScopeOptions, validateLabels } from "./sync-labels.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const OK_LABEL = { name: "bug", color: "d73a4a", description: "缺陷" };

/** 构造一条合法的 scope 标签。 */
const scopeLabel = name => ({ name: `scope:${name}`, color: "bfd4f2", description: `作用域 ${name}` });

test("parseScopeOptions 提取勾选项并归一化「其他」", () => {
  const markdown = [
    "## 影响 scope",
    "",
    "- [ ] agent",
    "- [ ] always-on",
    "- [ ] 其他: <!-- 填写 -->",
    "",
    "## 下一节",
    "- [ ] 不应被计入",
  ].join("\n");
  assert.deepEqual(parseScopeOptions(markdown), ["agent", "always-on", "other"]);
});

test("parseScopeOptions 对无该节的模板返回空数组", () => {
  assert.deepEqual(parseScopeOptions("## 问题描述\n\n没有 scope 节"), []);
});

test("normalizeScopeOption 去掉注释与尾随冒号", () => {
  assert.equal(normalizeScopeOption("ui"), "ui");
  assert.equal(normalizeScopeOption("UI"), "ui");
  assert.equal(normalizeScopeOption("其他: <!-- 填写 -->"), "other");
  assert.equal(normalizeScopeOption("  agent  "), "agent");
});

test("validateLabels 放行合规清单", () => {
  const templates = [{ file: "bug_report.md", labels: ["bug"], scopes: ["agent"] }];
  const labels = [OK_LABEL, { name: "scope:agent", color: "bfd4f2", description: "Agent" }];
  assert.deepEqual(validateLabels(labels, templates), []);
});

test("负控制：标签名重复被拦", () => {
  const errors = validateLabels([OK_LABEL, { ...OK_LABEL, description: "另一个" }], []);
  assert.ok(errors.some(error => error.includes("重复")));
});

test("负控制：非法 color 被拦", () => {
  const errors = validateLabels([{ ...OK_LABEL, color: "#d73a4a" }], []);
  assert.ok(errors.some(error => error.includes("6 位 hex")));
});

test("负控制：description 缺失或超长被拦", () => {
  const missing = validateLabels([{ name: "bug", color: "d73a4a" }], []);
  assert.ok(missing.some(error => error.includes("缺少 description")));
  const long = validateLabels([{ ...OK_LABEL, description: "x".repeat(101) }], []);
  assert.ok(long.some(error => error.includes("超长")));
});

test("负控制：带前缀标签缺取值被拦", () => {
  const errors = validateLabels([{ name: "status:", color: "d73a4a", description: "空状态" }], []);
  assert.ok(errors.some(error => error.includes("缺取值")));
});

test("负控制：status/priority 取值超出词表被拦", () => {
  // `status: done` 是规范明令禁止的双写状态（终态由关闭表达）；`p9` / `urgent` 是越界优先级。
  for (const name of ["status: done", "priority: p9", "priority: urgent"]) {
    const errors = validateLabels([{ name, color: "d73a4a", description: "越界取值" }], []);
    assert.ok(
      errors.some(error => error.includes("超出词表")),
      `${name} 应被拦`,
    );
  }
});

test("放行对照：status/priority 的合法取值不报", () => {
  const labels = [
    "status: triage",
    "status: in-progress",
    "status: blocked",
    "priority: p0",
    "priority: p1",
    "priority: p2",
    "priority: p3",
  ].map(name => ({ name, color: "d73a4a", description: "合法取值" }));
  assert.deepEqual(validateLabels(labels, []), []);
});

test("边界：scope 取值不受词表约束（由模板双向校验兜底）", () => {
  // 此处的错误来自「标签多出勾选项」，而不是「超出词表」——scope 刻意不在 PREFIX_VALUES 表内。
  const errors = validateLabels([{ name: "scope:ghost", color: "bfd4f2", description: "未对应模板" }], []);
  assert.ok(!errors.some(error => error.includes("超出词表")));
});

test("负控制：模板引用未声明标签被拦", () => {
  const templates = [{ file: "bug_report.md", labels: ["bug", "regression"], scopes: [] }];
  const errors = validateLabels([OK_LABEL], templates);
  assert.ok(errors.some(error => error.includes("未声明的标签：regression")));
});

test("负控制：模板 scope 勾选项缺对应标签被拦", () => {
  const templates = [{ file: "bug_report.md", labels: [], scopes: ["patent"] }];
  const errors = validateLabels([OK_LABEL], templates);
  assert.ok(errors.some(error => error.includes("没有对应的 scope:patent 标签")));
});

test("负控制：多余的 scope 标签被拦（双向校验）", () => {
  const labels = [OK_LABEL, { name: "scope:ghost", color: "bfd4f2", description: "幽灵" }];
  const errors = validateLabels(labels, [{ file: "bug_report.md", labels: [], scopes: [] }]);
  assert.ok(errors.some(error => error.includes("没有对应勾选项")));
});

test("放行对照：两条模板的 scope 勾选项一致时不报", () => {
  const templates = [
    { file: "bug_report.md", labels: [], scopes: ["agent", "other"] },
    { file: "feature_request.md", labels: [], scopes: ["other", "agent"] },
  ];
  assert.deepEqual(validateLabels([OK_LABEL, scopeLabel("agent"), scopeLabel("other")], templates), []);
});

test("负控制：只改了其中一条模板的勾选项被拦（缺项）", () => {
  // 模板并集校验（模板 ↔ 标签）在这组输入下**会放行**——`ui` 在另一条模板里存在；
  // 只有模板之间的比对能发现 feature_request.md 漏了它。
  const templates = [
    { file: "bug_report.md", labels: [], scopes: ["agent", "ui"] },
    { file: "feature_request.md", labels: [], scopes: ["agent"] },
  ];
  const labels = [OK_LABEL, scopeLabel("agent"), scopeLabel("ui")];
  const errors = validateLabels(labels, templates);
  assert.ok(errors.some(error => error.includes("feature_request.md") && error.includes("缺勾选项「ui」")));
});

test("负控制：模板多出勾选项同样被拦（比对是双向的）", () => {
  const templates = [
    { file: "bug_report.md", labels: [], scopes: ["agent"] },
    { file: "feature_request.md", labels: [], scopes: ["agent", "ghost"] },
  ];
  const labels = [OK_LABEL, scopeLabel("agent"), scopeLabel("ghost")];
  const errors = validateLabels(labels, templates);
  assert.ok(errors.some(error => error.includes("feature_request.md") && error.includes("多出勾选项「ghost」")));
});

test("不含「影响 scope」节的模板不参与模板间比对", () => {
  // 合成输入，不绑定仓库实际模板：守的是过滤逻辑本身。
  // 历史上 tech_debt.md 曾是该类模板（TD-PROCGATE-003，2026-09-17 补节）——当时若没有
  // 这条过滤，它会以「缺全部勾选项」的姿态拖累另两条模板的比对。留着是为了下一个新增模板。
  const templates = [
    { file: "bug_report.md", labels: [], scopes: ["agent"] },
    { file: "new_template.md", labels: [], scopes: [] },
  ];
  assert.deepEqual(validateLabels([OK_LABEL, scopeLabel("agent")], templates), []);
});

test("集成：仓库当前标签清单与 issue 模板一致", () => {
  assert.deepEqual(validateLabels(loadLabels(ROOT), loadTemplates(ROOT)), []);
});

test("集成：模板 scope 勾选项数量与 scope 标签数量吻合", () => {
  const scopes = new Set(loadTemplates(ROOT).flatMap(template => template.scopes));
  const declared = loadLabels(ROOT).filter(label => label.name.startsWith("scope:"));
  assert.equal(declared.length, scopes.size);
});
