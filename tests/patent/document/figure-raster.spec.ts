/**
 * 矢量附图栅格化（SVG → PNG）+ 申请文件嵌图 + 成品图相关断言。
 *
 * 覆盖三块：
 * ① **A2 栅格化**：`figureRaster.ts` 的物理尺寸换算、sharp 路径、回退链路与降级标记；
 * ② **A2 嵌图**：`imageInfo.ts` 的 SVG 探测 + `renderApplicationDocx.ts` 的「先栅格化再嵌图」；
 * ③ **A3 断言**：`verifyApplicationDocx.ts` 的每图一页 / 图号文字与图序一致 / 摘要附图恰 1 张。
 *
 * ⚠️ **skip 即无信号，不是通过**（仓库 AGENTS.md 第 11 条）：本文件里唯一依赖
 * 外部 Chrome 的用例（真实 Chrome 截图路径）在 Chrome 缺失或无头不可用时会被
 * `t.skip()` 跳过——跳过表示「这条能力在本环境没有被验证过」，不得当成「验证通过」。
 * 其余用例不依赖 Chrome（sharp 在本仓为既有依赖），默认必须真跑。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import {
  FigureRasterError,
  chromeFigureRasterBackend,
  rasterizeFigureSvg,
  rasterizeFigureSvgText,
  resolveFigurePixelSize,
  type FigureRasterBackend,
} from "../../../src/patent/document/docx/figureRaster.js";
import { probeImage } from "../../../src/patent/document/docx/imageInfo.js";
import { verifyApplicationDocxPackage } from "../../../src/patent/document/docx/verifyApplicationDocx.js";
import { renderPatentDocument } from "../../../src/patent/document/index.js";

/** 100mm × 50mm 的矢量附图（附图产物的典型形态：带物理尺寸 + viewBox）。 */
const SVG_WITH_MM = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50">
  <rect width="100" height="50" fill="#336699"/>
  <circle cx="50" cy="25" r="20" fill="#ffffff"/>
</svg>`;

/** 只有 viewBox 的矢量附图（无物理尺寸声明，按 96dpi 用户单位兜底）。 */
const SVG_VIEWBOX_ONLY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <rect width="400" height="300" fill="#993366"/>
</svg>`;

/** 2×2 真实 PNG（位图分支回归用）。 */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DAwMDAxMDAwMAAAAwBAQDJ/pLvAAAAAElFTkSuQmCC";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-figraster-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- ① 物理尺寸换算

test("物理尺寸换算：毫米优先，viewBox 按 96dpi 兜底，DPI 可覆盖", () => {
  // 100mm × 50mm @300dpi = 1181 × 591 px
  const mm = resolveFigurePixelSize(SVG_WITH_MM);
  assert.equal(mm.widthPx, 1181);
  assert.equal(mm.heightPx, 591);
  assert.equal(mm.dpi, 300);

  // 150dpi 约为一半
  const half = resolveFigurePixelSize(SVG_WITH_MM, 150);
  assert.equal(half.widthPx, 591);
  assert.equal(half.heightPx, 295);

  // viewBox 400×300 用户单位 = 400×300 CSS px @96dpi → @300dpi = 1250×938
  const viewBoxOnly = resolveFigurePixelSize(SVG_VIEWBOX_ONLY);
  assert.equal(viewBoxOnly.widthPx, 1250);
  assert.equal(viewBoxOnly.heightPx, 938);
});

test("物理尺寸换算：既无 width/height 也无 viewBox 时报错（不猜尺寸）", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
  assert.throws(() => resolveFigurePixelSize(svg), FigureRasterError);
});

// ---------------------------------------------------------------- ② sharp 栅格化

test("sharp 路径：SVG 栅格化成 PNG，像素与目标 DPI 相符且无降级标记", async () => {
  const dir = makeTempDir();
  try {
    const svgPath = join(dir, "fig1.svg");
    writeFileSync(svgPath, SVG_WITH_MM, "utf8");
    const raster = await rasterizeFigureSvg(svgPath);

    // PNG 签名
    assert.deepEqual([...raster.bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(raster.widthPx, 1181);
    assert.equal(raster.heightPx, 591);
    assert.equal(raster.degraded, undefined, "sharp 路径正常时不得出现降级标记");

    // 文件头实测尺寸必须与返回值一致（返回的是产物真相，不是目标值）
    const probe = probeImage(raster.bytes);
    assert.ok(probe !== undefined);
    assert.equal(probe.ext, "png");
    assert.equal(probe.widthPx, raster.widthPx);
    assert.equal(probe.heightPx, raster.heightPx);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- ③ 回退链路与降级标记

test("回退链路：前一条路失败时走下一条，并在返回值里标出降级原因", async () => {
  const failing: FigureRasterBackend = {
    name: "fake-sharp",
    render: async () => {
      throw new Error("模拟的渲染失败");
    },
  };
  const fallback: FigureRasterBackend = {
    name: "fake-fallback",
    render: async context => {
      // 用一个最小合法 PNG 顶替（尺寸取目标值，便于断言下游按产物尺寸工作）
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DAwMDAxMDAwMAAAAwBAQDJ/pLvAAAAAElFTkSuQmCC",
        "base64",
      );
      assert.ok(context.widthPx > 0);
      return png;
    },
  };

  const raster = await rasterizeFigureSvgText(SVG_WITH_MM, { backends: [failing, fallback] });
  assert.ok(raster.degraded !== undefined, "走了回退路径必须带降级说明（降级但不静默）");
  assert.match(raster.degraded.reason, /fake-sharp/);
  assert.match(raster.degraded.reason, /模拟的渲染失败/);
  assert.match(raster.degraded.reason, /fake-fallback|已回退/);
});

test("两条路径都失败时抛结构化错误，原因里点名每条路径（不静默丢图）", async () => {
  const backend = (name: string): FigureRasterBackend => ({
    name,
    render: async () => {
      throw new Error(`${name} 失败`);
    },
  });
  await assert.rejects(
    () => rasterizeFigureSvgText(SVG_WITH_MM, { backends: [backend("a"), backend("b")] }),
    (err: unknown) => {
      assert.ok(err instanceof FigureRasterError);
      assert.match(err.reason, /a 失败/);
      assert.match(err.reason, /b 失败/);
      return true;
    },
  );
});

test("真实 Chrome 路径（环境相关）：Chrome 不可用时跳过——skip 即无信号，不是通过", async t => {
  const dir = makeTempDir();
  try {
    const svgPath = join(dir, "fig1.svg");
    writeFileSync(svgPath, SVG_WITH_MM, "utf8");
    let raster;
    try {
      raster = await rasterizeFigureSvgText(SVG_WITH_MM, { backends: [chromeFigureRasterBackend], svgPath });
    } catch (err) {
      t.skip(`本环境 Chrome 无头不可用（${err instanceof Error ? err.message : String(err)}）——本用例未被验证`);
      return;
    }
    assert.equal(raster.widthPx, 1181);
    assert.equal(raster.heightPx, 591);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- ④ SVG 探测与位图回归

test("SVG 探测：根标签 + width/height 换算出像素尺寸，contentType 为 image/svg+xml", () => {
  const probe = probeImage(new TextEncoder().encode(SVG_WITH_MM));
  assert.ok(probe !== undefined);
  assert.equal(probe.ext, "svg");
  assert.equal(probe.contentType, "image/svg+xml");
  // 100mm = 377.95 CSS px（96dpi）
  assert.ok(Math.abs(probe.widthPx - (100 / 25.4) * 96) < 0.01);
  assert.ok(Math.abs(probe.heightPx - (50 / 25.4) * 96) < 0.01);
});

test("SVG 探测：width 不可解析时用 viewBox 兜底", () => {
  const probe = probeImage(
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 400 300"/>'),
  );
  assert.ok(probe !== undefined);
  assert.equal(probe.ext, "svg");
  assert.equal(probe.widthPx, 400);
  assert.equal(probe.heightPx, 300);
});

test("位图分支回归：PNG/GIF/BMP 的判定不受 SVG 分支影响", () => {
  const png = probeImage(Buffer.from(TINY_PNG_BASE64, "base64"));
  assert.ok(png !== undefined);
  assert.equal(png.ext, "png");
  assert.equal(png.widthPx, 2);
  assert.equal(png.heightPx, 2);

  // GIF87a：逻辑屏幕描述符宽高
  const gif = probeImage(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x10, 0x00, 0x20, 0x00]));
  assert.ok(gif !== undefined);
  assert.equal(gif.ext, "gif");
  assert.equal(gif.widthPx, 16);
  assert.equal(gif.heightPx, 32);

  // BMP：BITMAPINFOHEADER 宽高
  const bmp = Buffer.alloc(30);
  bmp.write("BM", 0, "ascii");
  bmp.writeInt32LE(16, 18);
  bmp.writeInt32LE(24, 22);
  const bmpProbe = probeImage(bmp);
  assert.ok(bmpProbe !== undefined);
  assert.equal(bmpProbe.ext, "bmp");
  assert.equal(bmpProbe.widthPx, 16);
  assert.equal(bmpProbe.heightPx, 24);
});

// ---------------------------------------------------------------- ⑤ docx 嵌图接线

test("docx 嵌图：SVG 附图先栅格化成 PNG 再嵌入（media 后缀为 png）", async () => {
  const dir = makeTempDir();
  try {
    const svgPath = join(dir, "fig1.svg");
    writeFileSync(svgPath, SVG_WITH_MM, "utf8");
    const result = await renderPatentDocument(
      {
        template: "claims-spec",
        outputName: "app",
        outputDir: dir,
        format: "docx",
        sections: { drawings: `<p><img src="${svgPath}" alt="图1" /></p>` },
      },
      process.cwd(),
    );
    assert.equal(result.docxError, undefined, `docx 生成失败: ${result.docxError ?? ""}`);
    assert.ok(result.docxPath !== undefined);

    const zip = await JSZip.loadAsync(readFileSync(result.docxPath));
    const media = Object.keys(zip.files).filter(name => name.startsWith("word/media/"));
    assert.deepEqual(media, ["word/media/image1.png"], "矢量附图必须以 PNG 进包");
    const png = await zip.file("word/media/image1.png")?.async("nodebuffer");
    assert.ok(png !== undefined);
    const probe = probeImage(png);
    assert.ok(probe !== undefined);
    assert.equal(probe.ext, "png");
    assert.equal(probe.widthPx, 1181);
    assert.equal(probe.heightPx, 591);

    const contentTypes = await zip.file("[Content_Types].xml")?.async("string");
    assert.match(contentTypes ?? "", /<Default Extension="png" ContentType="image\/png"\/>/);
  } finally {
    cleanup(dir);
  }
});

test("docx 嵌图：SVG 栅格化失败时告警写明「SVG 栅格化失败」并跳过该图（不阻塞文档）", async () => {
  const dir = makeTempDir();
  try {
    // 既无 width/height 也无 viewBox → 物理尺寸无法判定 → 栅格化必然失败
    const svgPath = join(dir, "broken.svg");
    writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>', "utf8");
    const result = await renderPatentDocument(
      {
        template: "claims-spec",
        outputName: "app",
        outputDir: dir,
        format: "docx",
        sections: { drawings: `<p><img src="${svgPath}" alt="图1" /></p>` },
      },
      process.cwd(),
    );
    assert.ok(result.docxPath !== undefined, "栅格化失败不应让整份文档消失");
    const warnings = result.warnings ?? [];
    assert.ok(
      warnings.some(warning => warning.includes("SVG 栅格化失败")),
      `告警须写明是栅格化失败（不是文件缺失）：${JSON.stringify(warnings)}`,
    );
    const zip = await JSZip.loadAsync(readFileSync(result.docxPath));
    assert.equal(Object.keys(zip.files).filter(name => name.startsWith("word/media/")).length, 0);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------- ⑥ A3 成品图相关断言

/** 造一份带页眉标题的分节 document.xml（让 planSections 能把节映射到件）。 */
function buildSectionedDocument(parts: readonly { title: string; body: string }[]): {
  documentXml: string;
  relationshipsXml: string;
  readPart: (packagePath: string) => string | undefined;
} {
  const relationships: string[] = [];
  const headers = new Map<string, string>();
  const chunks: string[] = [];
  parts.forEach((part, index) => {
    const relId = `rId${index + 1}`;
    const headerName = `header${index + 1}.xml`;
    relationships.push(
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="${headerName}"/>`,
    );
    headers.set(
      `word/${headerName}`,
      `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>${part.title}</w:t></w:r></w:p></w:hdr>`,
    );
    chunks.push(part.body);
    chunks.push(`<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="${relId}"/></w:sectPr></w:pPr></w:p>`);
  });
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${chunks.join("")}<w:sectPr/></w:body></w:document>`;
  return {
    documentXml,
    relationshipsXml: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join("")}</Relationships>`,
    readPart: packagePath => headers.get(packagePath),
  };
}

/** 一张内联图（`<w:drawing/>`）。 */
const DRAWING = "<w:p><w:r><w:drawing/></w:r></w:p>";

/** 一个分页符。 */
const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

/** 一段图号文字。 */
function caption(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

/** 取成品 docx 末节（说明书附图）的内容。 */
async function drawingsSectionXml(docxPath: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(docxPath));
  const documentXml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const bodyStart = documentXml.indexOf("<w:body>");
  const lastSect = documentXml.lastIndexOf("<w:sectPr");
  assert.ok(bodyStart !== -1 && lastSect > bodyStart, "docx 缺少 w:body / 末节 sectPr");
  return documentXml.slice(bodyStart, lastSect);
}

/** 分节里**生效**的分页符数（显式关掉 `pageBreakBefore` 的不算）。 */
function effectivePageBreaks(sectionXml: string): number {
  const before = (sectionXml.match(/<w:pageBreakBefore\b(?![^>]*\bw:val="(?:0|false)")/g) ?? []).length;
  const br = (sectionXml.match(/<w:br\b[^>]*\bw:type="page"/g) ?? []).length;
  return before + br;
}

/** 分节里的顶层段落（含图/文字/是否带生效分页符）。 */
function topLevelParagraphs(sectionXml: string): { xml: string; text: string; hasBreak: boolean }[] {
  return (sectionXml.match(/<w:p>[\s\S]*?<\/w:p>/g) ?? []).map(xml => ({
    xml,
    text: [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(match => match[1] ?? "").join(""),
    hasBreak: effectivePageBreaks(xml) > 0,
  }));
}

test("A3 每图一页：N 张图之间没有 N-1 个分页符即报 fail（渲染链已能产出分页符 ⇒ 这是交付要求，不是能力缺口）", () => {
  const missing = buildSectionedDocument([{ title: "说明书附图", body: DRAWING + DRAWING }]);
  const result = verifyApplicationDocxPackage(missing);
  const findings = result.findings.filter(finding => finding.id === "figure-page-break");
  assert.equal(findings.length, 1, JSON.stringify(result.findings));
  // **fail 而非 warn**：渲染链已能在附图节按「每图一页」插段前分页（见
  // `renderApplicationDocx.ts` 的 `markFigurePageBreaks`），「每图一页」因此是
  // **交付要求**而非渲染链能力缺口——缺分页就是这份申请文件不合格，必须阻断定稿。
  // （此前定为 warn 的理由见 docs/notes/implemented/2026-11-12-figure-dsh-alignment-batch-a.md；
  //  该缺口补上后判据升为 fail。）
  assert.equal(findings[0]?.severity, "fail");
  assert.match(findings[0]?.message ?? "", /2 张图之间实测 0 个分页符，应为 1 个/);
  // 消息要点名**哪两幅图之间缺分页**，并给出改法（否则使用者无从下手）。
  assert.match(findings[0]?.message ?? "", /第 1 幅图与第 2 幅图之间缺分页符/);
  assert.match(findings[0]?.message ?? "", /w:pageBreakBefore/);
  assert.ok(!/渲染链能力缺口/.test(findings[0]?.message ?? ""), "不得再把缺分页说成渲染链能力缺口");
  // fail 级阻断交付：成品核验不算通过。
  assert.equal(result.passed, false);
  assert.equal(result.info.figureChecks?.pageBreak, true);

  const ok = buildSectionedDocument([{ title: "说明书附图", body: DRAWING + PAGE_BREAK + DRAWING }]);
  const okResult = verifyApplicationDocxPackage(ok);
  assert.ok(!okResult.findings.some(finding => finding.id === "figure-page-break"), JSON.stringify(okResult.findings));
  assert.equal(okResult.passed, true);
});

test("A3 每图一页：三幅图的分页符位置不对时逐对点名", () => {
  // 分页符总数对得上（2 个），但断在了「图1|图2」与「图3|」之间——
  // 第 2 幅与第 3 幅之间没有分页符，判据必须按**图对**点名而不是只看总数。
  const doc = buildSectionedDocument([
    { title: "说明书附图", body: DRAWING + PAGE_BREAK + DRAWING + DRAWING + PAGE_BREAK },
  ]);
  const result = verifyApplicationDocxPackage(doc);
  const findings = result.findings.filter(finding => finding.id === "figure-page-break");
  assert.equal(findings.length, 1, JSON.stringify(result.findings));
  assert.equal(findings[0]?.severity, "fail");
  assert.match(findings[0]?.message ?? "", /3 张图之间实测 2 个分页符，应为 2 个/);
  assert.match(findings[0]?.message ?? "", /第 2 幅图与第 3 幅图之间缺分页符/);
  assert.equal(result.passed, false);
});

test("A3 每图一页：两幅图写在同一段落里时如实报「隔不开」，不给无效改法", () => {
  const doc = buildSectionedDocument([
    { title: "说明书附图", body: "<w:p><w:r><w:drawing/></w:r><w:r><w:drawing/></w:r></w:p>" },
  ]);
  const result = verifyApplicationDocxPackage(doc);
  const findings = result.findings.filter(finding => finding.id === "figure-page-break");
  assert.equal(findings.length, 1, JSON.stringify(result.findings));
  assert.equal(findings[0]?.severity, "fail");
  // 段前分页隔不开同一段落里的两幅图 ⇒ 改法必须说「拆段」，不能给无效的「加段前分页」。
  assert.match(findings[0]?.message ?? "", /第 1 幅图与第 2 幅图在同一段落里/);
  assert.match(findings[0]?.message ?? "", /拆到各自独立的段落/);
  assert.equal(result.passed, false);
});

test("A3 每图一页：表格里的图不算附图节的一幅图（不误报）", () => {
  const doc = buildSectionedDocument([
    { title: "说明书附图", body: `<w:tbl><w:tr><w:tc>${DRAWING}</w:tc></w:tr></w:tbl>${DRAWING}` },
  ]);
  const result = verifyApplicationDocxPackage(doc);
  assert.ok(!result.findings.some(finding => finding.id === "figure-page-break"), JSON.stringify(result.findings));
  // 只有一幅（段落里的）图 ⇒ 「每图一页」无判据可依 ⇒ 未检查（不是通过）。
  assert.equal(result.info.figureChecks?.pageBreak, false);
});

test("A3 图号文字与图序一致：图号乱序即报 fail，顺序正确则不报", () => {
  const reversed = buildSectionedDocument([
    { title: "说明书附图", body: DRAWING + caption("图2") + DRAWING + caption("图1") },
  ]);
  const reversedResult = verifyApplicationDocxPackage(reversed);
  const findings = reversedResult.findings.filter(finding => finding.id === "figure-caption-order");
  assert.equal(findings.length, 1, JSON.stringify(reversedResult.findings));
  assert.equal(findings[0]?.severity, "fail");
  assert.equal(reversedResult.info.figureChecks?.captionOrder, true);

  const ordered = buildSectionedDocument([
    { title: "说明书附图", body: DRAWING + caption("图1") + DRAWING + caption("图2") },
  ]);
  const orderedResult = verifyApplicationDocxPackage(ordered);
  assert.ok(
    !orderedResult.findings.some(finding => finding.id === "figure-caption-order"),
    JSON.stringify(orderedResult.findings),
  );
});

test("A3 图号文字：英文图号（FIG. 1）同样纳入图序判据", () => {
  const doc = buildSectionedDocument([
    { title: "说明书附图", body: DRAWING + caption("FIG. 1") + DRAWING + caption("FIG. 3") },
  ]);
  const result = verifyApplicationDocxPackage(doc);
  const findings = result.findings.filter(finding => finding.id === "figure-caption-order");
  assert.equal(findings.length, 1, JSON.stringify(result.findings));
  assert.match(findings[0]?.message ?? "", /1、3/);
});

test("A3 摘要附图恰 1 张：超过 1 张即报 fail", () => {
  const two = buildSectionedDocument([{ title: "摘要附图", body: DRAWING + DRAWING }]);
  const twoResult = verifyApplicationDocxPackage(two);
  const findings = twoResult.findings.filter(finding => finding.id === "abstract-figure-count");
  assert.equal(findings.length, 1, JSON.stringify(twoResult.findings));
  assert.equal(findings[0]?.severity, "fail");
  assert.match(findings[0]?.message ?? "", /应恰有 1 张图，实测 2 张/);
  assert.equal(twoResult.info.figureChecks?.abstractFigureCount, true);

  const one = buildSectionedDocument([{ title: "摘要附图", body: DRAWING }]);
  const oneResult = verifyApplicationDocxPackage(one);
  assert.ok(
    !oneResult.findings.some(finding => finding.id === "abstract-figure-count"),
    JSON.stringify(oneResult.findings),
  );
});

test("A3 没有判据可依时报「未检查」而不是「通过」", () => {
  const empty = buildSectionedDocument([{ title: "说明书附图", body: caption("技术领域") }]);
  const result = verifyApplicationDocxPackage(empty);
  assert.equal(result.info.figureChecks?.pageBreak, false, "附图节没有图 → 每图一页未检查");
  assert.equal(result.info.figureChecks?.captionOrder, false, "附图节没有图号文本 → 图序未检查");
  assert.equal(result.info.figureChecks?.abstractFigureCount, false, "摘要附图节没有图 → 摘要附图数未检查");
  assert.ok(
    !result.findings.some(finding => finding.id.startsWith("figure-") || finding.id === "abstract-figure-count"),
    JSON.stringify(result.findings),
  );
});

test("A3 端到端：两张附图之间实测恰有一个分页符，核验通过（图与图号仍在同一页）", async () => {
  const dir = makeTempDir();
  try {
    const figure = join(dir, "fig.png");
    writeFileSync(figure, Buffer.from(TINY_PNG_BASE64, "base64"));
    const result = await renderPatentDocument(
      {
        template: "claims-spec",
        outputName: "app",
        outputDir: dir,
        format: "docx",
        sections: {
          drawings: `<p><img src="${figure}" alt="图1" /></p><p>图1</p><p><img src="${figure}" alt="图2" /></p><p>图2</p>`,
        },
      },
      process.cwd(),
    );
    assert.ok(result.docxPath !== undefined);
    const verification = result.docxVerification;
    assert.ok(verification !== undefined);
    // 渲染链现在按「每图一页」产出分页符 ⇒ 判据是真检查（fail 级），成品应当通过。
    assert.ok(
      !verification.findings.some(finding => finding.id === "figure-page-break"),
      JSON.stringify(verification.findings),
    );
    assert.ok(!verification.findings.some(finding => finding.id === "figure-caption-order"), "图号顺序正确时不得误报");
    assert.equal(verification.info.figureChecks?.captionOrder, true);
    assert.equal(verification.info.figureChecks?.pageBreak, true);
    assert.equal(verification.passed, true, JSON.stringify(verification.findings));
    assert.equal(result.docxError, undefined);

    // 落到成品上核对：两图之间恰有 1 个**生效**分页符，且它落在第 2 幅图的段落上。
    const drawingsXml = await drawingsSectionXml(result.docxPath);
    assert.equal((drawingsXml.match(/<w:drawing\b/g) ?? []).length, 2);
    assert.equal(effectivePageBreaks(drawingsXml), 1);
    const paragraphs = topLevelParagraphs(drawingsXml);
    assert.equal(paragraphs.length, 4, "附图节应是「图1 / 图1 / 图2 / 图2」四段");
    assert.equal(paragraphs[0]?.hasBreak, false, "第 1 幅图前不加分页符（附图节本身另起一页）");
    assert.equal(paragraphs[1]?.hasBreak, false, "图号段不加分页符（图与图号必须同页）");
    assert.equal(paragraphs[2]?.hasBreak, true, "第 2 幅图的段落前有段前分页");
    assert.equal(paragraphs[3]?.hasBreak, false, "第 2 幅图的图号段不加分页符");
    // 母版体例未被改动：段前分页只改 `w:pageBreakBefore` 一项，其余属性逐条保留。
    assert.match(paragraphs[2]?.xml ?? "", /<w:spacing w:line="360" w:lineRule="auto"\/>/);
    assert.match(paragraphs[2]?.xml ?? "", /<w:ind w:firstLine="0" w:firstLineChars="0"\/>/);
    assert.match(paragraphs[2]?.xml ?? "", /<w:sz w:val="24"\/>/);
    assert.ok(!/<w:pageBreakBefore[^>]*w:val="0"/.test(paragraphs[2]?.xml ?? ""));
  } finally {
    cleanup(dir);
  }
});

test("A3 端到端：图号写在图前时，分页点落在图号之前（图与图号不被拆到两页）", async () => {
  const dir = makeTempDir();
  try {
    const figure = join(dir, "fig.png");
    writeFileSync(figure, Buffer.from(TINY_PNG_BASE64, "base64"));
    const result = await renderPatentDocument(
      {
        template: "claims-spec",
        outputName: "app",
        outputDir: dir,
        format: "docx",
        sections: {
          drawings: `<p>图1</p><p><img src="${figure}" alt="图1" /></p><p>图2</p><p><img src="${figure}" alt="图2" /></p>`,
        },
      },
      process.cwd(),
    );
    assert.ok(result.docxPath !== undefined);
    const verification = result.docxVerification;
    assert.ok(verification !== undefined);
    assert.equal(verification.info.figureChecks?.pageBreak, true);
    assert.ok(
      !verification.findings.some(finding => finding.id === "figure-page-break"),
      JSON.stringify(verification.findings),
    );

    const drawingsXml = await drawingsSectionXml(result.docxPath);
    assert.equal(effectivePageBreaks(drawingsXml), 1);
    const paragraphs = topLevelParagraphs(drawingsXml);
    assert.equal(paragraphs.length, 4);
    // 第 2 幅图的**图号段**带段前分页 ⇒ 图号与它后面的图同属一页。
    assert.equal(paragraphs[2]?.text, "图2");
    assert.equal(paragraphs[2]?.hasBreak, true, "分页点落在第 2 幅图的图号段之前");
    assert.equal(paragraphs[3]?.hasBreak, false, "图段本身不再加分页符");
  } finally {
    cleanup(dir);
  }
});

test("A3 端到端：附图节只有一幅图时判据不适用（未检查 ≠ 通过）", async () => {
  const dir = makeTempDir();
  try {
    const figure = join(dir, "fig.png");
    writeFileSync(figure, Buffer.from(TINY_PNG_BASE64, "base64"));
    const result = await renderPatentDocument(
      {
        template: "claims-spec",
        outputName: "app",
        outputDir: dir,
        format: "docx",
        sections: {
          drawings: `<p><img src="${figure}" alt="图1" /></p><p>图1</p>`,
        },
      },
      process.cwd(),
    );
    assert.ok(result.docxPath !== undefined);
    const verification = result.docxVerification;
    assert.ok(verification !== undefined);
    // 一幅图时「每图一页」无判据可依 ⇒ 如实标「未检查」，且不报发现。
    assert.equal(verification.info.figureChecks?.pageBreak, false);
    assert.ok(
      !verification.findings.some(finding => finding.id === "figure-page-break"),
      JSON.stringify(verification.findings),
    );
    const drawingsXml = await drawingsSectionXml(result.docxPath);
    assert.equal(effectivePageBreaks(drawingsXml), 0, "一幅图不需要任何分页符");
  } finally {
    cleanup(dir);
  }
});
