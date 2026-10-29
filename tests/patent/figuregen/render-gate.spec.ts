/**
 * tests/patent/figuregen/render-gate — 生成期渲染复核门禁、结构元素上限与跨调用一致性。
 *
 * 三件事都在 `patent_figure_generate` 的 execute 里落地，且都有"降级但不静默"的约束
 * （AGENTS 第 11 条）：
 * 1. `SATI_FIGURE_RENDER_GATE` 的 off/warn/fail 三档必须**可区分**——off 不得呈现成
 *    "已核验通过"，fail 必须在产物与 sidecar 落盘后才抛错（产物可审计）；
 * 2. 单幅结构元素上限（`nodes + edges ≤ 200`）在入参处 fail-closed；
 * 3. 跨调用以同目录既有 sidecar 为单一事实源核对图号/标号占用，且**同名重生成**
 *    不得把自己的旧 sidecar 判成占用。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPatentFigureGenerateTool } from "../../../src/tool/builtin/patentFigureGenerate.js";
import { assertFigurePayloads, STRUCTURAL_MAX_ITEMS } from "../../../src/tool/builtin/patentFigureSchema.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";

function makeContext(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "sess-test",
    turnId: "turn-1",
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

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "sati-figure-gate-"));
}

/** 工具返回的 `data.check`（execute 的 data 在定义层是 unknown，用例按产物形状收窄）。 */
type GenerateCheck = {
  ok: boolean;
  findings: { rule: string; severity: string; message: string }[];
};

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const first = content[0];
  return first !== undefined && first.type === "text" ? (first.text ?? "") : "";
}

function checkOf(result: unknown): GenerateCheck {
  const check = (result as { data?: { check?: GenerateCheck } }).data?.check;
  // 用显式 throw 而不是 assert 收窄：asserts 不传递到可选属性访问上（strict 模式下会报 any）。
  if (check === undefined) throw new Error("patent_figure_generate 应返回 data.check");
  return check;
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

/** 只有一幅且图号为 2：V1（编号应为 1..N 连续）必然 fail，用于验证 fail 档。 */
const V1_FAILING: FigureSpec = {
  figure_no: 2,
  kind: "flowchart",
  nodes: [
    { id: "a", label: "开始", shape: "ellipse" },
    { id: "b", label: "处理模块(20)", ref: 20 },
  ],
  edges: [{ from: "a", to: "b" }],
};

/** 设定 `SATI_FIGURE_RENDER_GATE` 并保证复原（含未设时的 delete）。 */
async function withGate(gate: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env.SATI_FIGURE_RENDER_GATE;
  if (gate === undefined) delete process.env.SATI_FIGURE_RENDER_GATE;
  else process.env.SATI_FIGURE_RENDER_GATE = gate;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.SATI_FIGURE_RENDER_GATE;
    else process.env.SATI_FIGURE_RENDER_GATE = previous;
  }
}

test("渲染复核门禁：缺省 warn 跑复核并报告量测结论，不阻断生成", async () => {
  const cwd = tempCwd();
  try {
    await withGate(undefined, async () => {
      const result = await createPatentFigureGenerateTool().execute(
        { figures: [FIG], output_name: "gate-warn" },
        makeContext(cwd),
      );
      const text = textOf(result);
      assert.match(text, /渲染复核：RC1–RC7 已量测，发现 \d+ 条（档位 warn，不阻断生成）/u);
      assert.ok(!text.includes("渲染复核未运行"), text);
      // warn 档不因渲染发现阻断：结构 ok 时整体 ok 仍为 true。
      assert.equal(checkOf(result).ok, true);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("渲染复核门禁：off 明确写「未运行/未量测」并以 RC0 info 计入发现", async () => {
  const cwd = tempCwd();
  try {
    await withGate("off", async () => {
      const result = await createPatentFigureGenerateTool().execute(
        { figures: [FIG], output_name: "gate-off" },
        makeContext(cwd),
      );
      const text = textOf(result);
      assert.match(text, /渲染复核：未运行（SATI_FIGURE_RENDER_GATE=off）/u);
      assert.match(text, /不能视为已核验无问题/u);
      const rc0 = checkOf(result).findings.filter(finding => finding.rule === "RC0");
      assert.equal(rc0.length, 1, "off 档必须留下一条「未量测」记录，而不是空报告");
      assert.match(rc0[0]?.message ?? "", /未量测/u);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("渲染复核门禁：fail 档在有 fail 级发现时，产物与 sidecar 落盘后抛错", async () => {
  const cwd = tempCwd();
  try {
    await withGate("fail", async () => {
      await assert.rejects(
        createPatentFigureGenerateTool().execute({ figures: [V1_FAILING], output_name: "gate-fail" }, makeContext(cwd)),
        /fail 级发现（V1）/u,
      );
      // 抛错前必须已落盘：产物可审计，调用方据 sidecar 修复后重生成。
      const svg = readFileSync(join(cwd, ".sati", "figures", "gate-fail-fig2.svg"), "utf8");
      assert.ok(svg.length > 0);
      const sidecar = JSON.parse(readFileSync(join(cwd, ".sati", "figures", "gate-fail-figures.json"), "utf8")) as {
        check: { findings: { rule: string; severity: string }[] };
      };
      assert.ok(
        sidecar.check.findings.some(finding => finding.rule === "V1" && finding.severity === "fail"),
        "sidecar 必须记录导致阻断的完整发现",
      );
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("渲染复核门禁：warn 档对同一 fail 级发现只报告、不抛错", async () => {
  const cwd = tempCwd();
  try {
    await withGate("warn", async () => {
      const result = await createPatentFigureGenerateTool().execute(
        { figures: [V1_FAILING], output_name: "gate-warn-v1" },
        makeContext(cwd),
      );
      const check = checkOf(result);
      assert.equal(check.ok, false);
      assert.ok(check.findings.some(finding => finding.rule === "V1" && finding.severity === "fail"));
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("渲染复核门禁：非法档位在落盘前 fail-closed", async () => {
  const cwd = tempCwd();
  try {
    await withGate("strict", async () => {
      await assert.rejects(
        createPatentFigureGenerateTool().execute({ figures: [FIG], output_name: "gate-bad" }, makeContext(cwd)),
        /非法 SATI_FIGURE_RENDER_GATE "strict"/u,
      );
      assert.equal(existsSync(join(cwd, ".sati", "figures", "gate-bad-figures.json")), false, "不得留下半成品");
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("结构元素上限：nodes + edges 恰好 200 通过、201 被拒（对齐 harness 的 STRUCTURAL_MAX_ITEMS）", () => {
  const build = (count: number): FigureSpec => ({
    figure_no: 1,
    kind: "block",
    nodes: Array.from({ length: count }, (_, index) => ({ id: `n${String(index)}`, label: `模块${String(index)}` })),
    edges: [],
  });
  assert.equal(STRUCTURAL_MAX_ITEMS, 200);
  assert.doesNotThrow(() => {
    assertFigurePayloads([build(STRUCTURAL_MAX_ITEMS)], "patent_figure_generate");
  });
  assert.throws(() => {
    assertFigurePayloads([build(STRUCTURAL_MAX_ITEMS + 1)], "patent_figure_generate");
  }, /超过单幅上限 200/u);
});

/** 前序调用留下的 sidecar（只写本模块解析所需的最小结构，见 parseFigureSidecar）。 */
function writePriorSidecar(cwd: string, spec: FigureSpec, outputName = "prior"): void {
  mkdirSync(join(cwd, ".sati", "figures"), { recursive: true });
  writeFileSync(
    join(cwd, ".sati", "figures", `${outputName}-figures.json`),
    JSON.stringify({
      version: 1,
      generated_at: "2026-10-29T00:00:00.000Z",
      output_name: outputName,
      renderer: "builtin",
      jurisdiction: "cn",
      check: { stage: "generation", skip_text_rules: true, ok: true, findings: [] },
      figures: [{ figure_no: spec.figure_no, file: `${outputName}-fig${String(spec.figure_no)}.svg`, spec }],
    }),
    "utf8",
  );
}

test("跨调用一致性：既有 sidecar 的图号与标号占用进入报告与发现", async () => {
  const cwd = tempCwd();
  try {
    writePriorSidecar(cwd, {
      figure_no: 1,
      kind: "flowchart",
      nodes: [{ id: "a", label: "壳体(10)" }],
      edges: [],
    });
    await withGate(undefined, async () => {
      const result = await createPatentFigureGenerateTool().execute(
        {
          figures: [{ figure_no: 1, kind: "flowchart", nodes: [{ id: "b", label: "底板(10)" }], edges: [] }],
          output_name: "second",
        },
        makeContext(cwd),
      );
      const text = textOf(result);
      assert.match(text, /已复核既有 sidecar 1 份（prior）/u);
      assert.match(text, /图号占用冲突：图1（前序 prior）/u);
      assert.match(text, /\[WARN\] 附图标记 10 的指向不一致/u);
      assert.match(text, /已占用的附图标记：10/u);
      assert.ok(
        checkOf(result).findings.some(
          finding => finding.rule === "V1" && /已被既有 sidecar 占用/u.test(finding.message),
        ),
      );
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("跨调用一致性：同名重生成不把自己的旧 sidecar 判成占用", async () => {
  const cwd = tempCwd();
  try {
    await withGate(undefined, async () => {
      const tool = createPatentFigureGenerateTool();
      await tool.execute({ figures: [FIG], output_name: "again" }, makeContext(cwd));
      const second = await tool.execute({ figures: [FIG], output_name: "again" }, makeContext(cwd));
      const text = textOf(second);
      assert.ok(!text.includes("图号占用冲突"), text);
      assert.ok(!checkOf(second).findings.some(finding => /已被既有 sidecar 占用/u.test(finding.message)), text);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("跨调用一致性：首次生成（目录无 sidecar）如实说明无标号可续", async () => {
  const cwd = tempCwd();
  try {
    await withGate(undefined, async () => {
      const result = await createPatentFigureGenerateTool().execute(
        { figures: [FIG], output_name: "first" },
        makeContext(cwd),
      );
      assert.match(textOf(result), /输出目录无既有 sidecar（首次生成，无标号可续）/u);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
