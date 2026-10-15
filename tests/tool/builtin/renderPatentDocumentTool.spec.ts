import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRenderPatentDocumentTool,
  formatRenderResultLines,
} from "../../../src/tool/builtin/renderPatentDocument.js";
import type { DocumentRenderResult } from "../../../src/patent/document/index.js";
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
  assert.doesNotMatch(textBlock.text, /DOCX (生成失败|成品核验未通过|成品核验未能执行)/, "正常渲染不应有 docx 问题行");
  // 产物存在还不够：核验结论也要露出来，「已核验」不能与「未核验」同形。
  assert.match(textBlock.text, /^DOCX 成品核验通过（/m, "应报告成品核验通过");

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

// ------------------------------------------------------- 输出行（降级组合）

/** 造一个最小渲染结果（只用于断言输出行映射）。 */
function resultWith(overrides: Partial<DocumentRenderResult>): DocumentRenderResult {
  return { htmlPath: "/out/doc.html", ...overrides };
}

test("输出行：PDF 未生成时补前缀（pdfError 是裸原因，不像 docxError 自带标签）", () => {
  const lines = formatRenderResultLines(resultWith({ pdfError: "Chrome 不可用" }));
  assert.ok(lines.includes("PDF 未生成: Chrome 不可用"));
});

test("输出行：有路径但无核验结论——不得谎报「核验通过」", () => {
  const lines = formatRenderResultLines(resultWith({ docxPath: "/out/doc.docx" }));
  assert.ok(lines.includes("DOCX: /out/doc.docx"));
  assert.equal(lines.filter(line => line.startsWith("DOCX")).length, 1, "无核验结论时不应多出核验行");
  assert.ok(!lines.some(line => line.includes("核验通过")), "没核验过就不能说通过");
});

test("输出行：docx 核验通过——给出实测摘要（「已核验」不得与「未核验」同形）", () => {
  const lines = formatRenderResultLines(
    resultWith({
      docxPath: "/out/doc.docx",
      docxVerification: {
        passed: true,
        findings: [],
        info: {
          sections: [
            { part: "claims", headerTitle: "权利要求书", paragraphs: 3, figures: 0, tables: 0 },
            { part: "drawings", headerTitle: "说明书附图", paragraphs: 0, figures: 1, tables: 0 },
          ],
          headers: ["权利要求书", "说明书附图"],
          template: { sections: 2, bodyFirstLine: "0" },
          residueMarkersChecked: false,
        },
      },
    }),
  );
  assert.ok(
    lines.some(line => line.includes("成品核验通过") && line.includes("2 节，3 段，1 图")),
    `核验通过须带实测摘要：${JSON.stringify(lines)}`,
  );
});

test("输出行：docx 生成成功但核验未过——路径行与问题行并存（文件在 ≠ 可用）", () => {
  const lines = formatRenderResultLines(
    resultWith({
      docxPath: "/out/doc.docx",
      docxError: "DOCX 成品核验未通过（1 项）：「权利要求书」的文本未落地（段落 0，表格 0）",
    }),
  );
  assert.ok(lines.includes("DOCX: /out/doc.docx"), "文件确实生成了，路径必须报告");
  assert.ok(
    lines.some(line => line.includes("核验未通过")),
    `核验结论必须在工具输出里可见：${JSON.stringify(lines)}`,
  );
});

test("输出行：docx 核验未能执行——如实报出，不得呈现成「已核验且无问题」", () => {
  const lines = formatRenderResultLines(
    resultWith({ docxPath: "/out/doc.docx", docxError: "DOCX 成品核验未能执行：docx 缺少 word/document.xml" }),
  );
  assert.ok(
    lines.some(line => line.includes("未能执行")),
    JSON.stringify(lines),
  );
});

test("输出行：docx 根本没生成——报问题行且不得出现 DOCX 路径行", () => {
  const lines = formatRenderResultLines(resultWith({ docxError: "DOCX 生成失败：母版缺少分节" }));
  assert.ok(
    lines.some(line => line.includes("生成失败")),
    JSON.stringify(lines),
  );
  assert.ok(!lines.some(line => line.startsWith("DOCX: ")), "没产物就不该有路径行");
});
