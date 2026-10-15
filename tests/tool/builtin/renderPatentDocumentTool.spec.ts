import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRenderPatentDocumentTool } from "../../../src/tool/builtin/renderPatentDocument.js";
import { SatiToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import { makeToolContext } from "../context-fixture.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-render-tool-"));
}

test("createBuiltinRegistry 注册 render_patent_document（domain: patent）", () => {
  const registry = createBuiltinRegistry({});
  const tool = registry.get("render_patent_document");
  assert.ok(tool, "render_patent_document 应已注册");
  assert.equal(tool!.domain, "patent");
});

test("render_patent_document 工具执行并返回 file 产物块", async () => {
  const dir = makeTempDir();
  const tool = createRenderPatentDocumentTool();
  const res = await tool.execute(
    {
      template: "patentability-opinion",
      output_name: "tool-test",
      output_dir: dir,
      format: "html",
      sections: {
        "meta-client": "客户 A",
        "meta-title": "工具渲染测试",
      },
      brand: { firm: "工具测试事务所" },
    },
    makeToolContext(),
  );

  const htmlFile = res.content.find(
    (c): c is { type: "file"; path: string; mimeType?: string } => c.type === "file" && c.mimeType === "text/html",
  );
  assert.ok(htmlFile, "应返回 HTML file 块");
  assert.ok(existsSync(htmlFile.path));
  const html = readFileSync(htmlFile.path, "utf8");
  assert.match(html, /工具测试事务所/);
  assert.match(html, /客户 A/);
  assert.match(html, /工具渲染测试/);
});

test("render_patent_document 工具未知模板 fail-closed 抛错", async () => {
  const tool = createRenderPatentDocumentTool();
  await assert.rejects(
    tool.execute(
      {
        template: "no-such-template",
        output_name: "bad",
        sections: {},
      },
      makeToolContext(),
    ),
    (err: unknown) => {
      if (!(err instanceof SatiToolRuntimeError)) return false;
      assert.equal(err.code, "invalid_tool_input");
      assert.match(err.message, /未知模板/);
      return true;
    },
  );
});

test("render_patent_document 工具非法 format fail-closed 抛错", async () => {
  const tool = createRenderPatentDocumentTool();
  await assert.rejects(
    tool.execute(
      {
        template: "patentability-opinion",
        output_name: "bad-format",
        format: "pptx",
        sections: {},
      },
      makeToolContext(),
    ),
    (err: unknown) => err instanceof SatiToolRuntimeError && err.code === "invalid_tool_input",
  );
});

test("render_patent_document schema 与描述公开 docx/all（申请文件件键）", () => {
  const tool = createRenderPatentDocumentTool();
  assert.deepEqual(tool.inputSchema.properties?.format?.enum, ["html", "pdf", "both", "docx", "all"]);
  assert.match(tool.description, /docx/);
  // 件键是契约面：描述里必须列出全部五件，避免与 APPLICATION_PARTS 漂移。
  for (const part of ["abstract", "abstract-figure", "claims", "specification", "drawings"]) {
    assert.ok(tool.description.includes(part), `描述未列出件键 ${part}`);
  }
});

test("render_patent_document format=docx 产出申请文件 docx 并返回 file 块", async () => {
  const dir = makeTempDir();
  const tool = createRenderPatentDocumentTool();
  const res = await tool.execute(
    {
      template: "claims-spec",
      output_name: "app-claims",
      output_dir: dir,
      format: "docx",
      sections: {
        claims: "<p>1. 一种智能保温杯，其特征在于包括杯体与温控层。</p>",
        specification: "<h1>技术领域</h1><p>本发明涉及保温杯技术领域。</p>",
      },
    },
    makeToolContext(),
  );

  const textBlock = res.content.find(c => c.type === "text");
  if (textBlock === undefined || textBlock.type !== "text") throw new Error("缺少文本产物块");
  assert.match(textBlock.text, /^DOCX: /m, "输出行应报告 docx 路径");
  assert.doesNotMatch(textBlock.text, /^PDF: /m, "format=docx 不应产出 PDF");
  assert.doesNotMatch(textBlock.text, /DOCX 未生成/, "docx 不应降级");

  const docxFile = res.content.find(
    (c): c is { type: "file"; path: string; mimeType?: string } =>
      c.type === "file" && c.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.ok(docxFile, "应返回 DOCX file 块（含正确 mime）");
  assert.ok(existsSync(docxFile.path));
  assert.ok(docxFile.path.endsWith(".docx"));
});

test("render_patent_document 模板无 docx 母版却要 docx 时 fail-closed", async () => {
  const tool = createRenderPatentDocumentTool();
  await assert.rejects(
    tool.execute(
      {
        template: "patentability-opinion",
        output_name: "no-master",
        format: "docx",
        sections: { abstract: "摘要" },
      },
      makeToolContext(),
    ),
    (err: unknown) => {
      if (!(err instanceof SatiToolRuntimeError)) return false;
      assert.equal(err.code, "invalid_tool_input");
      assert.match(err.message, /docx 母版/);
      // 错误文案须指出当前具备 docx 能力的模板，便于调用方改正。
      assert.match(err.message, /claims-spec/);
      return true;
    },
  );
});
