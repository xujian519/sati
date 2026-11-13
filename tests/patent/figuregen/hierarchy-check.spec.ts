/**
 * tests/patent/figuregen/hierarchy-check —— RC8 构造层级 ↔ 权利要求归属表述一致性核对。
 *
 * 契约：
 * - 两边都写明归属且一致 ⇒ 零发现（直接父与间接祖先都算一致）；
 * - 两边都写明归属但对不上 ⇒ 报 RC8（warn），消息含父/子标记与依据，evidence 给两侧比对；
 * - 声明成环 ⇒ 该边被忽略并出一条成环说明（成环边不参与归属判定）；
 * - 声明里没出现过的标记、以及非纯数字形态的标记（`S101` / `20A`）⇒ 不作判据；
 * - 权利要求/说明书里没有归属表述 ⇒ 零发现。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  checkFigureHierarchy,
  type FigureHierarchyEdge,
  type HierarchyCheckFinding,
} from "../../../src/patent/figuregen/hierarchy-check.js";

/** 便捷构造：声明边。 */
const edge = (parent: number, child: number): FigureHierarchyEdge => ({ parent, child });

/** 便捷构造：只取消息文本（便于断言）。 */
const messages = (findings: readonly HierarchyCheckFinding[]): string[] => findings.map(finding => finding.message);

test("归属与声明层级一致：零发现（直接父）", () => {
  const findings = checkFigureHierarchy({
    edges: [edge(31, 311)],
    claimText: "一种恒电位控制器，其特征在于，所述恒电位控制单元31的输入端311与电源相连。",
  });
  assert.deepEqual(findings, []);
});

test("归属与声明层级一致：零发现（间接祖先也算归属）", () => {
  const findings = checkFigureHierarchy({
    edges: [edge(3, 31), edge(31, 311)],
    claimText: "所述壳体3的端口311经由控制单元31引出。",
  });
  assert.deepEqual(findings, []);
});

test("父子对不上：报 RC8（warn），消息含父/子标记与依据", () => {
  const findings = checkFigureHierarchy({
    edges: [edge(3, 31), edge(3, 311)],
    claimText: "所述控制单元31的输入端311与电源相连。",
  });
  assert.equal(findings.length, 1);
  const finding = findings[0]!;
  assert.equal(finding.rule, "RC8");
  assert.equal(finding.severity, "warn");
  assert.match(finding.message, /31/u);
  assert.match(finding.message, /311/u);
  // 依据：条文出处 + 判据落点（声明里 311 实际挂在 3 之下）。
  assert.match(finding.message, /第二十六条第四款/u);
  assert.match(finding.message, /3 之下/u);
  // 证据给出两侧的比对依据。
  assert.equal(finding.evidence?.length, 2);
  assert.match(finding.evidence?.[0] ?? "", /31 的 311/u);
  assert.match(finding.evidence?.[1] ?? "", /311 的直接父标记为 3/u);
});

test("子标记未声明直接父（画在顶层）：同样报 RC8", () => {
  // 311 只作为 312 的父标记出现 ⇒ 声明里它没有父标记（画在顶层）。
  const findings = checkFigureHierarchy({
    edges: [edge(3, 30), edge(311, 312)],
    claimText: "所述控制单元3的输入端311与电源相连。",
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.message, /顶层/u);
  assert.match(findings[0]!.evidence?.[1] ?? "", /未声明直接父标记/u);
});

test("间接祖先也算归属：父标记不是直接父时不报", () => {
  const findings = checkFigureHierarchy({
    edges: [edge(3, 31), edge(31, 311)],
    claimText: "所述壳体3的输入端311与电源相连。",
  });
  assert.deepEqual(findings, []);
});

test("成环边被忽略：出一条成环说明，且该边不参与归属判定", () => {
  const findings = checkFigureHierarchy({
    edges: [edge(1, 2), edge(2, 1)],
    claimText: "",
  });
  assert.equal(findings.length, 1);
  const finding = findings[0]!;
  assert.equal(finding.rule, "RC8");
  assert.equal(finding.severity, "warn");
  assert.match(finding.message, /成环/u);
  assert.match(finding.message, /1 → 2|2 → 1/u);
  assert.match(finding.evidence?.[0] ?? "", /成环/u);

  // 保留的那条边（1 → 2）仍可判定：写「1 的 2」不报归属矛盾。
  const consistent = checkFigureHierarchy({
    edges: [edge(1, 2), edge(2, 1)],
    claimText: "所述部件1的段2与外部连接。",
  });
  assert.equal(consistent.length, 1);
  assert.match(consistent[0]!.message, /成环/u);

  // 被忽略的那条边（2 → 1）不参与判定：写「2 的 1」判为对不上。
  const mismatched = checkFigureHierarchy({
    edges: [edge(1, 2), edge(2, 1)],
    claimText: "所述部件2的段1与外部连接。",
  });
  assert.equal(mismatched.length, 2);
  assert.match(mismatched[0]!.message, /成环/u);
  assert.match(mismatched[1]!.message, /「2…的…1」/u);
});

test("非纯数字形态的标记不参与：字母前缀步骤号 S101", () => {
  const findings = checkFigureHierarchy({
    edges: [edge(101, 311)],
    claimText: "步骤S101的处理单元311与外部连接。",
  });
  assert.deepEqual(findings, []);
});

test("非纯数字形态的标记不参与：大写字母后缀 20A", () => {
  const findings = checkFigureHierarchy({
    edges: [edge(20, 31)],
    claimText: "壳体20A的端口31与外部连接。",
  });
  assert.deepEqual(findings, []);
});

test("非纯数字形态的标记不参与：子标记位置的 S101", () => {
  const findings = checkFigureHierarchy({
    edges: [edge(31, 101)],
    claimText: "控制单元31的处理步骤S101与外部连接。",
  });
  assert.deepEqual(findings, []);
});

test("权利要求无归属表述：零发现", () => {
  const findings = checkFigureHierarchy({
    edges: [edge(31, 311)],
    claimText: "一种装置，其特征在于，所述装置具有采集模块、运算模块与输出模块。",
  });
  assert.deepEqual(findings, []);
});

test("声明里没出现过的标记不判（建模问题不是矛盾）", () => {
  const findings = checkFigureHierarchy({
    edges: [edge(31, 311)],
    claimText: "所述模块50的端口501与外部连接。",
  });
  assert.deepEqual(findings, []);
});

test("标记形态不合法的端点不进入声明层级", () => {
  // 1000 超三位上限 ⇒ 该边整体不参与，12 不算已声明标记。
  const findings = checkFigureHierarchy({
    edges: [edge(1000, 12), edge(13, 14)],
    claimText: "所述外壳12的端口14与外部连接。",
  });
  assert.deepEqual(findings, []);
});

test("序号上下文（权利要求N / 图N）不作标记", () => {
  const findings = checkFigureHierarchy({
    edges: [edge(3, 31), edge(3, 311)],
    claimText: "权利要求1所述的装置如图1所示，所述控制单元31的输入端311与电源相连。",
  });
  // 只判出真正对不上的一对（31 → 311），序号不产生额外发现。
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.message, /31…的…311/u);
});

test("同一对归属表述重复出现：只报一条", () => {
  const findings = checkFigureHierarchy({
    edges: [edge(3, 31), edge(3, 311)],
    claimText: "所述控制单元31的输入端311与电源相连，且所述控制单元31的输入端311与外部连通。",
  });
  assert.equal(findings.length, 1);
});

test("父标记与子标记相同：不判（不是层级归属）", () => {
  const findings = checkFigureHierarchy({
    edges: [edge(31, 311)],
    claimText: "所述标记31的部件31与外部连接。",
  });
  assert.deepEqual(findings, []);
});

test("发现面形状固定：rule=RC8、severity=warn、message 非空", () => {
  const findings = checkFigureHierarchy({
    edges: [edge(3, 31), edge(3, 311)],
    claimText: "所述控制单元31的输入端311与电源相连。",
  });
  assert.ok(findings.length > 0);
  for (const finding of findings) {
    assert.equal(finding.rule, "RC8");
    assert.equal(finding.severity, "warn");
    assert.ok(finding.message.length > 0);
    assert.ok(messages(findings).includes(finding.message));
  }
});
