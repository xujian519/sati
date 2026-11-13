/**
 * 批次 B-1：**per-call 入参**的接线与语义（重录窗口落地的第一批 schema 变更）。
 *
 * 覆盖五组：
 * 1. 自动发号 per-call（`auto_numbering` / `numeral_start` / `numeral_step` / `reserved`）：
 *    入参优先于部署级 env；起点、步进、保留号都按声明生效。
 * 2. `figure_family` 同族跨图续号：同一次调用的多幅图**共享一个连续号段**
 *    （族内第一幅 100/102，第二幅接着 104/106），而不是每幅各占一个 100 号段。
 * 3. 落版参数 per-call（`submission.rotate_deg`）：入参优先于 env。
 * 4. RC8 接线：`patent_figure_check` 的 `hierarchy` 入参真的跑层级核对并出声。
 * 5. CAD 视图集 per-call（`views`）：入参优先于 env；非法视图名报 `invalid_tool_input`
 *    （不是 `setup_required`——入参写错与部署配置写错必须分开）。
 *
 * 语义纪律：**族声明了但自动发号没开**时，报告必须明说「族内号段本次未共享」，
 * 不能让调用方以为号段已经共享（仓库纪律：降级但不静默）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPatentFigureCheckTool } from "../../../src/tool/builtin/patentFigureCheck.js";
import { createPatentFigureGenerateTool } from "../../../src/tool/builtin/patentFigureGenerate.js";
import { createPatentFigureProjectTool } from "../../../src/tool/builtin/patentFigureProject.js";
import { resolveCadViewPlan } from "../../../src/patent/figuregen/cad/views.js";
import { parseFigureSidecar } from "../../../src/patent/figuregen/sidecar.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

function makeContext(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "sess-b1",
    turnId: "turn-b1",
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

/** 无附图标记的节点（自动发号的对象）。 */
function plainFigure(figureNo: number): FigureSpec {
  return {
    figure_no: figureNo,
    kind: "flowchart",
    nodes: [
      { id: "a", label: "输入" },
      { id: "b", label: "输出" },
    ],
    edges: [{ from: "a", to: "b" }],
  };
}

/** 读 sidecar 里某幅图的节点标记（归一后的 ref）。 */
function refsOf(sidecarText: string, figureNo: number): number[] {
  const sidecar = parseFigureSidecar(sidecarText);
  const figure = sidecar.figures.find(entry => entry.figure_no === figureNo);
  assert.ok(figure !== undefined, `sidecar 缺图${figureNo}`);
  return figure.spec.nodes.flatMap(node => (node.ref === undefined ? [] : [node.ref]));
}

function sidecarPath(cwd: string, name: string): string {
  return join(cwd, ".sati", "figures", `${name}-figures.json`);
}

test("B-1 自动发号 per-call：auto_numbering 开启 + numeral_start 生效", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-b1-"));
  try {
    const tool = createPatentFigureGenerateTool();
    await tool.execute(
      { figures: [plainFigure(1)], output_name: "b1start", auto_numbering: true, numeral_start: 200 },
      makeContext(cwd),
    );
    const refs = refsOf(readFileSync(sidecarPath(cwd, "b1start"), "utf8"), 1);
    assert.deepEqual(refs, [200, 202], "起点 200、默认步进 2 ⇒ 200/202");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("B-1 自动发号 per-call：numeral_step 与 reserved 生效", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-b1-"));
  try {
    const tool = createPatentFigureGenerateTool();
    await tool.execute(
      {
        figures: [plainFigure(1)],
        output_name: "b1step",
        auto_numbering: true,
        numeral_step: 1,
        reserved: ["101"],
      },
      makeContext(cwd),
    );
    const refs = refsOf(readFileSync(sidecarPath(cwd, "b1step"), "utf8"), 1);
    assert.deepEqual(refs, [100, 102], "步进 1 ⇒ 100/101，但 101 被保留 ⇒ 跳过取 102");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("B-1 同族续号：figure_family 让两幅图共享一个连续号段", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-b1-"));
  try {
    const tool = createPatentFigureGenerateTool();
    await tool.execute(
      {
        figures: [plainFigure(1), plainFigure(2)],
        output_name: "b1fam",
        auto_numbering: true,
        figure_family: "fig1",
      },
      makeContext(cwd),
    );
    const text = readFileSync(sidecarPath(cwd, "b1fam"), "utf8");
    assert.deepEqual(refsOf(text, 1), [100, 102], "族内第一幅：100/102");
    assert.deepEqual(refsOf(text, 2), [104, 106], "族内第二幅接着发号：104/106（不是另起 200 号段）");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("B-1 同族续号：自动发号未开启时如实声明「族内号段本次未共享」", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-b1-"));
  try {
    const tool = createPatentFigureGenerateTool();
    const result = await tool.execute(
      { figures: [plainFigure(1)], output_name: "b1famoff", figure_family: "fig1" },
      makeContext(cwd),
    );
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.match(text, /族内号段本次未共享/u, "族声明了但没发号 ⇒ 必须明说，不能当成已共享");
    assert.deepEqual(refsOf(readFileSync(sidecarPath(cwd, "b1famoff"), "utf8"), 1), [], "未发号 ⇒ 无标记");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("B-1 落版参数 per-call：submission.rotate_deg 生效", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-b1-"));
  try {
    const tool = createPatentFigureGenerateTool();
    await tool.execute(
      {
        figures: [plainFigure(1)],
        output_name: "b1rot",
        fit_to_page: true,
        submission: { rotate_deg: 90 },
      },
      makeContext(cwd),
    );
    const page = readFileSync(join(cwd, ".sati", "figures", "b1rot-fig1-page.svg"), "utf8");
    assert.match(page, /rotate\(90/u, "落版页应含 90° 旋转组");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("B-1 RC8 接线：hierarchy 入参跑层级核对并出声", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-b1-"));
  try {
    const tool = createPatentFigureCheckTool();
    const result = await tool.execute(
      {
        figures: [plainFigure(1)],
        spec_text: "权利要求 1 所述的装置，其中 30 的 311 为处理模块。",
        // 声明的层级里 311 的父是 31、30 是 312 的父 ⇒ 正文说「30 的 311」与声明不符。
        hierarchy: [
          { parent: 31, child: 311 },
          { parent: 30, child: 312 },
        ],
      },
      makeContext(cwd),
    );
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.match(text, /RC8/u, "声明层级与权利要求归属表述不一致 ⇒ 应报 RC8");
    const data = result.data as { findings?: { rule?: string }[] };
    assert.ok(
      (data.findings ?? []).some(finding => finding.rule === "RC8"),
      "RC8 发现应进结构化输出",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("B-1 视图集 per-call：入参优先于 env，非法视图名报 invalid_tool_input", () => {
  const plan = resolveCadViewPlan({ SATI_CAD_VIEWS: "top" }, "front", ["front", "right"]);
  assert.deepEqual([...plan.views], ["front", "right"], "入参优先于 env（env 的 top 被忽略）");
  assert.match(plan.source, /入参 views/u);
  assert.throws(() => resolveCadViewPlan({}, "front", ["sideways"]), /非法视图名/u, "非法视图名必须 fail-loud");
});

test("B-1 视图集 per-call：工具层把入参错误报成 invalid_tool_input（不是 setup_required）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-b1-"));
  try {
    const tool = createPatentFigureProjectTool({ runner: async () => ({ stdout: "", stderr: "", code: 0 }) });
    await assert.rejects(
      () =>
        tool.execute(
          { step_path: "a.step", output_name: "b1views", view: "front", views: ["sideways"] },
          makeContext(cwd),
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /非法 views 项/u);
        assert.match(String((err as { code?: string }).code ?? ""), /invalid_tool_input/u);
        return true;
      },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
