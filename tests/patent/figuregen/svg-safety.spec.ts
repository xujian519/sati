/**
 * src/patent/figuregen — 跨信任边界 SVG 读取安全门测试（W0-1）。
 *
 * 契约：外部 SVG 进入解析器前必须先过 `assertSafeSvg`（大小上限 + 拒 DOCTYPE/ENTITY/CDATA
 * + 需 `<svg` 根）；**防误伤**同样是被测断言的一部分——安全门不得把本模块两类渲染器的
 * 正常产物拒之门外（否则整条交付链会被自家门禁掐死）。
 *
 * 接线点两处：`patent_figure_check` 的 `svg_paths`（工具层，本文件）与 `figure-gate` 的
 * 漂移检测（原子层，见 figure-gate.spec.ts）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_SVG_MAX_BYTES,
  SvgSafetyError,
  assertSafeSvg,
  isSvgSafetyError,
} from "../../../src/patent/figuregen/svg-safety.js";
import { renderFigureSvg } from "../../../src/patent/figuregen/render-svg.js";
import { renderFigureSvgWithGraphviz, resolveDotBinary } from "../../../src/patent/figuregen/render-graphviz.js";
import type { FigureSpec } from "../../../src/patent/figuregen/types.js";
import { createPatentFigureCheckTool } from "../../../src/tool/builtin/patentFigureCheck.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const SPEC: FigureSpec = {
  figure_no: 1,
  kind: "flowchart",
  nodes: [
    { id: "start", label: "开始", shape: "ellipse" },
    { id: "step", label: "处理模块(20)", ref: 20 },
  ],
  edges: [{ from: "start", to: "step" }],
};

function makeContext(cwd: string): SatiToolRuntimeContext {
  return {
    sessionId: "sess-safety",
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

/** 断言被拒并返回错误码（同时验证 isSvgSafetyError 的类型守卫）。 */
function rejectedCode(text: string, maxBytes?: number): string {
  try {
    assertSafeSvg(text, maxBytes);
  } catch (err) {
    assert.ok(isSvgSafetyError(err), `应为 SvgSafetyError，实际 ${String(err)}`);
    assert.ok(err instanceof SvgSafetyError);
    return err.code;
  }
  throw new Error("应被安全门拒绝，实际通过");
}

test("安全门：拒绝 DOCTYPE / ENTITY / CDATA（大小写不敏感）", () => {
  const svg = renderFigureSvg(SPEC).svg;
  assert.equal(rejectedCode(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN">\n${svg}`), "unsafe_svg");
  assert.equal(rejectedCode(`<!doctype svg>\n${svg}`), "unsafe_svg");
  assert.equal(rejectedCode(`${svg}\n<!ENTITY xxe SYSTEM "file:///etc/passwd">`), "unsafe_svg");
  assert.equal(rejectedCode(`${svg}<![CDATA[<script/>]]>`), "unsafe_svg");
});

test("安全门：大小上限（默认 2MB，可按调用方覆盖）", () => {
  assert.equal(DEFAULT_SVG_MAX_BYTES, 2_000_000);
  const oversized = `<svg>${"x".repeat(64_000)}</svg>`;
  assert.equal(rejectedCode(oversized, 1_024), "too_large");
  // 未超限时不得误判
  assertSafeSvg(oversized);
});

test("安全门：空内容与缺 <svg 根均拒绝", () => {
  assert.equal(rejectedCode(""), "missing_svg_root");
  assert.equal(rejectedCode("<html><body>not a drawing</body></html>"), "missing_svg_root");
});

test("防误伤：内置渲染器产物必过安全门", () => {
  const { svg } = renderFigureSvg(SPEC);
  assertSafeSvg(svg);
});

test("防误伤：Graphviz 渲染器产物必过安全门", {
  skip: resolveDotBinary() === null ? "graphviz not installed" : false,
}, async () => {
  const { svg } = await renderFigureSvgWithGraphviz(SPEC);
  assertSafeSvg(svg);
});

test("patent_figure_check：svg_paths 注入 DOCTYPE / 超限文件被拒（invalid_tool_input）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-svg-safety-"));
  try {
    const tool = createPatentFigureCheckTool();
    const clean = renderFigureSvg(SPEC).svg;
    const injected = join(dir, "injected-fig1.svg");
    writeFileSync(injected, `<!DOCTYPE svg SYSTEM "x"><!ENTITY a "b">\n${clean}`, "utf8");

    await assert.rejects(
      tool.execute({ svg_paths: ["injected-fig1.svg"], spec_text: "处理模块(20)" }, makeContext(dir)),
      /未通过安全检查/u,
    );
    // 同一份 SVG 去掉注入后照常通过（证明确实是安全门拒绝，而不是路径/解析问题）
    const ok = join(dir, "clean-fig1.svg");
    writeFileSync(ok, clean, "utf8");
    const result = await tool.execute({ svg_paths: ["clean-fig1.svg"], spec_text: "处理模块(20)" }, makeContext(dir));
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.match(text, /核验通过/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
