/**
 * 二维剖视（`kind: "cross-section"`）的**端到端接线**。
 *
 * 覆盖三条链：
 * 1. **生成链**：剖视图出图 ⇒ 断面轮廓 + 剖面线 + 零件名/附图标记都在图面上。
 * 2. **核验链**：断面零件的附图标记在核验侧**照样被看到**（V2 图→文）——剖视图里的
 *    标记若在核验侧消失，就是「声明了却没核验」的假保证。
 * 3. **拒绝链**：graphviz 通路画不出剖面 ⇒ 整体 fail-loud；非法轮廓（点数不足 /
 *    坐标越界）⇒ 入参处当场报错，不产出半成品。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPatentFigureCheckTool } from "../../../src/tool/builtin/patentFigureCheck.js";
import { createPatentFigureGenerateTool } from "../../../src/tool/builtin/patentFigureGenerate.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

function makeContext(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "sess-section",
    turnId: "turn-section",
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

/** 两个相邻断面零件（归一化坐标 0..1）+ 剖切线。 */
const SECTION: FigureSpec = {
  figure_no: 1,
  kind: "cross-section",
  nodes: [],
  edges: [],
  section: {
    parts: [
      {
        id: "housing",
        label: "壳体",
        ref: 10,
        outline: [
          [0.05, 0.2],
          [0.45, 0.2],
          [0.45, 0.8],
          [0.05, 0.8],
        ],
      },
      {
        id: "shaft",
        label: "轴",
        ref: 20,
        outline: [
          [0.55, 0.35],
          [0.95, 0.35],
          [0.95, 0.65],
          [0.55, 0.65],
        ],
      },
    ],
    cut: [
      [0.0, 0.5],
      [1.0, 0.5],
    ],
  },
};

test("剖视：出图（断面轮廓 + 剖面线 + 零件名与标记）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-sec-"));
  try {
    const tool = createPatentFigureGenerateTool();
    await tool.execute({ figures: [SECTION], output_name: "sec" }, makeContext(cwd));
    const svg = readFileSync(join(cwd, ".sati", "figures", "sec-fig1.svg"), "utf8");
    assert.match(svg, /<svg/u);
    assert.match(svg, /壳体/u, "零件名应出现在图面");
    assert.match(svg, /\(10\)/u, "附图标记应画在图面（只画一次）");
    assert.match(svg, /stroke-dasharray/u, "剖切位置线应为点划线");
    // 剖面线：同一图里有多个方向的细线段（相邻零件 45°/135° 交替）
    assert.match(svg, /stroke-width="1(?!\.5)/u, "剖面线应比主线条细（指南一部一章 4.3）");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("剖视：相邻零件的剖面线方向相反（GB/T 4457.5）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-sec-"));
  try {
    const tool = createPatentFigureGenerateTool();
    await tool.execute({ figures: [SECTION], output_name: "sec2" }, makeContext(cwd));
    const svg = readFileSync(join(cwd, ".sati", "figures", "sec2-fig1.svg"), "utf8");
    // 两个方向的剖面线都应存在：统计两种斜率方向的线段
    const segments = svg.match(/<line[^>]*>/gu) ?? [];
    const slopes = new Set(
      segments.map(seg => {
        const x1 = Number(/x1="([-\d.]+)"/u.exec(seg)?.[1] ?? "0");
        const y1 = Number(/y1="([-\d.]+)"/u.exec(seg)?.[1] ?? "0");
        const x2 = Number(/x2="([-\d.]+)"/u.exec(seg)?.[1] ?? "0");
        const y2 = Number(/y2="([-\d.]+)"/u.exec(seg)?.[1] ?? "0");
        const dx = x2 - x1;
        const dy = y2 - y1;
        if (dx === 0 || dy === 0) return "axis";
        return Math.sign(dx) === Math.sign(dy) ? "down" : "up";
      }),
    );
    assert.ok(slopes.has("down") && slopes.has("up"), `剖面线应有两个相反方向，实际: ${[...slopes].join(",")}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("核验链：断面零件的标记在核验侧可见（V2 图→文 会看到它）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-sec-"));
  try {
    const tool = createPatentFigureCheckTool();
    const result = await tool.execute(
      {
        figures: [SECTION],
        // 说明书只提了 10、没提 20 ⇒ 20 应被判「图上有、文中无」
        spec_text: "图 1 中壳体(10)为固定件。",
      },
      makeContext(cwd),
    );
    const data = result.data as {
      findings?: { rule?: string; evidence?: string[] }[];
      refs_in_figures?: number[];
    };
    assert.deepEqual(data.refs_in_figures, [10, 20], "断面零件的标记必须进核验侧的标记集合");
    assert.ok(
      (data.findings ?? []).some(
        finding => finding.rule === "V2" && (finding.evidence ?? []).some(line => /标记 20/u.test(line)),
      ),
      "断面里未在正文出现的标记应被判 V2",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("拒绝链：graphviz 通路画不出剖视 ⇒ 整体 fail-loud 且不留半成品", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-sec-"));
  const previous = process.env.SATI_FIGURE_RENDERER;
  try {
    process.env.SATI_FIGURE_RENDERER = "graphviz";
    const tool = createPatentFigureGenerateTool();
    await assert.rejects(
      () => tool.execute({ figures: [SECTION], output_name: "secdot" }, makeContext(cwd)),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /剖视图/u);
        return true;
      },
    );
    assert.equal(existsSync(join(cwd, ".sati", "figures", "secdot-fig1.svg")), false, "不应留下半成品产物");
  } finally {
    if (previous === undefined) delete process.env.SATI_FIGURE_RENDERER;
    else process.env.SATI_FIGURE_RENDERER = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("拒绝链：非法轮廓（点数不足 / 坐标越界）在入参处当场报错", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-sec-"));
  try {
    const tool = createPatentFigureGenerateTool();
    await assert.rejects(
      () =>
        tool.execute(
          {
            figures: [
              {
                figure_no: 1,
                kind: "cross-section",
                nodes: [],
                edges: [],
                section: {
                  parts: [
                    {
                      id: "p",
                      outline: [
                        [0, 0],
                        [1, 1],
                      ],
                    },
                  ],
                },
              },
            ],
            output_name: "secbad",
          },
          makeContext(cwd),
        ),
      /轮廓至少要 3 个顶点/u,
    );
    await assert.rejects(
      () =>
        tool.execute(
          {
            figures: [
              {
                figure_no: 1,
                kind: "cross-section",
                nodes: [],
                edges: [],
                section: {
                  parts: [
                    {
                      id: "p",
                      outline: [
                        [0, 0],
                        [1.5, 1],
                        [0.2, 0.3],
                      ],
                    },
                  ],
                },
              },
            ],
            output_name: "secbad2",
          },
          makeContext(cwd),
        ),
      /归一化域 0\.\.1/u,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
