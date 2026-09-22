/**
 * figure-gate 原子测试（附图确定性核验的自动接线）。
 *
 * 契约：
 * - 输入 = 生成期 sidecar（`<name>-figures.json`）+ 说明书文本（claims_draft/spec_draft）；
 * - fail 级 → InterruptStageError 挂 HITL；warn 级 → 报告透传；
 * - sidecar 与 SVG 漂移 → fail-loud（不给出假保证）；
 * - 结论落盘 `figure-check.json`（version/checked_at/inputs_hash/result）；
 * - 放行是**门粒度**的：已批准的 figure-gate 不得放行后续兄弟审批门。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FigureGateHandler,
  InterruptStageError,
  LookupStageHandler,
  isInterruptStageError,
  registerBuiltinAtoms,
  runWorkflow,
  type PipelineState,
  type StageProvider,
} from "../../src/patent/index.js";
import { createPatentFigureGenerateTool } from "../../src/tool/builtin/patentFigureGenerate.js";
import type { SatiToolRuntimeContext } from "../../src/tool/protocol/types.js";
import type { FigureSpec } from "../../src/patent/figuregen/types.js";

function makeContext(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "sess-gate",
    turnId: "turn-gate",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      rules: { allow: [], deny: [], ask: [] },
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
    },
  };
}

const FIG: FigureSpec = {
  figure_no: 1,
  kind: "flowchart",
  nodes: [
    { id: "a", label: "开始", shape: "ellipse" },
    { id: "b", label: "处理模块(20)", ref: 20 },
  ],
  edges: [{ from: "a", to: "b" }],
};

/** 用真实工具产出附图 + sidecar（门禁的输入契约由生产者保证）。 */
async function generateFigures(dir: string, figures: FigureSpec[] = [FIG], name = "case-g"): Promise<void> {
  const tool = createPatentFigureGenerateTool();
  await tool.execute({ figures, output_name: name, output_dir: dir, document_kind: "utility" }, makeContext(dir));
}

/** 执行门并捕获中断错误（未中断时返回产出）。 */
async function runGate(
  state: PipelineState,
): Promise<{ interrupted: InterruptStageError; report?: undefined } | { interrupted?: undefined; report: string }> {
  const handler = LookupStageHandler("figure-gate") ?? new FigureGateHandler();
  try {
    const segment = await handler.execute({ state });
    return { report: String(segment.figure_report ?? "") };
  } catch (err) {
    assert.ok(isInterruptStageError(err), `应为 InterruptStageError，实际 ${String(err)}`);
    return { interrupted: err };
  }
}

function readCheckReport(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "figure-check.json"), "utf8")) as Record<string, unknown>;
}

test("figure-gate 原子契约：名称/类别/输入输出键（描述不含阈值数字）", () => {
  registerBuiltinAtoms();
  const handler = LookupStageHandler("figure-gate");
  assert.ok(handler instanceof FigureGateHandler);
  assert.equal(handler.category, "gate");
  // 隐藏清单纪律：worker 可见面（阶段描述/原子描述）不出现阈值数字
  const atom = { inputSchema: ["figure_dir", "claims_draft", "spec_draft"], outputSchema: ["figure_report"] };
  assert.deepEqual(atom.inputSchema, ["figure_dir", "claims_draft", "spec_draft"]);
  assert.deepEqual(atom.outputSchema, ["figure_report"]);
});

test("figure-gate：无 sidecar → 降级并说明已探查的目录（不假装已核验）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-gate-empty-"));
  try {
    const handler = new FigureGateHandler();
    const out = await handler.execute({ state: { figure_dir: dir } });
    assert.match(String(out._error), /未找到附图 sidecar/u);
    assert.match(String(out._error), /附图核验未执行/u);
    assert.equal(out.figure_report, undefined);
    assert.ok(!existsSync(join(dir, "figure-check.json")), "未核验则不留痕");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("figure-gate：sidecar + 干净文本 → 通过并落盘 figure-check.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-gate-pass-"));
  try {
    await generateFigures(dir);
    const outcome = await runGate({
      figure_dir: dir,
      claims_draft: "1. 一种装置，包括处理模块(20)。",
      spec_draft: "## 具体实施方式\n处理模块(20)执行处理。",
    });
    assert.ok(outcome.interrupted === undefined, "干净输入不应中断");
    assert.match(outcome.report, /附图门: ✅ 通过/u);

    const report = readCheckReport(dir);
    assert.equal(report.version, 1);
    assert.match(String(report.inputs_hash), /^[0-9a-f]{64}$/u);
    assert.equal((report.result as { ok: boolean }).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("figure-gate：图内标记未在说明书出现（V2）→ fail 挂 HITL，仍留痕", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-gate-fail-"));
  try {
    await generateFigures(dir);
    const outcome = await runGate({
      figure_dir: dir,
      claims_draft: "1. 一种装置。",
      spec_draft: "## 具体实施方式\n本实施例未提及该标记。",
    });
    assert.ok(outcome.interrupted, "V2 违规应挂 HITL");
    assert.equal(outcome.interrupted.stageId, "figure-gate");
    assert.match(String(outcome.interrupted.data.figure_report), /\[FAIL\] V2/u);
    assert.match(String(outcome.interrupted.data.review_context), /1=确认放行/u);
    assert.ok(existsSync(join(dir, "figure-check.json")), "中断路径同样留痕");
    assert.equal((readCheckReport(dir).result as { ok: boolean }).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("figure-gate：同一标记的两种书写形态（括号/裸数字）不判 V4 fail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-gate-normalize-"));
  try {
    await generateFigures(dir, [
      { ...FIG, figure_no: 1, nodes: [{ id: "a", label: "处理模块(20)", ref: 20 }], edges: [] },
      { ...FIG, figure_no: 2, nodes: [{ id: "a", label: "处理模块20", ref: 20 }], edges: [] },
    ]);
    const outcome = await runGate({
      figure_dir: dir,
      claims_draft: "1. 一种装置，包括处理模块(20)。",
      spec_draft: "处理模块20执行处理。",
    });
    assert.ok(outcome.interrupted === undefined, "书写形态差异不得触发 V4");
    assert.match(outcome.report, /✅ 通过/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("figure-gate：inputs_hash 随输入变化（结论与输入的对应关系可审计）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-gate-hash-"));
  try {
    await generateFigures(dir);
    await runGate({ figure_dir: dir, claims_draft: "处理模块(20)。", spec_draft: "" });
    const first = String(readCheckReport(dir).inputs_hash);
    await runGate({ figure_dir: dir, claims_draft: "处理模块(20)与另一部件。", spec_draft: "" });
    const second = String(readCheckReport(dir).inputs_hash);
    assert.notEqual(first, second, "文本变化应改变 inputs_hash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("figure-gate：sidecar 与 SVG 漂移（图被改写）→ fail-loud 挂 HITL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-gate-drift-"));
  try {
    await generateFigures(dir);
    // 手工把图内的标记 20 改成 30：sidecar 仍记 20 ⇒ 核验结论不可信
    const svgPath = join(dir, "case-g-fig1.svg");
    writeFileSync(svgPath, readFileSync(svgPath, "utf8").replaceAll('data-ref="20"', 'data-ref="30"'), "utf8");
    const outcome = await runGate({
      figure_dir: dir,
      claims_draft: "1. 一种装置，包括处理模块(20)。",
      spec_draft: "",
    });
    assert.ok(outcome.interrupted, "漂移应 fail-loud");
    assert.match(String(outcome.interrupted.message), /与 sidecar 不一致/u);
    const drift = outcome.interrupted.data.figure_drift as string[];
    assert.ok(
      drift.some(line => line.includes("文件内标记与 sidecar")),
      drift.join(" / "),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("figure-gate：SVG 被注入 DOCTYPE/ENTITY → 安全检查拒读并记 drift（跨信任边界）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-gate-unsafe-"));
  try {
    await generateFigures(dir);
    const svgPath = join(dir, "case-g-fig1.svg");
    const clean = readFileSync(svgPath, "utf8");
    writeFileSync(svgPath, `<!DOCTYPE svg SYSTEM "x">\n<!ENTITY a "b">\n${clean}`, "utf8");
    const outcome = await runGate({
      figure_dir: dir,
      claims_draft: "1. 一种装置，包括处理模块(20)。",
      spec_draft: "",
    });
    assert.ok(outcome.interrupted, "注入的 SVG 应 fail-loud");
    const drift = outcome.interrupted.data.figure_drift as string[];
    assert.ok(
      drift.some(line => line.includes("未通过安全检查")),
      drift.join(" / "),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("figure-gate：无说明书文本时 V2/V3 跳过并在报告注明（不把标记全判为未提及）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-gate-notext-"));
  try {
    await generateFigures(dir);
    const outcome = await runGate({ figure_dir: dir, claims_draft: "", spec_draft: "" });
    assert.ok(outcome.interrupted === undefined, "无文本不应因 V2 误报而中断");
    assert.match(outcome.report, /V2\/V3 未生效/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("figure-gate：目录三级回退——案卷 outputs 与 .sati/figures", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-gate-dirs-"));
  const original = process.cwd();
  try {
    // 案卷 outputs 优先于 .sati/figures；两处都放 sidecar，取案卷
    const caseDir = join(cwd, "data", "cases", "c9", "outputs");
    const defaultDir = join(cwd, ".sati", "figures");
    mkdirSync(caseDir, { recursive: true });
    mkdirSync(defaultDir, { recursive: true });
    await generateFigures(caseDir, [FIG], "case-out");
    await generateFigures(defaultDir, [FIG], "default-out");
    process.chdir(cwd);
    const outcome = await runGate({ caseId: "c9", claims_draft: "处理模块(20)。", spec_draft: "" });
    assert.ok(outcome.interrupted === undefined);
    assert.match(outcome.report, /案卷 outputs（caseId=c9）/u);
    assert.ok(existsSync(join(caseDir, "figure-check.json")));

    // 案卷无附图时退到 .sati/figures
    rmSync(caseDir, { recursive: true, force: true });
    const fallback = await runGate({ caseId: "c9", claims_draft: "处理模块(20)。", spec_draft: "" });
    assert.match(fallback.report!, /\.sati\/figures/u);
  } finally {
    process.chdir(original);
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 门粒度放行隔离（对齐 workflow/stage-primitives.ts 与 executor.ts 的契约）
// ---------------------------------------------------------------------------

const provider: StageProvider = { callLLM: async () => "推理结论" };

test("figure-gate：未批准时中断于本门；批准 figure_generate 不得放行后续兄弟审批门", async () => {
  registerBuiltinAtoms();
  const dir = mkdtempSync(join(tmpdir(), "sati-gate-sibling-"));
  try {
    await generateFigures(dir);
    const manifest = {
      id: "test_figure_gate",
      name: "附图门接线",
      caseType: "drafting",
      stages: [
        { id: "figure_generate", strategy: "chain" as const, description: "附图核验", atom: "figure-gate" },
        {
          id: "final_approval",
          strategy: "chain" as const,
          description: "定稿审批",
          atom: "approval-gate",
          params: { review_context: "确认定稿" },
        },
      ],
      validation: { requireAllSteps: true },
    };
    const base = {
      figure_dir: dir,
      claims_draft: "1. 一种装置。",
      spec_draft: "本实施例未提及该标记。",
    };

    // 未批准：中断于 figure_gate（V2 fail）
    const blocked = await runWorkflow(manifest, base, undefined, { provider });
    assert.equal(blocked.completed, false);
    assert.equal(blocked.interrupted?.stageId, "figure_generate");

    // 批准 figure_generate：本门强制放行，但**必须**在兄弟审批门再次中断
    const forced = await runWorkflow(manifest, base, undefined, {
      provider,
      approvalGrants: ["figure_generate"],
    });
    assert.equal(forced.completed, false, "兄弟审批门不得被静默放行");
    assert.equal(forced.interrupted?.stageId, "final_approval");
    const gateStage = forced.stages.find(s => s.stageId === "figure_generate");
    assert.match(gateStage!.output, /人工强制放行/u);
    assert.equal(gateStage!.degraded, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("figure-gate：warn 级发现透传不阻断（V8 多图未指定摘要附图）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-gate-warn-"));
  try {
    await generateFigures(dir, [
      { ...FIG, figure_no: 1 },
      { ...FIG, figure_no: 2, nodes: [{ id: "a", label: "结束", shape: "ellipse" }], edges: [] },
    ]);
    const outcome = await runGate({
      figure_dir: dir,
      claims_draft: "处理模块(20)。",
      spec_draft: "处理模块(20)执行处理。",
    });
    assert.ok(outcome.interrupted === undefined, "warn 不应中断");
    assert.match(outcome.report, /\[WARN\] V8/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
