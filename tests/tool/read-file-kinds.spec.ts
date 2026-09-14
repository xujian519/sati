/**
 * read_file 分支直测（TD-TOOL-001 拆分后的 image/pdf/notebook handler）。
 *
 * 这三条分支此前的直接覆盖为零：既有 spec 只走文本路径
 * （tests/tool/read-file-large.spec.ts / tool-result-workspace-path.spec.ts）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as mupdf from "mupdf";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";
import { FILE_UNCHANGED_STUB } from "../../src/tool/builtin/filesystem/read-file/constants.js";

function context(cwd: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd,
    permissionMode: "bypassPermissions" as const,
    permissionContext: {
      mode: "bypassPermissions" as const,
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    now: () => new Date("2026-07-09T00:00:00.000Z"),
    ...extra,
  };
}

/** 生成含 `pageCount` 页的测试 PDF（复用 tests/patent/figure 的 mupdf 造件方式）。 */
function makeTestPdf(pageCount: number): Buffer {
  const doc = new mupdf.PDFDocument();
  try {
    for (let index = 0; index < pageCount; index++) {
      const page = doc.addPage([0, 0, 200, 200], 0, {}, `BT /F1 12 Tf 10 180 Td (page ${index + 1}) Tj ET`);
      doc.insertPage(index, page);
    }
    return Buffer.from(doc.saveToBuffer().asUint8Array());
  } finally {
    doc.destroy();
  }
}

async function writeImage(path: string): Promise<void> {
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default;
  // 确定性噪声图案：保证 PNG 体积超过 1KB（validateAndRepairImage 的快速通道阈值），
  // 使该用例走“原样透传”路径而非 sharp 重编码修复路径。
  const width = 256;
  const raw = Buffer.alloc(width * width * 3);
  for (let index = 0; index < raw.length; index++) {
    raw[index] = (index * 7 + 13) & 0xff;
  }
  await sharp(raw, { raw: { width, height: width, channels: 3 } })
    .png()
    .toFile(path);
}

const NOTEBOOK = JSON.stringify({
  cells: [
    { cell_type: "markdown", source: ["# Title\n"], metadata: {} },
    {
      cell_type: "code",
      source: ["print(1)\n"],
      outputs: [{ output_type: "stream", text: ["1\n"] }],
      metadata: {},
    },
  ],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
});

test("read_file image: 模型不支持图片输入时返回文本说明且不登记去重", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-read-image-"));
  try {
    await writeImage(join(root, "pic.png"));
    const ctx = context(root, { modelMultimodal: { input: ["text"] } });
    const result = await createReadFileTool().execute({ file_path: "pic.png" }, ctx as never);

    assert.equal(result.content[0]?.type, "text");
    assert.match(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      /^\[Image file: pic\.png, \d+ bytes, image\/png\. Current model does not support image input\.\]$/,
    );
    assert.deepEqual(result.data, { filePath: "pic.png", kind: "image", modelSupportsImage: false });
    // 未附加为模型可见内容 → 不应登记为“已读”，否则后续读会被误判为 unchanged。
    const readFileState = (ctx as { readFileState?: Map<string, unknown> }).readFileState;
    assert.equal(readFileState?.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_file image: 支持图片输入的模型收到原样透传的 image 块，重复读返回 unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-read-image-ok-"));
  try {
    await writeImage(join(root, "pic.png"));
    const fixtureBytes = (await stat(join(root, "pic.png"))).size;
    assert.ok(fixtureBytes > 1000, `PNG fixture must exceed the 1KB fast-path threshold (got ${fixtureBytes})`);
    const ctx = context(root, { modelMultimodal: { input: ["text", "image"], imageDetail: "high" } });
    const tool = createReadFileTool();
    const result = await tool.execute({ file_path: "pic.png" }, ctx as never);

    assert.equal(result.content[0]?.type, "image");
    const data = result.data as { kind?: string; mimeType?: string; bytes?: number; originalBytes?: number };
    assert.equal(data.kind, "image");
    assert.equal(data.mimeType, "image/png");
    assert.equal(data.bytes, fixtureBytes);
    assert.equal(data.originalBytes, fixtureBytes);

    const repeat = await tool.execute({ file_path: "pic.png" }, ctx as never);
    assert.equal(repeat.content[0]?.type === "text" ? repeat.content[0].text : "", FILE_UNCHANGED_STUB);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_file validateInput: 二进制扩展名在读取前被拒", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-read-binary-"));
  try {
    await writeFile(join(root, "clip.mp3"), Buffer.alloc(4096, 1));
    const result = await createReadFileTool().validateInput?.({ file_path: "clip.mp3" }, context(root) as never);

    assert.equal(result?.ok, false);
    assert.equal(result?.ok === false ? result.issues[0]?.path : undefined, "file_path");
    assert.match(
      result?.ok === false ? (result.issues[0]?.message ?? "") : "",
      /^binary files are not supported by read_file\./,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_file notebook: 渲染 cell 并按 offset/limit 切片", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-read-nb-"));
  try {
    await writeFile(join(root, "nb.ipynb"), NOTEBOOK);
    const tool = createReadFileTool();

    const full = await tool.execute({ file_path: "nb.ipynb" }, context(root) as never);
    assert.equal(full.content[0]?.type, "text");
    const text = full.content[0]?.type === "text" ? full.content[0].text : "";
    assert.match(text, /^1\|/m);
    assert.match(text, /Title/);
    const fullData = full.data as { kind?: string; cellCount?: number; truncated?: boolean };
    assert.equal(fullData.kind, "notebook");
    assert.equal(fullData.cellCount, 2);
    assert.equal(fullData.truncated, false);

    const sliced = await tool.execute({ file_path: "nb.ipynb", offset: 3, limit: 2 }, context(root) as never);
    const slicedData = sliced.data as { startLine?: number; truncated?: boolean };
    assert.equal(slicedData.startLine, 3);
    assert.equal(slicedData.truncated, true);
    assert.equal(sliced.metadata?.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_file pdf: 指定 pages 但模型不支持图片输入时返回文本说明", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-read-pdf-noimg-"));
  try {
    await writeFile(join(root, "doc.pdf"), makeTestPdf(1));
    const result = await createReadFileTool().execute(
      { file_path: "doc.pdf", pages: "1" },
      context(root, { modelMultimodal: { input: ["text", "pdf"] } }) as never,
    );

    assert.match(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      /Current model does not support image input; cannot render requested pages\.\]$/,
    );
    assert.deepEqual(result.data, {
      filePath: "doc.pdf",
      kind: "pdf",
      modelSupportsImage: false,
      pageCount: 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_file pdf: 请求页超出实际页数时抛错", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-read-pdf-range-"));
  try {
    await writeFile(join(root, "doc.pdf"), makeTestPdf(1));
    await assert.rejects(
      () =>
        createReadFileTool().execute(
          { file_path: "doc.pdf", pages: "1-5" },
          context(root, { modelMultimodal: { input: ["text", "pdf", "image"] } }) as never,
        ),
      /PDF page range 1-5 exceeds the detected page count \(1\)\./,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_file pdf: 未指定 pages 且页数超阈值时给出 pages 引导", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-read-pdf-many-"));
  try {
    await writeFile(join(root, "many.pdf"), makeTestPdf(12));
    await assert.rejects(
      () =>
        createReadFileTool().execute(
          { file_path: "many.pdf" },
          context(root, { modelMultimodal: { input: ["text", "pdf"] } }) as never,
        ),
      /This PDF has 12 pages, which is too many to read at once\..*Maximum 20 pages per request\./s,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_file pdf: 支持 PDF 的小文件作为 document 块返回", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-read-pdf-doc-"));
  try {
    await writeFile(join(root, "doc.pdf"), makeTestPdf(2));
    const result = await createReadFileTool().execute(
      { file_path: "doc.pdf" },
      context(root, { modelMultimodal: { input: ["text", "pdf"] } }) as never,
    );

    const supplemental = result.supplementalMessages?.[0];
    assert.ok(supplemental && Array.isArray(supplemental.content));
    assert.equal(supplemental.content[0]?.type, "pdf");
    const data = result.data as { kind?: string; bytes?: number; pageCount?: number };
    assert.equal(data.kind, "pdf");
    assert.equal(data.pageCount, 2);
    assert.ok((data.bytes ?? 0) > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_file pdf: 模型缺 PDF 输入时降级为图片渲染", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-read-pdf-degrade-"));
  try {
    await writeFile(join(root, "doc.pdf"), makeTestPdf(1));
    const result = await createReadFileTool().execute(
      { file_path: "doc.pdf" },
      context(root, { modelMultimodal: { input: ["text", "image"] } }) as never,
    );

    const data = result.data as { pdfPagesRendered?: boolean; degradeReason?: string; modelSupportsPdf?: boolean };
    assert.equal(data.pdfPagesRendered, true);
    assert.equal(data.degradeReason, "model does not support PDF input");
    assert.equal(data.modelSupportsPdf, false);
    assert.match(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      /^\[PDF pages rendered from doc\.pdf: 1-1 of 1 \(model does not support PDF input\)\.\]$/,
    );
    assert.equal(result.supplementalMessages?.[0]?.content[0]?.type, "image");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_file pdf: pages 指定页码渲染为图片并标注页范围", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-read-pdf-pages-"));
  try {
    await writeFile(join(root, "doc.pdf"), makeTestPdf(3));
    const result = await createReadFileTool().execute(
      { file_path: "doc.pdf", pages: "2-3" },
      context(root, { modelMultimodal: { input: ["text", "pdf", "image"] } }) as never,
    );

    assert.match(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      /^PDF pages extracted: 2 page\(s\) from doc\.pdf \(pages 2-3 of 3\)\.$/,
    );
    const imageContent = result.supplementalMessages?.[0]?.content ?? [];
    assert.equal(imageContent.length, 2);
    assert.equal(imageContent[0]?.type, "image");
    const data = result.data as { requestedPages?: string; renderedPages?: { firstPage?: number; lastPage?: number } };
    assert.equal(data.requestedPages, "2-3");
    assert.deepEqual(data.renderedPages, { firstPage: 2, lastPage: 3 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_file validateInput: pages 段落校验与空白归一", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-read-validate-"));
  try {
    await writeFile(join(root, "doc.pdf"), makeTestPdf(1));
    const tool = createReadFileTool();

    const blank = await tool.validateInput?.({ file_path: "doc.pdf", pages: "   " }, context(root) as never);
    assert.equal(blank?.ok, true);

    const malformed = await tool.validateInput?.({ file_path: "doc.pdf", pages: "abc" }, context(root) as never);
    assert.equal(malformed?.ok, false);
    assert.equal(malformed?.ok === false ? malformed.issues[0]?.path : undefined, "pages");

    const tooMany = await tool.validateInput?.({ file_path: "doc.pdf", pages: "1-25" }, context(root) as never);
    assert.equal(tooMany?.ok, false);
    assert.match(
      tooMany?.ok === false ? (tooMany.issues[0]?.message ?? "") : "",
      /pages exceeds the maximum of 20 pages per request\./,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
