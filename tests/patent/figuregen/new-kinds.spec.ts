/**
 * 新图型（时序图 / 电路图）与多面板附图的**端到端接线**。
 *
 * 覆盖三条链：
 * 1. **生成链**：`patent_figure_generate` 出图 ⇒ 产物里能看到对应的图面元素
 *    （生命线、消息箭头、元件符号、面板格与共享标号）。
 * 2. **核验链**：新图型/多面板的附图标记在核验侧**照样被看到**（V2 图→文）——
 *    面板里的标记若在核验侧消失，就是「声明了却没核验」的假保证。
 * 3. **拒绝链**：graphviz 通路画不出生命线/元件符号/面板网格 ⇒ 整体 fail-loud，
 *    而不是画一张错图。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPatentFigureCheckTool } from "../../../src/tool/builtin/patentFigureCheck.js";
import { createPatentFigureGenerateTool } from "../../../src/tool/builtin/patentFigureGenerate.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

function makeContext(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "sess-newkinds",
    turnId: "turn-newkinds",
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

/** 时序图：两个参与者 + 两条消息（第二条为虚线返回消息）。 */
const SEQUENCE = {
  figure_no: 1,
  kind: "sequence" as const,
  nodes: [
    { id: "p1", label: "终端" },
    { id: "p2", label: "服务器" },
  ],
  edges: [
    { from: "p1", to: "p2", label: "请求" },
    { from: "p2", to: "p1", label: "响应", dashed: true },
  ],
};

/** 电路图：一个电阻 + 一个电源 + 一条连线。 */
const CIRCUIT = {
  figure_no: 1,
  kind: "circuit" as const,
  nodes: [
    { id: "src", label: "电源", shape: "source" as const },
    { id: "r1", label: "电阻", shape: "resistor" as const },
  ],
  edges: [{ from: "src", to: "r1" }],
};

test("新图型：时序图出图（生命线 + 消息箭头 + 消息文本）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-nk-"));
  try {
    const tool = createPatentFigureGenerateTool();
    const result = await tool.execute({ figures: [SEQUENCE], output_name: "seq" }, makeContext(cwd));
    assert.match(result.content[0].type === "text" ? result.content[0].text : "", /已生成 1 幅附图/u);
    const svg = readFileSync(join(cwd, ".sati", "figures", "seq-fig1.svg"), "utf8");
    assert.match(svg, /<svg/u);
    assert.match(svg, /终端/u, "参与者名应出现在图面");
    assert.match(svg, /请求/u, "消息文本应出现在图面");
    assert.match(svg, /stroke-dasharray/u, "生命线（虚线）应存在");
    assert.match(svg, /data-dsh-kind="sequence"/u, "根元素应声明图型（渲染复核据此豁免 RC4/RC6）");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("新图型：电路图出图（元件符号 + 连线）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-nk-"));
  try {
    const tool = createPatentFigureGenerateTool();
    await tool.execute({ figures: [CIRCUIT], output_name: "cir" }, makeContext(cwd));
    const svg = readFileSync(join(cwd, ".sati", "figures", "cir-fig1.svg"), "utf8");
    assert.match(svg, /data-dsh-kind="circuit"/u);
    assert.match(svg, /电源/u, "元件名应出现在图面");
    assert.match(svg, /<(rect|ellipse|line|polyline|path)\b/u, "应画出元件符号图元");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("多面板：两格共享同一套附图标记系列", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-nk-"));
  try {
    const tool = createPatentFigureGenerateTool();
    await tool.execute(
      {
        figures: [
          {
            figure_no: 1,
            kind: "flowchart",
            nodes: [],
            edges: [],
            panels: [
              {
                title: "图 1A",
                nodes: [{ id: "m", label: "电机", ref: 10 }],
                edges: [],
              },
              {
                title: "图 1B",
                nodes: [{ id: "m2", label: "电机", ref: 10 }],
                edges: [],
              },
            ],
          },
        ],
        output_name: "pan",
      },
      makeContext(cwd),
    );
    const svg = readFileSync(join(cwd, ".sati", "figures", "pan-fig1.svg"), "utf8");
    assert.match(svg, /data-dsh-kind="panels"/u);
    assert.match(svg, /图 1A/u, "面板标题应出现");
    assert.match(svg, /图 1B/u);
    const refCount = (svg.match(/data-ref="10"/gu) ?? []).length;
    assert.equal(refCount, 2, "同一标记在两个面板各出现一次（共享标号系列）");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("核验链：多面板里的标记在核验侧可见（V2 图→文 会看到它）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-nk-"));
  try {
    const tool = createPatentFigureCheckTool();
    const result = await tool.execute(
      {
        figures: [
          {
            figure_no: 1,
            kind: "flowchart",
            nodes: [],
            edges: [],
            panels: [
              { nodes: [{ id: "m", label: "电机", ref: 10 }], edges: [] },
              { nodes: [{ id: "g", label: "齿轮", ref: 20 }], edges: [] },
            ],
          },
        ],
        // 说明书只提了 10、没提 20 ⇒ 20 应被判「图上有、文中无」
        spec_text: "图 1 中电机(10)为动力源。",
      },
      makeContext(cwd),
    );
    const data = result.data as {
      findings?: { rule?: string; message?: string; evidence?: string[] }[];
      refs_in_figures?: number[];
    };
    assert.deepEqual(data.refs_in_figures, [10, 20], "面板里的标记必须进核验侧的标记集合");
    // V2 的 message 是总述、逐条证据在 evidence 里（核验器的既有口径）。
    assert.ok(
      (data.findings ?? []).some(
        finding => finding.rule === "V2" && (finding.evidence ?? []).some(line => /标记 20/u.test(line)),
      ),
      "面板里未在正文出现的标记应被判 V2（证据应点名标记 20）",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("拒绝链：graphviz 通路画不出时序图 ⇒ 整体 fail-loud", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-nk-"));
  const previous = process.env.SATI_FIGURE_RENDERER;
  try {
    process.env.SATI_FIGURE_RENDERER = "graphviz";
    const tool = createPatentFigureGenerateTool();
    await assert.rejects(
      () => tool.execute({ figures: [SEQUENCE], output_name: "seqdot" }, makeContext(cwd)),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /时序图/u);
        return true;
      },
    );
    assert.equal(existsSync(join(cwd, ".sati", "figures", "seqdot-fig1.svg")), false, "不应留下半成品产物");
  } finally {
    if (previous === undefined) delete process.env.SATI_FIGURE_RENDERER;
    else process.env.SATI_FIGURE_RENDERER = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});
