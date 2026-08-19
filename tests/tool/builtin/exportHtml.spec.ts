import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExportHtmlTool } from "../../../src/tool/builtin/exportHtml.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

function baseContext(cwd: string): SatiToolRuntimeContext {
  return {
    cwd,
    projectRoot: cwd,
    env: {},
    abortSignal: undefined,
  } as unknown as SatiToolRuntimeContext;
}

test("export_html exports zhihu and returns a file artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-export-html-tool-"));
  try {
    const input = join(root, "page.html");
    const outputDir = join(root, "out");
    await writeFile(
      input,
      `<!DOCTYPE html><html lang="zh-CN"><head></head><body><mjx-container>E=mc^2</mjx-container></body></html>`,
      "utf8",
    );

    const tool = createExportHtmlTool();
    const result = await tool.execute(
      { html_path: input, targets: ["zhihu"], output_dir: outputDir },
      baseContext(root),
    );

    assert.equal(result.data?.results[0]?.target, "zhihu");
    const outPath = result.data?.results[0]?.path;
    assert.ok(outPath);
    assert.match(await readFile(outPath, "utf8"), /data-eeimg/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export_html inlines CSS for wechat", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-export-wechat-tool-"));
  try {
    const input = join(root, "page.html");
    const outputDir = join(root, "out");
    await writeFile(
      input,
      `<!DOCTYPE html><html lang="zh-CN"><head><style>.x{color:#1f3a5f}</style></head><body><p class="x">ok</p></body></html>`,
      "utf8",
    );

    const tool = createExportHtmlTool();
    const result = await tool.execute(
      { html_path: input, targets: ["wechat"], output_dir: outputDir },
      baseContext(root),
    );

    const outPath = result.data?.results[0]?.path;
    assert.ok(outPath);
    assert.match(await readFile(outPath, "utf8"), /color: #1f3a5f/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export_html rejects invalid targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-export-invalid-"));
  try {
    const input = join(root, "page.html");
    await writeFile(input, `<!DOCTYPE html><html lang="zh-CN"><body>ok</body></html>`, "utf8");
    const tool = createExportHtmlTool();
    await assert.rejects(
      () => tool.execute({ html_path: input, targets: ["bogus" as never] }, baseContext(root)),
      (err: unknown) => {
        assert.match((err as Error).message, /非法导出目标/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
