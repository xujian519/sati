/**
 * patent_figure_project 工具 + CAD 图的附图门接线测试。
 *
 * 不真跑 FreeCAD：注入 runner 返回录制的边表（`tests/fixtures/patent/cad/`）。
 * 覆盖：落盘（SVG + sidecar 带几何来源）、fail-closed（无 FreeCAD / 无可见边）、
 * 附图门对 CAD 图不误判画幅（V7 不适用），且 `figure-check.json` 记录 renderer 与投影参数。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { FigureGateHandler, registerBuiltinAtoms } from "../../../src/patent/index.js";
import { CAD_JSON_BEGIN, CAD_JSON_END, type CadRunner } from "../../../src/patent/figuregen/cad/index.js";
import { parseFigureSidecar } from "../../../src/patent/figuregen/sidecar.js";
import { parseFigureSvg } from "../../../src/patent/figuregen/readback.js";
import { MAX_CAD_ANNOTATIONS, createPatentFigureProjectTool } from "../../../src/tool/builtin/patentFigureProject.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const FIXTURE_PATH = resolve(process.cwd(), "tests/fixtures/patent/cad/plate-front.json");
const SECTION_FIXTURE_PATH = resolve(process.cwd(), "tests/fixtures/patent/cad/plate-section-top.json");

function fixtureTable(): string {
  return readFileSync(FIXTURE_PATH, "utf8");
}

function runnerWith(tableJson: string): CadRunner {
  return async () => ({
    stdout: `FreeCAD 1.1.3 banner\n${CAD_JSON_BEGIN}\n${tableJson}\n${CAD_JSON_END}\nstats`,
    stderr: "",
    code: 0,
  });
}

function context(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "sess-cad",
    turnId: "turn-cad",
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

const okRunner: CadRunner = async () => ({
  stdout: `FreeCAD 1.1.3 banner\n${CAD_JSON_BEGIN}\n${fixtureTable()}\n${CAD_JSON_END}\nstats`,
  stderr: "",
  code: 0,
});

test("patent_figure_project：落盘 SVG 与 sidecar（含几何来源与投影参数）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-cadtool-"));
  try {
    const tool = createPatentFigureProjectTool({ runner: okRunner, freecadCmd: "/fake/freecadcmd" });
    const result = await tool.execute(
      { step_path: "plate.step", output_name: "case-cad", view: "front", figure_no: 2, document_kind: "utility" },
      context(cwd),
    );
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.match(text, /已投影 front 视图/u);
    assert.match(text, /纸面尺寸 \d/u);
    assert.match(text, /不产几何；剖面线为 45°/u, "边界须如实声明");

    const svgPath = join(cwd, ".sati", "figures", "case-cad-fig2.svg");
    assert.ok(existsSync(svgPath));
    const svg = readFileSync(svgPath, "utf8");
    assert.match(svg, />图2</u);
    assert.equal(
      (svg.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? []).every(color => ["#000000", "#FFFFFF"].includes(color.toUpperCase())),
      true,
      "黑白不变式",
    );

    const sidecar = parseFigureSidecar(readFileSync(join(cwd, ".sati", "figures", "case-cad-figures.json"), "utf8"));
    assert.equal(sidecar.renderer, "cad");
    assert.equal(sidecar.document_kind, "utility");
    const geometry = sidecar.figures[0].geometry;
    assert.ok(geometry, "CAD 图须记录几何来源");
    assert.equal(geometry!.source, "cad");
    assert.equal(geometry!.view, "front");
    assert.equal(geometry!.hidden_lines, false);
    assert.ok(geometry!.width_mm > 0 && geometry!.height_mm > 0);
    assert.ok(geometry!.findings?.some(finding => finding.rule === "C1"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_project：无 FreeCAD 时 fail-closed（不静默回退其它渲染器）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-cadtool-none-"));
  const original = process.env.SATI_FREECAD_CMD;
  try {
    // 显式指定不存在的路径 → 探测即抛错（不是回退）
    process.env.SATI_FREECAD_CMD = join(cwd, "nope-freecadcmd");
    const tool = createPatentFigureProjectTool({ runner: okRunner });
    await assert.rejects(
      tool.execute({ step_path: "p.step", output_name: "c", view: "front" }, context(cwd)),
      /不存在|未找到 FreeCAD/u,
    );
  } finally {
    if (original === undefined) delete process.env.SATI_FREECAD_CMD;
    else process.env.SATI_FREECAD_CMD = original;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_project：非法 view fail-closed", async () => {
  const tool = createPatentFigureProjectTool({ runner: okRunner, freecadCmd: "/fake/freecadcmd" });
  await assert.rejects(
    tool.execute({ step_path: "p.step", output_name: "c", view: "sideways" }, context(process.cwd())),
    /非法 view/u,
  );
});

test("patent_figure_project：投影无可见边 → fail-closed（不出空图）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-cadtool-empty-"));
  try {
    const table = JSON.parse(fixtureTable()) as { edges: { kind: string }[] };
    const hiddenOnly = { ...table, edges: table.edges.filter(edge => edge.kind === "hidden") };
    const runner: CadRunner = async () => ({
      stdout: `${CAD_JSON_BEGIN}\n${JSON.stringify(hiddenOnly)}\n${CAD_JSON_END}`,
      stderr: "",
      code: 0,
    });
    const tool = createPatentFigureProjectTool({ runner, freecadCmd: "/fake/freecadcmd" });
    await assert.rejects(
      tool.execute({ step_path: "p.step", output_name: "c", view: "front" }, context(cwd)),
      /投影结果不可交付/u,
    );
    assert.ok(!existsSync(join(cwd, ".sati", "figures", "c-fig1.svg")), "失败不得落盘");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("附图门：CAD 图通过文字面核验并留痕 renderer/投影参数", async () => {
  registerBuiltinAtoms();
  const cwd = mkdtempSync(join(tmpdir(), "sati-cadtool-gate-"));
  try {
    const tool = createPatentFigureProjectTool({ runner: okRunner, freecadCmd: "/fake/freecadcmd" });
    await tool.execute({ step_path: "plate.step", output_name: "case-cad", view: "front" }, context(cwd));

    // 附图门只吃文字面规则（CAD 图无标记、画幅由投影几何决定）
    const handler = new FigureGateHandler();
    const out = await handler.execute({
      state: { figure_dir: join(cwd, ".sati", "figures"), claims_draft: "1. 一种平板。", spec_draft: "" },
    });
    assert.equal(out.figure_report !== undefined, true, `应产出报告：${String(out._error ?? "")}`);
    assert.match(String(out.figure_report), /附图门: ✅ 通过/u);

    const report = JSON.parse(readFileSync(join(cwd, ".sati", "figures", "figure-check.json"), "utf8")) as {
      renderer?: string;
      geometry?: { figure_no: number; view: string; findings?: unknown[] }[];
    };
    assert.equal(report.renderer, "cad", "figure-check.json 须记录渲染器来源");
    assert.equal(report.geometry?.[0]?.view, "front", "须记录投影参数");
    assert.ok(Array.isArray(report.geometry?.[0]?.findings), "须记录投影期几何检查结论");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_project：剖视图端到端（section_offset_mm ⇒ 剖面线 + sidecar 记录剖切参数）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-cadtool-section-"));
  try {
    const tool = createPatentFigureProjectTool({
      runner: runnerWith(readFileSync(SECTION_FIXTURE_PATH, "utf8")),
      freecadCmd: "/fake/freecadcmd",
    });
    const result = await tool.execute(
      { step_path: "plate.step", output_name: "case-sec", view: "top", section_offset_mm: 5 },
      context(cwd),
    );
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.match(text, /全剖视图：剖切面位于 5mm，剖切面 1 个、剖面线 \d+ 段/u);

    const svg = readFileSync(join(cwd, ".sati", "figures", "case-sec-fig1.svg"), "utf8");
    assert.match(svg, /<path d="M[^"]*" fill="none" stroke="#000000" stroke-width="0.2"\/>/u, "剖面线为 0.2mm 细实线");
    const sidecar = parseFigureSidecar(readFileSync(join(cwd, ".sati", "figures", "case-sec-figures.json"), "utf8"));
    const geometry = sidecar.figures[0].geometry!;
    assert.equal(geometry.section?.offset_mm, 5);
    assert.equal(geometry.section?.cut_faces, 1);
    assert.ok((geometry.section?.hatch_segments ?? 0) > 0, "剖面线须非空（段数由几何决定，不写死）");
    assert.equal(
      geometry.section!.hatch_segments,
      (svg.match(/M[\d.-]+ [\d.-]+L[\d.-]+ [\d.-]+/gu) ?? []).length,
      "sidecar 记录的剖面线段数须与落盘 SVG 一致",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_project：轴测图不可剖切（无剖切面语义）⇒ 入参 fail-loud", async () => {
  const tool = createPatentFigureProjectTool({ runner: okRunner, freecadCmd: "/fake/freecadcmd" });
  await assert.rejects(
    tool.execute({ step_path: "p.step", output_name: "c", view: "iso", section_offset_mm: 5 }, context(process.cwd())),
    /不能剖切/u,
  );
});

test("patent_figure_project：标注端到端（标号落进 sidecar 的 spec.nodes ⇒ 图文核验可用）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-cadtool-refs-"));
  try {
    const tool = createPatentFigureProjectTool({ runner: okRunner, freecadCmd: "/fake/freecadcmd" });
    const result = await tool.execute(
      {
        step_path: "plate.step",
        output_name: "case-refs",
        view: "front",
        annotations: [
          { ref: 10, at_mm: [40, 15, 10] },
          { ref: 20, at_mm: [20, 15, 0], label_offset_mm: [-10, -8] },
        ],
      },
      context(cwd),
    );
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.match(text, /附图标记 2 个（模型坐标锚点 \+ 引线）：10、20/u);

    const svg = readFileSync(join(cwd, ".sati", "figures", "case-refs-fig1.svg"), "utf8");
    assert.deepEqual(
      parseFigureSvg(svg).nodes.map(node => node.ref),
      [10, 20],
      "CAD 图的标记须符合回读契约",
    );
    const sidecar = parseFigureSidecar(readFileSync(join(cwd, ".sati", "figures", "case-refs-figures.json"), "utf8"));
    assert.deepEqual(sidecar.figures[0].spec.nodes, [
      { id: "ref-10", label: "10", ref: 10 },
      { id: "ref-20", label: "20", ref: 20 },
    ]);
    assert.deepEqual(sidecar.figures[0].geometry!.ref_numerals, [10, 20]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("patent_figure_project：标注入参校验（锚点三元/偏移上限/数量上限）", async () => {
  const tool = createPatentFigureProjectTool({ runner: okRunner, freecadCmd: "/fake/freecadcmd" });
  const base = { step_path: "p.step", output_name: "c", view: "front" } as const;
  await assert.rejects(
    tool.execute({ ...base, annotations: [{ ref: 10, at_mm: [1, 2] }] }, context(process.cwd())),
    /at_mm 应为三个有限数字/u,
  );
  await assert.rejects(
    tool.execute({ ...base, annotations: [{ ref: 0, at_mm: [1, 2, 3] }] }, context(process.cwd())),
    /ref 应为 1–999 的整数/u,
  );
  await assert.rejects(
    tool.execute(
      { ...base, annotations: [{ ref: 10, at_mm: [1, 2, 3], label_offset_mm: [999, 0] }] },
      context(process.cwd()),
    ),
    /绝对值不得超过 50mm/u,
  );
  await assert.rejects(
    tool.execute(
      {
        ...base,
        annotations: Array.from({ length: MAX_CAD_ANNOTATIONS + 1 }, (_, index) => ({
          ref: index + 1,
          at_mm: [1, 2, 3],
        })),
      },
      context(process.cwd()),
    ),
    /至多 24 项/u,
  );
});

test("patent_figure_project：标注与剖切共存（同一张图上剖面线 + 标号 + 图号）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-cadtool-both-"));
  try {
    const tool = createPatentFigureProjectTool({
      runner: runnerWith(readFileSync(SECTION_FIXTURE_PATH, "utf8")),
      freecadCmd: "/fake/freecadcmd",
    });
    await tool.execute(
      {
        step_path: "plate.step",
        output_name: "case-both",
        view: "top",
        section_offset_mm: 5,
        annotations: [{ ref: 10, at_mm: [20, 15, 5] }],
      },
      context(cwd),
    );
    const svg = readFileSync(join(cwd, ".sati", "figures", "case-both-fig1.svg"), "utf8");
    assert.match(svg, /stroke-width="0.2"/u, "剖面线");
    assert.match(svg, /data-ref="10"/u, "标号");
    assert.match(svg, />图1</u, "图号标注");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("附图门：CAD 图带标注时——标记与 sidecar 一致（无 drift），且图文核验真正生效", async () => {
  registerBuiltinAtoms();
  const cwd = mkdtempSync(join(tmpdir(), "sati-cadtool-gate-refs-"));
  try {
    const tool = createPatentFigureProjectTool({ runner: okRunner, freecadCmd: "/fake/freecadcmd" });
    await tool.execute(
      {
        step_path: "plate.step",
        output_name: "case-cad",
        view: "front",
        annotations: [
          { ref: 10, at_mm: [40, 15, 10] },
          { ref: 20, at_mm: [20, 15, 0] },
        ],
      },
      context(cwd),
    );
    const handler = new FigureGateHandler();
    const state = { figure_dir: join(cwd, ".sati", "figures") };

    // 说明书提到两个标记 ⇒ 通过（V2 不再空转）
    const pass = await handler.execute({
      state: { ...state, claims_draft: "1. 一种平板，包括主体（10）与底板（20）。", spec_draft: "" },
    });
    assert.match(String(pass.figure_report), /附图门: ✅ 通过/u, `应通过：${String(pass._error ?? "")}`);

    // 漏掉标记 20 ⇒ V2 fail 并挂 HITL（此前 CAD 图因无标记而空转通过）
    await assert.rejects(
      handler.execute({
        state: { ...state, claims_draft: "1. 一种平板，包括主体（10）。", spec_draft: "" },
      }),
      /附图未通过确定性核验/u,
    );
    const report = JSON.parse(readFileSync(join(cwd, ".sati", "figures", "figure-check.json"), "utf8")) as {
      result: { findings: { rule: string; severity: string }[] };
    };
    assert.ok(
      report.result.findings.some(finding => finding.rule === "V2" && finding.severity === "fail"),
      "须报 V2 fail",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
