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
