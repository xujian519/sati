/**
 * patent_figure_annotate — 向已交付 SVG 补写附图标记（可见标号）的工具化测试。
 *
 * 测的是**契约**而非实现细节：
 * 1. 正常标注：落盘文件里出现可见标号「名称(20)」，且原有 data-ref 属性原样保留；
 * 2. dry_run：只算不写（不落盘），但照样给出"会写什么"；
 * 3. 未命中：图面上找不到的文字进 `unmatched`，**不得**被说成"已标注"（ok=false）；
 * 4. 不存在的路径：报错可操作（含路径与解析口径）；
 * 5. 输出路径缺省：`<stem>-annotated.svg` 落在输入文件同目录；
 * 6. 输出契约：canonical data 必须过工具自己声明的 outputSchema。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createPatentFigureAnnotateTool } from "../../../src/tool/builtin/patentFigureAnnotate.js";
import { validateCanonicalOutput } from "../../../src/tool/execution/outputSchemaValidation.js";
import { SatiToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

/** 一幅"已交付"的 SVG：带 data-ref（机器可读），图面上**没有**可见标号。 */
const DELIVERED_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">',
  '<g id="n-a" data-ref="20"><text x="10" y="20" font-size="12">处理模块</text></g>',
  '<g id="n-b" data-ref="30"><text x="10" y="40" font-size="12">存储介质</text></g>',
  "</svg>",
].join("");

/** 工具运行上下文（工作目录 = 临时目录）。 */
function makeContext(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "sess-annotate",
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

/** 建临时目录并写入一份 SVG，返回工作目录与文件路径。 */
function withSvg(svg: string, fileName = "fig1.svg"): { cwd: string; svgPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), "sati-fig-annotate-"));
  const svgPath = join(cwd, fileName);
  mkdirSync(dirname(svgPath), { recursive: true });
  writeFileSync(svgPath, svg, "utf8");
  return { cwd, svgPath };
}

/** 取 canonical data 里的字段（类型断言集中在这一处）。 */
type AnnotateData = {
  annotated_path: string;
  written: { ref: number; label: string }[];
  already_present: { ref: number; label: string }[];
  unmatched: { ref: number; label: string }[];
  validation: { known: number[]; unknown: number[] };
  ok: boolean;
  dry_run: boolean;
  source_path: string;
};

function dataOf(result: { data?: unknown }): AnnotateData {
  assert.ok(result.data !== undefined, "工具必须返回 canonical data");
  return result.data as AnnotateData;
}

test("正常标注：写入后文件里出现可见标号，data-ref 原样保留", async () => {
  const { cwd, svgPath } = withSvg(DELIVERED_SVG);
  try {
    const tool = createPatentFigureAnnotateTool();
    const result = await tool.execute(
      {
        svg_path: svgPath,
        references: [
          { ref: 20, label: "处理模块" },
          { ref: 30, label: "存储介质" },
        ],
      },
      makeContext(cwd),
    );

    const data = dataOf(result);
    // 输出契约自洽：字段漂移即红。
    assert.deepEqual(validateCanonicalOutput(result.data, tool.outputSchema!), []);

    assert.equal(data.ok, true);
    assert.deepEqual(data.written, [
      { ref: 20, label: "处理模块" },
      { ref: 30, label: "存储介质" },
    ]);
    assert.deepEqual(data.already_present, []);
    assert.deepEqual(data.unmatched, []);
    assert.deepEqual(data.validation.known, [20, 30]);
    assert.deepEqual(data.validation.unknown, []);

    // 缺省输出路径 = 输入同目录的 <stem>-annotated.svg。
    const expectedPath = join(cwd, "fig1-annotated.svg");
    assert.equal(data.annotated_path, expectedPath);
    assert.ok(existsSync(expectedPath), "标注后的 SVG 必须落盘");

    const written = readFileSync(expectedPath, "utf8");
    // 可见标号写进了图面（本仓惯例：名称(20)，无空格）。
    assert.match(written, />处理模块\(20\)</u);
    assert.match(written, />存储介质\(30\)</u);
    // 原有 data-ref 属性不得被牵动。
    assert.match(written, /data-ref="20"/u);
    assert.match(written, /data-ref="30"/u);
    // 报告文本里也要能看到"已写入"。
    const text = result.content.map(item => (item.type === "text" ? item.text : "")).join("\n");
    assert.match(text, /已写入（可见标号）：2 条/u);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("dry_run：只校验与计算，不落盘", async () => {
  const { cwd, svgPath } = withSvg(DELIVERED_SVG);
  try {
    const tool = createPatentFigureAnnotateTool();
    const result = await tool.execute(
      { svg_path: svgPath, references: [{ ref: 20, label: "处理模块" }], dry_run: true },
      makeContext(cwd),
    );

    const data = dataOf(result);
    assert.deepEqual(validateCanonicalOutput(result.data, tool.outputSchema!), []);
    assert.equal(data.dry_run, true);
    assert.equal(data.annotated_path, "", "dry_run 不落盘 ⇒ 路径为空串");
    assert.equal(existsSync(join(cwd, "fig1-annotated.svg")), false, "dry_run 不得产生文件");
    // 仍然如实报告"会写什么"。
    assert.deepEqual(data.written, [{ ref: 20, label: "处理模块" }]);
    assert.equal(data.ok, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("未命中：未知 ref 出现在 unmatched，不得被说成已标注", async () => {
  const { cwd, svgPath } = withSvg(DELIVERED_SVG);
  try {
    const tool = createPatentFigureAnnotateTool();
    const result = await tool.execute(
      {
        svg_path: svgPath,
        references: [
          { ref: 20, label: "处理模块" },
          { ref: 40, label: "不存在的部件" },
        ],
      },
      makeContext(cwd),
    );

    const data = dataOf(result);
    assert.deepEqual(validateCanonicalOutput(result.data, tool.outputSchema!), []);
    assert.deepEqual(data.unmatched, [{ ref: 40, label: "不存在的部件" }]);
    assert.deepEqual(data.written, [{ ref: 20, label: "处理模块" }]);
    assert.equal(data.ok, false, "未命中即没标上 ⇒ 不判成功");

    const written = readFileSync(join(cwd, "fig1-annotated.svg"), "utf8");
    assert.doesNotMatch(written, /\(40\)/u, "未命中的标记不得写进文件");

    const text = result.content.map(item => (item.type === "text" ? item.text : "")).join("\n");
    assert.match(text, /未命中（未写入）：1 条/u);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("不存在的路径：报可操作的错（含路径与解析口径）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "sati-fig-annotate-"));
  try {
    const tool = createPatentFigureAnnotateTool();
    await assert.rejects(
      () =>
        tool.execute({ svg_path: "missing/fig.svg", references: [{ ref: 20, label: "处理模块" }] }, makeContext(cwd)),
      (error: unknown) => {
        assert.ok(error instanceof SatiToolRuntimeError, `应为 SatiToolRuntimeError，实际 ${String(error)}`);
        assert.equal(error.code, "file_not_found");
        assert.match(error.message, /missing\/fig\.svg/u);
        assert.match(error.message, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
        return true;
      },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("显式 output_path：按调用方给的路径落盘，目录不存在时自动创建", async () => {
  const { cwd, svgPath } = withSvg(DELIVERED_SVG);
  try {
    const tool = createPatentFigureAnnotateTool();
    const outputPath = join(cwd, "out", "nested", "annotated.svg");
    const result = await tool.execute(
      {
        svg_path: svgPath,
        references: [{ ref: 20, label: "处理模块" }],
        output_path: outputPath,
      },
      makeContext(cwd),
    );

    const data = dataOf(result);
    assert.equal(data.annotated_path, outputPath);
    assert.ok(existsSync(outputPath), "显式输出路径必须落盘");
    assert.equal(existsSync(join(cwd, "fig1-annotated.svg")), false, "未给默认路径时不得另写一份");
    assert.match(readFileSync(outputPath, "utf8"), />处理模块\(20\)</u);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("相对路径：按工作目录解析", async () => {
  const { cwd, svgPath } = withSvg(DELIVERED_SVG, "sub/fig2.svg");
  try {
    const tool = createPatentFigureAnnotateTool();
    const result = await tool.execute(
      { svg_path: "sub/fig2.svg", references: [{ ref: 30, label: "存储介质" }] },
      makeContext(cwd),
    );
    const data = dataOf(result);
    assert.equal(data.source_path, svgPath);
    assert.deepEqual(data.written, [{ ref: 30, label: "存储介质" }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("图面已带标记：算「图面已有」，不重复写入，也不冒充本次写入", async () => {
  const { cwd, svgPath } = withSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><text x="10" y="20">处理模块(20)</text></svg>',
  );
  try {
    const tool = createPatentFigureAnnotateTool();
    const result = await tool.execute(
      { svg_path: svgPath, references: [{ ref: 20, label: "处理模块" }] },
      makeContext(cwd),
    );
    const data = dataOf(result);
    assert.deepEqual(validateCanonicalOutput(result.data, tool.outputSchema!), []);
    assert.deepEqual(data.written, [], "图面已有的标记不算本次写入");
    assert.deepEqual(data.already_present, [{ ref: 20, label: "处理模块" }]);
    assert.deepEqual(data.unmatched, []);
    assert.equal(data.ok, true);
    assert.doesNotMatch(readFileSync(join(cwd, "fig1-annotated.svg"), "utf8"), /\(20\)\(20\)/u);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("label 缺省：定位文字用 (ref) 形态", async () => {
  const { cwd, svgPath } = withSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><text x="10" y="20">处理模块(20)</text></svg>',
  );
  try {
    const tool = createPatentFigureAnnotateTool();
    const result = await tool.execute({ svg_path: svgPath, references: [{ ref: 20 }] }, makeContext(cwd));
    const data = dataOf(result);
    assert.deepEqual(data.already_present, [{ ref: 20, label: "(20)" }]);
    assert.deepEqual(data.unmatched, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("非法入参：ref 不是 1..999 的整数时当场拒（可操作）", async () => {
  const { cwd, svgPath } = withSvg(DELIVERED_SVG);
  try {
    const tool = createPatentFigureAnnotateTool();
    await assert.rejects(
      () => tool.execute({ svg_path: svgPath, references: [{ ref: 0 }] }, makeContext(cwd)),
      (error: unknown) => {
        assert.ok(error instanceof SatiToolRuntimeError, `应为 SatiToolRuntimeError，实际 ${String(error)}`);
        assert.equal(error.code, "invalid_tool_input");
        assert.match(error.message, /references\[0\]\.ref/u);
        return true;
      },
    );
    await assert.rejects(
      () => tool.execute({ svg_path: svgPath, references: [] }, makeContext(cwd)),
      (error: unknown) => {
        assert.ok(error instanceof SatiToolRuntimeError, `应为 SatiToolRuntimeError，实际 ${String(error)}`);
        assert.equal(error.code, "invalid_tool_input");
        assert.match(error.message, /references/u);
        return true;
      },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("安全门：含 DOCTYPE 的 SVG 被拒（不进标注链）", async () => {
  const { cwd, svgPath } = withSvg('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"><text>处理模块</text></svg>');
  try {
    const tool = createPatentFigureAnnotateTool();
    await assert.rejects(
      () => tool.execute({ svg_path: svgPath, references: [{ ref: 20, label: "处理模块" }] }, makeContext(cwd)),
      (error: unknown) => {
        assert.ok(error instanceof SatiToolRuntimeError, `应为 SatiToolRuntimeError，实际 ${String(error)}`);
        assert.equal(error.code, "invalid_tool_input");
        assert.match(error.message, /安全门/u);
        return true;
      },
    );
    assert.equal(existsSync(join(cwd, "fig1-annotated.svg")), false, "被拒的输入不得留下产物");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
