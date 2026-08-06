/**
 * analyze_patent_figure 工具集成测试。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/index.js";
import { createAnalyzePatentFigureTool } from "../../../src/tool/builtin/analyzePatentFigure.js";
import { SatiToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { SatiToolModelClient, SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

const STEP1_JSON = JSON.stringify({
  figure_type: "flowchart",
  overall_description: "专利检索流程图",
  confidence: 0.85,
  notes: [],
});

const STEP2_JSON = JSON.stringify({
  components: [
    { ref_number: "1", name: "输入模块", kind: "interface", description: "接收检索请求" },
    { ref_number: "2", name: "检索模块", kind: "software", description: "执行检索" },
  ],
  connections: [{ source: "1", target: "2", kind: "data_flow", description: "请求传递" }],
  figure_description: "图1是本发明实施例提供的专利检索系统的流程图；图中：1-输入模块；2-检索模块；",
  warnings: [],
});

function fakeModel(): SatiToolModelClient {
  return {
    async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      const phase = request.metadata?.phase;
      yield { type: "text_delta", text: phase === "step1" ? STEP1_JSON : STEP2_JSON };
      yield { type: "usage", usage: { inputTokens: 8, outputTokens: 8 } };
    },
  };
}

function baseContext(model: SatiToolModelClient | undefined, cwd: string): SatiToolRuntimeContext {
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
    model,
  };
}

/** 生成一张真实 PNG 并写入临时目录，返回绝对路径。 */
async function makeTmpPng(): Promise<{ dir: string; filePath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "sati-figure-test-"));
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default;
  const buffer = await sharp({
    create: { width: 600, height: 400, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();
  const filePath = path.join(dir, "fig1.png");
  await writeFile(filePath, buffer);
  return { dir, filePath };
}

test("analyze_patent_figure: 工具元数据（只读/并发安全/域）", () => {
  const tool = createAnalyzePatentFigureTool();
  assert.equal(tool.name, "analyze_patent_figure");
  assert.equal(tool.domain, "patent");
  assert.equal(tool.isReadOnly({ image_path: "x.png" }), true);
  assert.equal(tool.isConcurrencySafe({ image_path: "x.png" }), true);
});

test("analyze_patent_figure: 无模型客户端时返回错误而非抛出", async () => {
  const tool = createAnalyzePatentFigureTool();
  const result = await tool.execute({ image_path: "x.png" }, baseContext(undefined, process.cwd()));
  const first = result.content[0];
  assert.equal(first?.type, "text");
  if (first?.type === "text") {
    assert.ok(first.text.includes("未注入模型客户端"), "应提示模型客户端缺失");
  }
});

test("analyze_patent_figure: 图片路径不存在时抛出工具错误", async () => {
  const tool = createAnalyzePatentFigureTool();
  await assert.rejects(
    () => tool.execute({ image_path: "/definitely/not/exists.png" }, baseContext(fakeModel(), process.cwd())),
    (err: unknown) => {
      assert.ok(err instanceof SatiToolRuntimeError, "应为 SatiToolRuntimeError");
      // bypassPermissions 模式下路径解析直接放行，由图片读取阶段捕获缺失文件。
      assert.equal(err.code, "invalid_tool_input");
      return true;
    },
  );
});

test("analyze_patent_figure: 非图片文件报格式错误", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sati-figure-test-"));
  try {
    const txtPath = path.join(dir, "not-image.txt");
    await writeFile(txtPath, "这不是图片");
    const tool = createAnalyzePatentFigureTool();
    await assert.rejects(
      () => tool.execute({ image_path: txtPath }, baseContext(fakeModel(), process.cwd())),
      (err: unknown) => {
        assert.ok(err instanceof SatiToolRuntimeError);
        assert.equal(err.code, "invalid_tool_input");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("analyze_patent_figure: 全流程——真实 PNG + fake 模型产出结构化结果", async () => {
  const { dir, filePath } = await makeTmpPng();
  try {
    const tool = createAnalyzePatentFigureTool();
    const result = await tool.execute(
      { image_path: filePath, figure_number: 1, claim_context: "一种专利检索系统" },
      baseContext(fakeModel(), process.cwd()),
    );

    const output = result.data as {
      figureType: string;
      components: Array<{ refNumber: string; name: string }>;
      figureDescription: string;
      usable: boolean;
    };
    assert.equal(output.figureType, "flowchart");
    assert.equal(output.components.length, 2);
    assert.equal(output.components[0]?.refNumber, "1");
    assert.ok(output.figureDescription.startsWith("图1是本发明实施例提供的"));
    assert.equal(output.usable, true);

    const first = result.content[0];
    assert.equal(first?.type, "json");
    assert.equal(result.metadata?.componentCount, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
