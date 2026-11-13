/**
 * patent_figure_compare 工具测试（工具化暴露）。
 *
 * 覆盖：工具元数据、完全一致（无发现）、缺标记、多标记、同号异名、同号异类型，
 * 以及多幅图的分组与跨幅汇总、入参校验（fail-loud）与输出契约零违约。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createPatentFigureCompareTool,
  type PatentFigureCompareInput,
  type PatentFigureCompareOutput,
} from "../../src/tool/builtin/patentFigureCompare.js";
import { validateCanonicalOutput } from "../../src/tool/execution/outputSchemaValidation.js";
import { SatiToolRuntimeError } from "../../src/tool/protocol/errors.js";
import type { SatiToolRuntimeContext } from "../../src/tool/protocol/types.js";

function context(cwd = process.cwd()): SatiToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

/** 调用工具并取出 canonical data（缺 data 即视为契约破损，直接失败）。 */
async function run(input: PatentFigureCompareInput): Promise<PatentFigureCompareOutput> {
  const tool = createPatentFigureCompareTool();
  const result = await tool.execute(input, context());
  assert.ok(result.data !== undefined, "工具应返回 canonical data");
  return result.data;
}

test("patent_figure_compare: 工具元数据（只读 / 并发安全 / 域 / 契约已声明）", () => {
  const tool = createPatentFigureCompareTool();
  assert.equal(tool.name, "patent_figure_compare");
  assert.equal(tool.title, "Compare Patent Figure Analysis");
  assert.equal(tool.domain, "patent");
  assert.equal(tool.kind, "custom");
  assert.deepEqual(tool.aliases, ["PatentFigureCompare", "figure_compare"]);
  assert.equal(tool.isReadOnly({ declared: [], analysis: [] }), true);
  assert.equal(tool.isConcurrencySafe({ declared: [], analysis: [] }), true);
  assert.ok(tool.outputSchema !== undefined, "outputSchema 必须声明（注册表强制校验）");
  assert.ok(tool.description.includes("patent-illustrator"), "描述应指向 patent-illustrator 技能");
  assert.ok(tool.description.length <= 1200, `描述过长：${String(tool.description.length)} 字符`);
});

test("patent_figure_compare: 两侧完全一致 → 无发现且 ok=true", async () => {
  const data = await run({
    declared: [{ figure_no: 1, refs: [10, 20], names: ["壳体", "盖板"], types: ["mechanical", "mechanical"] }],
    analysis: [{ figure_no: 1, refs: [10, 20], names: ["壳体", "盖板"], types: ["mechanical", "mechanical"] }],
  });
  assert.equal(data.ok, true);
  assert.deepEqual(data.findings, []);
  assert.equal(data.declared_count, 2);
  assert.equal(data.analysis_count, 2);
  assert.equal(data.figure_count, 1);
  assert.deepEqual(data.figures, [{ figure_no: 1, declared_count: 2, analysis_count: 2, ok: true }]);
  assert.match(data.summary, /图文比对通过/u);
});

test("patent_figure_compare: 声明有、识图没有 → 缺标记（ok=false）", async () => {
  const data = await run({
    declared: [{ figure_no: 1, refs: [10, 20], names: ["壳体", "盖板"] }],
    analysis: [{ figure_no: 1, refs: [10], names: ["壳体"] }],
  });
  assert.equal(data.ok, false);
  assert.equal(data.findings.length, 1);
  const finding = data.findings[0];
  assert.equal(finding.kind, "missing-component");
  assert.equal(finding.severity, "fail");
  assert.equal(finding.figure_no, 1);
  assert.equal(finding.ref, "20");
  assert.match(finding.message, /未识别到/u);
  assert.deepEqual(finding.evidence, ["声明标记：20", "声明名称：盖板"]);
  assert.equal(data.declared_count, 2);
  assert.equal(data.analysis_count, 1);
});

test("patent_figure_compare: 识图有、声明没有 → 多标记（ok=false）", async () => {
  const data = await run({
    declared: [{ figure_no: 1, refs: [10], names: ["壳体"] }],
    analysis: [{ figure_no: 1, refs: [10, 30], names: ["壳体", "螺栓"] }],
  });
  assert.equal(data.ok, false);
  assert.equal(data.findings.length, 1);
  const finding = data.findings[0];
  assert.equal(finding.kind, "extra-component");
  assert.equal(finding.ref, "30");
  assert.match(finding.message, /声明中未列出/u);
  assert.deepEqual(finding.evidence, ["识图标记：30", "识图名称：螺栓"]);
});

test("patent_figure_compare: 同一标记两侧名称不同 → 同号异名（ok=false）", async () => {
  const data = await run({
    declared: [{ figure_no: 1, refs: [10], names: ["壳体"] }],
    analysis: [{ figure_no: 1, refs: [10], names: ["盖板"] }],
  });
  assert.equal(data.ok, false);
  assert.equal(data.findings.length, 1);
  const finding = data.findings[0];
  assert.equal(finding.kind, "name-mismatch");
  assert.equal(finding.ref, "10");
  assert.match(finding.message, /壳体/u);
  assert.match(finding.message, /盖板/u);
  assert.deepEqual(finding.evidence, ["声明名称：壳体", "识图名称：盖板"]);
});

test("patent_figure_compare: 同一标记两侧类型不同 → 同号异类型（ok=false）", async () => {
  const data = await run({
    declared: [{ figure_no: 1, refs: [10], names: ["壳体"], types: ["mechanical"] }],
    analysis: [{ figure_no: 1, refs: [10], names: ["壳体"], types: ["software"] }],
  });
  assert.equal(data.ok, false);
  assert.equal(data.findings.length, 1);
  const finding = data.findings[0];
  assert.equal(finding.kind, "type-mismatch");
  assert.equal(finding.ref, "10");
  assert.match(finding.message, /mechanical/u);
  assert.match(finding.message, /software/u);
  assert.deepEqual(finding.evidence, ["声明类型：mechanical", "识图类型：software"]);
});

test("patent_figure_compare: 空名称不判名称冲突（模块口径）", async () => {
  const data = await run({
    declared: [{ figure_no: 1, refs: [10], names: [""] }],
    analysis: [{ figure_no: 1, refs: [10], names: ["壳体"] }],
  });
  assert.equal(data.ok, true);
  assert.deepEqual(data.findings, []);
});

test("patent_figure_compare: 多幅附图按图号分组比对，跨幅汇总计数", async () => {
  const data = await run({
    declared: [
      { figure_no: 1, refs: [10], names: ["壳体"], types: ["mechanical"] },
      { figure_no: 2, refs: [20], names: ["盖板"], types: ["mechanical"] },
    ],
    analysis: [
      { figure_no: 1, refs: [10], names: ["壳体"], types: ["mechanical"] },
      { figure_no: 2, refs: [20], names: ["外壳"], types: ["mechanical"] },
    ],
  });
  assert.equal(data.ok, false);
  assert.equal(data.figure_count, 2);
  assert.equal(data.findings.length, 1);
  assert.equal(data.findings[0].figure_no, 2, "发现须带图号上下文");
  assert.equal(data.findings[0].kind, "name-mismatch");
  assert.equal(data.declared_count, 2);
  assert.equal(data.analysis_count, 2);
  assert.deepEqual(
    data.figures.map(figure => [figure.figure_no, figure.ok]),
    [
      [1, true],
      [2, false],
    ],
  );
});

test("patent_figure_compare: 输出契约零违约（data 满足声明的 outputSchema）", async () => {
  const tool = createPatentFigureCompareTool();
  const data = await run({
    declared: [{ figure_no: 1, refs: [10, 20], names: ["壳体", "盖板"], types: ["mechanical", "software"] }],
    analysis: [{ figure_no: 1, refs: [10, 30], names: ["壳体", "螺栓"], types: ["mechanical", "mechanical"] }],
  });
  assert.deepEqual(validateCanonicalOutput(data, tool.outputSchema ?? {}), []);
});

test("patent_figure_compare: 报告文本如实反映发现（不把「有发现」说成通过）", async () => {
  const tool = createPatentFigureCompareTool();
  const result = await tool.execute(
    {
      declared: [{ figure_no: 1, refs: [10], names: ["壳体"] }],
      analysis: [{ figure_no: 1, refs: [10, 30], names: ["壳体", "螺栓"] }],
    },
    context(),
  );
  const text = result.content.map(entry => (entry.type === "text" ? entry.text : "")).join("\n");
  assert.match(text, /发现 1 处不一致/u);
  assert.match(text, /extra-component/u);
  assert.doesNotMatch(text, /图文比对通过/u);
});

test("patent_figure_compare: 两侧都为空 → invalid_tool_input（零比对不是通过）", async () => {
  await assert.rejects(
    () => run({ declared: [], analysis: [] }),
    (error: unknown) => {
      assert.ok(error instanceof SatiToolRuntimeError);
      assert.equal(error.code, "invalid_tool_input");
      return true;
    },
  );
});

test("patent_figure_compare: 附图标记超出 1..999 → invalid_tool_input", async () => {
  await assert.rejects(
    () => run({ declared: [{ figure_no: 1, refs: [1000] }], analysis: [{ figure_no: 1, refs: [1] }] }),
    (error: unknown) => {
      assert.ok(error instanceof SatiToolRuntimeError);
      assert.equal(error.code, "invalid_tool_input");
      return true;
    },
  );
});

test("patent_figure_compare: names/types 与 refs 不等长 → invalid_tool_input", async () => {
  await assert.rejects(
    () =>
      run({ declared: [{ figure_no: 1, refs: [10, 20], names: ["壳体"] }], analysis: [{ figure_no: 1, refs: [10] }] }),
    (error: unknown) => {
      assert.ok(error instanceof SatiToolRuntimeError);
      assert.equal(error.code, "invalid_tool_input");
      return true;
    },
  );
  await assert.rejects(
    () =>
      run({
        declared: [{ figure_no: 1, refs: [10], types: ["mechanical"] }],
        analysis: [{ figure_no: 1, refs: [10], types: ["不存在的类型"] }],
      }),
    (error: unknown) => {
      assert.ok(error instanceof SatiToolRuntimeError);
      assert.equal(error.code, "invalid_tool_input");
      return true;
    },
  );
});

test("patent_figure_compare: 同一侧重复图号 → invalid_tool_input", async () => {
  await assert.rejects(
    () =>
      run({
        declared: [
          { figure_no: 1, refs: [10] },
          { figure_no: 1, refs: [20] },
        ],
        analysis: [{ figure_no: 1, refs: [10] }],
      }),
    (error: unknown) => {
      assert.ok(error instanceof SatiToolRuntimeError);
      assert.equal(error.code, "invalid_tool_input");
      return true;
    },
  );
});
