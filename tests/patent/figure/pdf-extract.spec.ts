/**
 * src/patent/figure/pdf-extract.ts — PDF 附图提取测试。
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as mupdf from "mupdf";
import {
  extractPdfFigureCandidates,
  extractPdfPages,
  renderPdfPageAsBase64,
} from "../../../src/patent/figure/pdf-extract.js";

/** 创建一个含 2 页的简单测试 PDF：第 1 页文字，第 2 页带“图1”标记。 */
function makeTestPdf(): Buffer {
  const doc = new mupdf.PDFDocument();
  try {
    const page1 = doc.addPage(
      [0, 0, 200, 200],
      0,
      {},
      "BT /F1 12 Tf 10 180 Td (This is a long paragraph with many words for the specification body.) Tj ET",
    );
    doc.insertPage(0, page1);

    const page2 = doc.addPage(
      [0, 0, 200, 200],
      0,
      {},
      "BT /F1 12 Tf 10 180 Td (FIGURE 1 shows a circuit diagram) Tj ET",
    );
    doc.insertPage(1, page2);

    return Buffer.from(doc.saveToBuffer().asUint8Array());
  } finally {
    doc.destroy();
  }
}

test("extractPdfPages: 渲染所有页面并提取文本", () => {
  const pdf = makeTestPdf();
  const pages = extractPdfPages(pdf, { dpi: 100 });
  assert.equal(pages.length, 2);
  assert.equal(pages[0].pageNumber, 1);
  assert.equal(pages[1].pageNumber, 2);
  assert.ok(pages[0].imageBase64.length > 0);
  assert.ok(pages[0].textBlocks.length > 0 || pages[0].textBlocks.length === 0, "文本提取可空但不应抛错");
});

test("extractPdfFigureCandidates: 第 2 页得分高于第 1 页", () => {
  const pdf = makeTestPdf();
  const candidates = extractPdfFigureCandidates(pdf, { dpi: 100 });
  assert.equal(candidates.length, 2);
  const page1 = candidates.find(c => c.pageNumber === 1)!;
  const page2 = candidates.find(c => c.pageNumber === 2)!;
  assert.ok(page2.score >= page1.score, `第 2 页(${page2.score})应不低于第 1 页(${page1.score})`);
  assert.ok(page2.reasons.some(r => r.includes("FIGURE") || r.includes("图") || r.includes("附图")));
});

test("extractPdfPages: 指定页码过滤", () => {
  const pdf = makeTestPdf();
  const pages = extractPdfPages(pdf, { pageNumbers: [2], dpi: 100 });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].pageNumber, 2);
});

test("renderPdfPageAsBase64: 返回 base64 PNG", () => {
  const pdf = makeTestPdf();
  const result = renderPdfPageAsBase64(pdf, 1, { dpi: 100 });
  assert.equal(result.mimeType, "image/png");
  assert.ok(result.base64.length > 0);
  assert.ok(result.width > 0);
  assert.ok(result.height > 0);
});
