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
import {
  loadLabels,
  loadTemplates,
  normalizeScopeOption,
  parseScopeOptions,
  parseSeverityOptions,
  validateLabels,
} from "./sync-labels.mjs";

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
  // 四个 `priority:` 取值必须都能被模板「严重级」节产出（#406 起的双向校验），
  // 故放行对照要带上一条含该节的模板——只给标签不给模板不再算"合规"。
  const templates = [{ file: "tech_debt.md", labels: [], scopes: [], severities: ["p0", "p1", "p2", "p3"] }];
  assert.deepEqual(validateLabels(labels, templates), []);
});

test("负控制：「严重级」勾选项没有对应 priority: 标签被拦（含标签名带空格的坑）", () => {
  const templates = [{ file: "tech_debt.md", labels: [], scopes: [], severities: ["p0", "p9"] }];
  const labels = [{ name: "priority: p0", color: "d73a4a", description: "堵塞" }];
  const errors = validateLabels(labels, templates);
  // 报错文本必须点名 `priority: p9`（带空格）——若实现假设"前缀即标签名起点"，
  // 这里会漏报或写出 `priority:p9` 这种仓库里不存在的标签名。
  assert.ok(errors.some(error => error.includes("「p9」") && error.includes("priority: p9")));
});

test("负控制：模板缺整个「严重级」节时 priority 取值无人对应被拦", () => {
  const labels = [
    { name: "priority: p0", color: "d73a4a", description: "堵塞" },
    { name: "priority: p1", color: "d93f0b", description: "高" },
  ];
  const errors = validateLabels(labels, [{ file: "bug_report.md", labels: [], scopes: [] }]);
  assert.ok(errors.some(error => error.includes("priority: p0") && error.includes("「严重级」节中没有对应勾选项")));
});

test("负控制：两条模板的「严重级」节彼此不一致被拦（缺项与多项都拦）", () => {
  const labels = ["p0", "p1", "p2", "p3"].map(value => ({
    name: `priority: ${value}`,
    color: "d73a4a",
    description: `级别 ${value}`,
  }));
  const missing = validateLabels(labels, [
    { file: "a.md", labels: [], scopes: [], severities: ["p0", "p1", "p2", "p3"] },
    { file: "b.md", labels: [], scopes: [], severities: ["p0", "p1", "p2"] },
  ]);
  assert.ok(missing.some(error => error.includes("b.md") && error.includes("缺勾选项「p3」")));
  const extra = validateLabels(labels, [
    { file: "a.md", labels: [], scopes: [], severities: ["p0", "p1", "p2", "p3"] },
    { file: "b.md", labels: [], scopes: [], severities: ["p0", "p1", "p2", "p3", "ghost"] },
  ]);
  assert.ok(extra.some(error => error.includes("b.md") && error.includes("多出勾选项「ghost」")));
});

test("parseSeverityOptions 只认「严重级」节内的级别前缀，并去重", () => {
  const markdown = [
    "## 风险与影响",
    "- [ ] P0 堵塞",
    "## 严重级",
    "- [ ] P0 堵塞：阻塞合入、可致错误决策或数据损坏（处置：立即）",
    "- [x] P2 中：局部可维护性/可观测性受损",
    "- [ ] P2 中：重复一项",
    "- [ ] 说不清的严重度",
    "## 触发还债条件（必填）",
    "- [ ] P1 高",
  ].join("\n");
  // ① 越界读取的形状：把别的节里的 P1 也读进来 → 会多出一个 p1；
  // ② 认不出的选项**原样保留**（不静默丢弃）：否则「模板写了 P9 / 说不清的严重度」
  //    会既不被门禁发现、也不被分类器产出，成为又一个看不见的盲区。
  assert.deepEqual(parseSeverityOptions(markdown), ["p0", "p2", "说不清的严重度"]);
  assert.deepEqual(parseSeverityOptions("没有这一节"), []);
});

test("负控制：模板写了认不出的级别（P4）被门禁报成「对不上标签」而非静默丢弃", () => {
  const templates = [{ file: "tech_debt.md", labels: [], scopes: [], severities: ["p0", "p4 未知"] }];
  const labels = [{ name: "priority: p0", color: "d73a4a", description: "堵塞" }];
  const errors = validateLabels(labels, templates);
  assert.ok(
    errors.some(error => error.includes("「p4 未知」")),
    `应点名该勾选项：${JSON.stringify(errors)}`,
  );
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

test("集成：documentation.md 模板存在、自带类型标签且带「影响 scope」节（#338）", () => {
  // 这三条不是"函数返回字符串"型断言，而是把 #338 的修复本身钉住：
  // ① 文档类议题必须有自己的模板，否则只能用 bug/feature 模板开、自动落错类型标签；
  // ② 类型标签必须写在 frontmatter —— 那是 GitHub 侧唯一的自动打标入口；
  // ③ 必须含「影响 scope」节 —— 缺整节时它既不产生 scope:*，也不会被模板间比对发现
  //    （见 docs/issue-management.md §2「诚实边界一」，tech_debt.md 曾长期如此）。
  const templates = loadTemplates(ROOT);
  const docTemplate = templates.find(template => template.file === "documentation.md");
  assert.ok(docTemplate, "缺少 documentation.md：文档类议题会退回借 bug/feature 模板开");
  assert.deepEqual(docTemplate.labels, ["documentation"], "frontmatter 的 labels 必须是 documentation（自动打标入口）");
  assert.ok(docTemplate.scopes.length > 0, "必须含「影响 scope」节，否则勾选永远投影不出 scope:*");
});

test("集成：模板 scope 勾选项数量与 scope 标签数量吻合", () => {
  const scopes = new Set(loadTemplates(ROOT).flatMap(template => template.scopes));
  const declared = loadLabels(ROOT).filter(label => label.name.startsWith("scope:"));
  assert.equal(declared.length, scopes.size);
});
