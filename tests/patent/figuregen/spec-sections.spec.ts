/**
 * src/patent/figuregen — V10/V11 括号规则与文字面启发式分节测试。
 *
 * 依据：细则第 22 条（权利要求中的附图标记置于括号内）；说明书正文惯例为
 * "名称+数字"（本项目知识库已核）。两面括号规则相反 ⇒ 必须按面判定，且
 * 分节失败时如实降级（V10/V11 静默 + 结果注明未分节），不猜面判违规。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { checkFigures } from "../../../src/patent/figuregen/check.js";
import { splitSpecFaces } from "../../../src/patent/figuregen/spec-sections.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

/** 图：标记 20（外加 40 用于"正文多括号"用例）。 */
function figWithRefs(): FigureSpec {
  return {
    figure_no: 1,
    kind: "block",
    nodes: [
      { id: "a", label: "输入模块(10)", ref: 10 },
      { id: "b", label: "处理模块(20)", ref: 20 },
    ],
    edges: [{ from: "a", to: "b" }],
  };
}

/** 标准两面文本：权利要求面（带括号）+ 说明书正文面。 */
function text(claims: string, description: string): string {
  return ["## 权利要求书", claims, "", "## 说明书", "## 技术领域", "本发明涉及数据处理领域。", description].join("\n");
}

test("分节：按小节标题切出权利要求面/说明书正文面，并排除附图说明小节", () => {
  const faces = splitSpecFaces(
    text("1. 一种装置，包括处理模块(20)。", "## 具体实施方式\n处理模块20执行处理。\n## 附图说明\n1—混料器；2—电机。"),
  );
  assert.ok(faces.claims?.includes("处理模块(20)"));
  assert.ok(!faces.claims?.includes("本发明涉及数据处理领域"));
  assert.ok(faces.description?.includes("具体实施方式"));
  assert.ok(!faces.descriptionSansBrief?.includes("混料器"), "附图说明小节应从 V11 判定范围排除");
  assert.match(faces.reason, /已识别权利要求面/u);
});

test("分节：无标题但首段形如权利要求条目时兜底识别；完全无分面线索则降级", () => {
  const claimsOnly = splitSpecFaces(
    "1. 一种装置，其特征在于，包括处理模块(20)。\n\n## 技术领域\n本发明涉及数据处理领域。",
  );
  assert.ok(claimsOnly.claims?.includes("其特征在于"));

  const noFaces = splitSpecFaces("一段没有小节标题的说明书文字，提及处理模块(20)。");
  assert.equal(noFaces.claims, undefined);
  assert.equal(noFaces.description, undefined);
  assert.match(noFaces.reason, /无法分面/u);
});

test("分节：空文本降级", () => {
  const faces = splitSpecFaces("   ");
  assert.equal(faces.claims, undefined);
  assert.equal(faces.description, undefined);
  assert.match(faces.reason, /为空/u);
});

test("V10：权利要求面出现未加括号的附图标记 → FAIL", () => {
  const result = checkFigures(
    [figWithRefs()],
    text("1. 一种装置，包括处理模块20，所述处理模块20执行处理。", "## 具体实施方式\n处理模块(20)执行处理。"),
  );
  const v10 = result.findings.filter(f => f.rule === "V10");
  assert.equal(v10.length, 1);
  assert.equal(v10[0].severity, "fail");
  assert.ok(v10[0].evidence?.some(e => e.includes("20")));
  assert.equal(result.ok, false);
  assert.equal(result.specFaces?.sectioned, true);
});

test("V10：权利要求面括号齐备 → 不触发", () => {
  const result = checkFigures(
    [figWithRefs()],
    text("1. 一种装置，包括处理模块(20)。", "## 具体实施方式\n处理模块20执行处理。"),
  );
  assert.deepEqual(
    result.findings.filter(f => f.rule === "V10"),
    [],
  );
});

test("V10：数量词与数值范围不误报（判据收窄至紧跟分隔符/行尾）", () => {
  const result = checkFigures(
    [figWithRefs()],
    text("1. 一种装置，包括20个处理单元，工作温度为20℃至90℃，共20组测试。", "## 具体实施方式\n处理模块20执行处理。"),
  );
  assert.deepEqual(
    result.findings.filter(f => f.rule === "V10"),
    [],
    "数量词/数值范围不得判为附图标记",
  );
});

test("V11：说明书正文以括号引用图内标记 → WARN；不误伤 式(1)/步骤(1) 与附图说明小节", () => {
  const result = checkFigures(
    [figWithRefs()],
    text(
      "1. 一种装置，包括处理模块(20)。",
      [
        "## 具体实施方式",
        "处理模块(20)执行处理，计算式(10)与步骤(20)在此说明。",
        "## 附图说明",
        "图1为整体结构示意图，其中 20—处理模块。",
      ].join("\n"),
    ),
  );
  const v11 = result.findings.filter(f => f.rule === "V11");
  assert.equal(v11.length, 1);
  assert.equal(v11[0].severity, "warn");
  assert.ok(
    v11[0].evidence?.some(e => e.includes("20")),
    "应命中正文中的括号标记",
  );
  // 式(10)/步骤(20) 均被排除：证据不应出现"式"或"步骤"上下文
  assert.ok(!v11[0].evidence?.some(e => /式\(10\)|步骤\(20\)/u.test(e)));
  assert.equal(result.ok, true, "V11 是 warn，不判失败");
});

test("V11：括号内数字不是图内标记时不触发（如公式编号 40 未在图中）", () => {
  const result = checkFigures(
    [figWithRefs()],
    text("1. 一种装置，包括处理模块(20)。", "## 具体实施方式\n计算式(40)给出结果。"),
  );
  assert.deepEqual(
    result.findings.filter(f => f.rule === "V11"),
    [],
  );
});

test("V10/V11：分节失败时静默不报，且结果如实注明未分节", () => {
  const result = checkFigures([figWithRefs()], "1. 一种装置，包括处理模块20。");
  assert.equal(result.specFaces?.sectioned, false);
  assert.match(result.specFaces?.reason ?? "", /无法分面/u);
  assert.deepEqual(
    result.findings.filter(f => f.rule === "V10" || f.rule === "V11"),
    [],
    "未分节时不得猜面判违规",
  );
});

test("V10/V11：skipTextRules 时不产出分节结论（生成期无文本）", () => {
  const result = checkFigures([figWithRefs()], "", { skipTextRules: true });
  assert.equal(result.specFaces, undefined);
  assert.deepEqual(
    result.findings.filter(f => f.rule === "V10" || f.rule === "V11"),
    [],
  );
});
