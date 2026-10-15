/**
 * 申请文件 docx 渲染判据（模板母版 → 五件套 docx）。
 *
 * 判据分三层：
 * ① 纯函数层（`htmlToBlocks` / `planSections` / `derive*` / `fitImage` / `probeImage`）；
 * ② 端到端层（`renderPatentDocument(format:"docx")` → 解包核产物）；
 * ③ 版面不变层（页眉页脚引用、纸张、页边距逐条与母版相等）。
 *
 * 端到端断言一律**按件定位**（文本/图片落在第几个分节区间内），而不是全文 contains——
 * 「内容落地」与「内容落在正确的件里」是两件事。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import {
  APPLICATION_PARTS,
  SatiDocumentInputError,
  buildApplicationBodyContent,
  deriveBodyParagraphProps,
  deriveTitleStyleId,
  fitImage,
  htmlToBlocks,
  listDocxTemplates,
  parseTemplateSections,
  planSections,
  probeImage,
  readContentArea,
  renderPatentDocument,
  resolveTemplateDocxPath,
  type ParsedBlock,
} from "../../../src/patent/document/index.js";

/** 2×2 真实 PNG（合法图片，可被 Word 打开）。 */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DAwMDAxMDAwMAAAAwBAQDJ/pLvAAAAAElFTkSuQmCC";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-appdocx-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 写一张真实小图到临时目录，返回路径。 */
function writeTinyPng(dir: string, name = "fig.png"): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.from(TINY_PNG_BASE64, "base64"));
  return path;
}

async function readPackage(docxPath: string): Promise<JSZip> {
  return JSZip.loadAsync(readFileSync(docxPath));
}

async function readPart(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  assert.ok(file !== null, `docx 内缺少 ${name}`);
  return file.async("string");
}

/** 取 `w:body` 内层 XML。 */
function bodyInner(documentXml: string): string {
  const start = documentXml.indexOf("<w:body>");
  const end = documentXml.lastIndexOf("</w:body>");
  assert.ok(start !== -1 && end !== -1, "docx 缺少 w:body");
  return documentXml.slice(start + "<w:body>".length, end);
}

/**
 * 判定某段文本落在第几个分节区间（0-based）。
 * 分节以 `w:sectPr` 出现位置为切点；文本落在切点之前即为该节内容。
 */
function sectionOfText(documentXml: string, needle: string): number {
  const position = documentXml.indexOf(needle);
  assert.ok(position !== -1, `产物中未找到文本: ${needle}`);
  const boundaries: number[] = [];
  const pattern = /<w:sectPr\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(documentXml)) !== null) boundaries.push(match.index);
  const index = boundaries.findIndex(boundary => position < boundary);
  assert.ok(index !== -1, `文本「${needle}」落在最后一个分节符之后，不属于任何件`);
  return index;
}

/** 逐字符做标签配平校验（判据侧自带的最小 XML 良构检查，不依赖第三方解析器）。 */
function assertWellFormedXml(xml: string, label: string): void {
  const pattern = /<(\/?)([A-Za-z0-9:_.-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const isClosing = match[1] === "/";
    const name = match[2] ?? "";
    const isSelfClosing = match[4] === "/";
    if (isSelfClosing) continue;
    if (isClosing) {
      const open = stack.pop();
      assert.equal(open, name, `${label}: 闭合标签 </${name}> 与 <${open ?? "(空栈)"}> 不匹配`);
      continue;
    }
    stack.push(name);
  }
  assert.deepEqual(stack, [], `${label}: 存在未闭合标签 ${stack.join(", ")}`);
  assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)/.test(xml), `${label}: 存在未转义的 &`);
}

/** 未转义 `<` / `>` 会直接破坏 XML 结构，故单独扫文本节点。 */
function assertNoRawMarkupInText(documentXml: string, label: string): void {
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(documentXml)) !== null) {
    const text = match[1] ?? "";
    assert.ok(!/[<>]/.test(text), `${label}: 文本节点内出现未转义尖括号: ${text.slice(0, 60)}`);
  }
}

/** 断言母版的版面要素（页眉页脚引用、纸张、页边距）被逐条保留。 */
function assertLayoutPreserved(body: string, templateBody: string): void {
  const collect = (xml: string, pattern: RegExp): string[] => xml.match(pattern) ?? [];
  const layoutPattern = /<w:pgSz\b[^/]*\/>|<w:pgMar\b[^/]*\/>|<w:cols\b[^/]*\/>/g;
  const headerPattern = /<w:(?:header|footer)Reference\b[^/]*\/>/g;
  assert.deepEqual(collect(body, layoutPattern), collect(templateBody, layoutPattern), "纸张/页边距/分栏被改动");
  assert.deepEqual(collect(body, headerPattern), collect(templateBody, headerPattern), "页眉页脚引用被改动");
}

/** 取段落块里的文本 run 序列（图片记作 `(img)`），用于断言「文本真的落地了」。 */
function textOf(block: ParsedBlock | undefined): string[] {
  if (block?.kind !== "paragraph") return [];
  return block.runs.map(run => (run.kind === "text" ? run.text : "(img)"));
}

// ---------------------------------------------------------------- 契约层

test("申请文件件契约：五件、顺序与页眉标题", () => {
  assert.deepEqual(
    APPLICATION_PARTS.map(part => part.id),
    ["abstract", "abstract-figure", "claims", "specification", "drawings"],
  );
  assert.deepEqual(
    APPLICATION_PARTS.map(part => part.headerTitle),
    ["说明书摘要", "摘要附图", "权利要求书", "说明书", "说明书附图"],
  );
});

test("仅随附 docx 母版的模板支持 docx 输出", () => {
  assert.deepEqual(listDocxTemplates(), ["claims-spec"]);
  assert.ok(resolveTemplateDocxPath("claims-spec") !== undefined);
  assert.equal(resolveTemplateDocxPath("oa-response"), undefined);
  assert.equal(resolveTemplateDocxPath("patentability-opinion"), undefined);
});

test("母版五节按页眉标题解析（说明书摘要 与 说明书 不串味）", async () => {
  const templatePath = resolveTemplateDocxPath("claims-spec");
  assert.ok(templatePath !== undefined);
  const zip = await readPackage(templatePath);
  const documentXml = await readPart(zip, "word/document.xml");
  const relsXml = await readPart(zip, "word/_rels/document.xml.rels");
  const headers = new Map<string, string>();
  for (const name of Object.keys(zip.files)) {
    if (!/^word\/header[^/]*\.xml$/.test(name)) continue;
    const file = zip.file(name);
    if (file !== null) headers.set(name, await file.async("string"));
  }

  const sections = parseTemplateSections(documentXml, relsXml, name => headers.get(name));
  assert.deepEqual(
    sections.map(section => section.headerTitle),
    ["说明书摘要", "摘要附图", "权利要求书", "说明书", "说明书附图"],
  );

  const plan = planSections(sections);
  assert.deepEqual(
    plan.entries.map(entry => entry.part?.id),
    ["abstract", "abstract-figure", "claims", "specification", "drawings"],
  );
  assert.deepEqual(plan.missingParts, []);
  assert.deepEqual(plan.extraSections, []);
});

test("母版的正文段落属性与标题样式可派生（不写死 id/字号）", async () => {
  const templatePath = resolveTemplateDocxPath("claims-spec");
  assert.ok(templatePath !== undefined);
  const zip = await readPackage(templatePath);
  const documentXml = await readPart(zip, "word/document.xml");
  const stylesXml = await readPart(zip, "word/styles.xml");

  const bodyPPr = deriveBodyParagraphProps(documentXml);
  assert.ok(bodyPPr !== undefined, "未派生出正文段落属性");
  assert.match(bodyPPr, /<w:spacing w:line="360" w:lineRule="auto"\/>/, "母版 1.5 倍行距未进入正文属性");
  assert.match(bodyPPr, /<w:ind w:firstLine="0"/, "母版正文段首不缩进未进入正文属性");

  const titleStyleId = deriveTitleStyleId(stylesXml);
  assert.equal(titleStyleId, "2", "标题样式应由 outlineLvl=0 派生");
  assert.match(stylesXml, new RegExp(`<w:style[^>]*w:styleId="${titleStyleId}"`));

  const firstBoundary = parseTemplateSections(documentXml, "", () => undefined)[0];
  const area = readContentArea(firstBoundary?.boundaryXml.match(/<w:sectPr[\s\S]*<\/w:sectPr>/)?.[0]);
  // A4(11906) − 左右边距(1800×2) = 8306 twip = 5_274_310 EMU
  assert.equal(area.widthEmu, 8306 * 635);
  assert.equal(area.heightEmu, (16838 - 1440 * 2) * 635);
});

test("件按页眉标题对齐，不依赖分节物理顺序", () => {
  const section = (headerTitle: string, boundaryXml: string) => ({ headerTitle, contentXml: "", boundaryXml });
  // 故意打乱顺序：说明书附图 排在最前，且中间插入一个不属于五件套的分节。
  const sections = [
    section("说明书附图", "<w:p>A</w:p>"),
    section("说明书", "<w:p>B</w:p>"),
    section("附加声明", "<w:p>C</w:p>"),
    section("说明书摘要", "<w:p>D</w:p>"),
    section("摘要附图", "<w:p>E</w:p>"),
    section("权利要求书", "<w:p>F</w:p>"),
  ];
  const plan = planSections(sections);
  assert.deepEqual(
    plan.entries.map(entry => entry.part?.id ?? "(保留原文)"),
    ["drawings", "specification", "(保留原文)", "abstract", "abstract-figure", "claims"],
  );
  assert.deepEqual(plan.missingParts, []);
  assert.deepEqual(
    plan.extraSections.map(s => s.headerTitle),
    ["附加声明"],
  );
});

test("母版缺件时 planSections 报出缺失件（供调用方 fail-closed）", () => {
  const sections = [
    { headerTitle: "说明书摘要", contentXml: "", boundaryXml: "<w:p>A</w:p>" },
    { headerTitle: "说明书", contentXml: "", boundaryXml: "<w:p>B</w:p>" },
  ];
  const plan = planSections(sections);
  assert.deepEqual(
    plan.missingParts.map(part => part.id),
    ["abstract-figure", "claims", "drawings"],
  );
});

test("重建 body：未对齐分节保留原文，五件内容替换，收尾原文追加", () => {
  const pieces = [
    {
      section: { headerTitle: "说明书摘要", contentXml: "<w:p>模板原文</w:p>", boundaryXml: "<w:p>S1</w:p>" },
      contentXml: "<w:p>摘要内容</w:p>",
    },
    {
      section: { headerTitle: "附加声明", contentXml: "<w:p>保留的声明</w:p>", boundaryXml: "<w:p>S2</w:p>" },
      contentXml: "<w:p>保留的声明</w:p>",
    },
    {
      section: { headerTitle: "说明书", contentXml: "", boundaryXml: "<w:sectPr><w:pgSz/></w:sectPr>" },
      contentXml: "<w:tbl><w:tr/></w:tbl>",
    },
  ];
  const body = buildApplicationBodyContent(pieces);
  assert.equal(
    body,
    "<w:p>摘要内容</w:p><w:p>S1</w:p>" +
      "<w:p>保留的声明</w:p><w:p>S2</w:p>" +
      // 内容以表格结尾 → 补空段落；末节收尾是 body 级 sectPr
      "<w:tbl><w:tr/></w:tbl><w:p/><w:sectPr><w:pgSz/></w:sectPr>",
  );
});

// ---------------------------------------------------------------- 内容解析层

test("HTML 片段 → 块：标题/列表/表格/加粗逐类落地", () => {
  const blocks = htmlToBlocks(
    "<h1>一种装置</h1><p>普通段落</p><ol><li>第一项</li><li>第二项</li></ol><ul><li>要点</li></ul>" +
      "<table><thead><tr><th>部件</th><th>材质</th></tr></thead><tbody><tr><td>杯体</td><td>钢</td></tr></tbody></table>",
  );
  assert.equal(blocks[0]?.kind, "paragraph");
  assert.equal(blocks[0]?.kind === "paragraph" ? blocks[0].role : "", "title");
  assert.deepEqual(textOf(blocks[1]), ["普通段落"]);
  // 列表项必须同时带上序号与正文（回归：`<li>` 的裸文本曾被整体丢弃）
  assert.deepEqual(textOf(blocks[2]), ["1. ", "第一项"]);
  assert.equal(blocks[2]?.kind === "paragraph" ? blocks[2].indentLevel : -1, 1);
  assert.deepEqual(textOf(blocks[3]), ["2. ", "第二项"]);
  assert.deepEqual(textOf(blocks[4]), ["• ", "要点"]);
  const table = blocks[5];
  assert.equal(table?.kind, "table");
  assert.equal(table?.kind === "table" ? table.headerRows : -1, 1);
  assert.equal(table?.kind === "table" ? table.rows.length : -1, 2);
  assert.deepEqual(table?.kind === "table" ? textOf(table.rows[0]?.[0]?.blocks[0]) : [], ["部件"]);
});

test("无标签纯文本按换行拆段（LLM 常见输入形态）", () => {
  const blocks = htmlToBlocks("第一段\n\n第二段\n第三段");
  assert.equal(blocks.length, 3);
  assert.deepEqual(
    blocks.map(block => (block.kind === "paragraph" && block.runs[0]?.kind === "text" ? block.runs[0].text : "")),
    ["第一段", "第二段", "第三段"],
  );
  // 含 `<` 但非标签的文本不应被当成 HTML
  const literal = htmlToBlocks("a < b 且 c < d");
  assert.equal(literal.length, 1);
});

test("汉字之间不因源 HTML 折行而插入空格", () => {
  const blocks = htmlToBlocks("<p>本发明公开了\n一种保温杯，\n其特征在于</p>");
  const text = blocks[0]?.kind === "paragraph" && blocks[0].runs[0]?.kind === "text" ? blocks[0].runs[0].text : "";
  assert.equal(text, "本发明公开了一种保温杯，其特征在于");
});

test("<br> 拆成两个段落；<strong>/<em>/<u> 只加格式", () => {
  const blocks = htmlToBlocks("<p>甲<br>乙<strong>粗</strong><em>斜</em><u>下划</u></p>");
  assert.equal(blocks.length, 2);
  const first = blocks[0];
  assert.equal(first?.kind === "paragraph" ? first.runs[0]?.kind === "text" && first.runs[0].text : "", "甲");
  const runs = blocks[1]?.kind === "paragraph" ? blocks[1].runs : [];
  assert.deepEqual(
    runs.map(run =>
      run.kind === "text" ? [run.text, run.bold ?? false, run.italic ?? false, run.underline ?? false] : ["img"],
    ),
    [
      ["乙", false, false, false],
      ["粗", true, false, false],
      ["斜", false, true, false],
      ["下划", false, false, true],
    ],
  );
});

test("图片头嗅探覆盖 PNG/JPEG/GIF/BMP，未知格式返回 undefined", () => {
  const png = probeImage(new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64")));
  assert.deepEqual(png, { ext: "png", contentType: "image/png", widthPx: 2, heightPx: 2 });

  const gif = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.from([0x40, 0x01, 0xf0, 0x00, 0x00, 0x00, 0x00])]);
  assert.deepEqual(probeImage(new Uint8Array(gif)), {
    ext: "gif",
    contentType: "image/gif",
    widthPx: 0x0140,
    heightPx: 0x00f0,
  });

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x00, 0x00]);
  assert.deepEqual(probeImage(new Uint8Array(jpeg)), {
    ext: "jpg",
    contentType: "image/jpeg",
    widthPx: 0x0190,
    heightPx: 0x012c,
  });

  const bmp = Buffer.alloc(32);
  bmp.write("BM", 0, "ascii");
  bmp.writeUInt32LE(0x0064, 18);
  bmp.writeUInt32LE(0x0032, 22);
  assert.deepEqual(probeImage(new Uint8Array(bmp)), {
    ext: "bmp",
    contentType: "image/bmp",
    widthPx: 100,
    heightPx: 50,
  });

  assert.equal(probeImage(new Uint8Array(Buffer.from("not an image"))), undefined);
  assert.equal(probeImage(new Uint8Array()), undefined);
});

test("图片按版面等比缩放（只缩不放，边界不为零）", () => {
  const maxW = 8306 * 635;
  const maxH = (16838 - 1440 * 2) * 635;
  const small = fitImage(2, 2, maxW, maxH);
  assert.deepEqual(small, { widthEmu: 2 * 9525, heightEmu: 2 * 9525 });

  // 等比只断言「贴合边界 + 比例正确」（EMU 取整方式不是行为契约）。
  const wide = fitImage(4000, 3000, maxW, maxH);
  assert.equal(wide.widthEmu, maxW);
  assert.ok(Math.abs(wide.heightEmu - maxW * (3000 / 4000)) <= 2, `宽图应等比: ${wide.heightEmu}`);

  const tall = fitImage(300, 6000, maxW, maxH);
  assert.equal(tall.heightEmu, maxH);
  assert.ok(Math.abs(tall.widthEmu - maxH * (300 / 6000)) <= 2, `高图应等比: ${tall.widthEmu}`);

  // 版面为零的退化输入不得产出零尺寸 extent
  assert.deepEqual(fitImage(1, 1, 0, 0), { widthEmu: 1, heightEmu: 1 });
});

// ---------------------------------------------------------------- 端到端层

async function renderSmoke(
  dir: string,
  sections: Record<string, string>,
): Promise<{ docxPath: string; warnings: string[] }> {
  const result = await renderPatentDocument(
    {
      template: "claims-spec",
      outputName: "app",
      outputDir: dir,
      format: "docx",
      sections,
    },
    process.cwd(),
  );
  assert.equal(result.docxError, undefined, `docx 生成失败: ${result.docxError ?? ""}`);
  assert.ok(result.docxPath !== undefined, "未返回 docxPath");
  return { docxPath: result.docxPath, warnings: result.warnings ?? [] };
}

test("端到端：五件内容各落各节，母版版面逐条不变，包内 XML 良构", async () => {
  const dir = makeTempDir();
  try {
    const figure = writeTinyPng(dir);
    const { docxPath } = await renderSmoke(dir, {
      abstract: "<p>本发明公开一种智能保温杯，其特征在于所述杯体为双层。</p>",
      "abstract-figure": `<p><img src="${figure}" alt="摘要附图" /></p>`,
      claims: "<ol><li>一种智能保温杯，包括杯体；</li><li>根据权利要求1所述的智能保温杯。</li></ol>",
      specification: "<h1>一种智能保温杯</h1><p>技术领域本发明涉及日用品领域。</p>",
      drawings: `<p><img src="${figure}" alt="说明书附图" /></p>`,
    });

    const zip = await readPackage(docxPath);
    const documentXml = await readPart(zip, "word/document.xml");
    const relsXml = await readPart(zip, "word/_rels/document.xml.rels");
    const contentTypesXml = await readPart(zip, "[Content_Types].xml");

    // 包内 XML 全部良构 + 文本节点无裸尖括号
    assertWellFormedXml(documentXml, "document.xml");
    assertWellFormedXml(relsXml, "document.xml.rels");
    assertWellFormedXml(contentTypesXml, "[Content_Types].xml");
    assertNoRawMarkupInText(documentXml, "document.xml");

    // w:body 唯一（回归：前缀与重建体不得各带一个）
    assert.equal((documentXml.match(/<w:body>/g) ?? []).length, 1);
    assert.equal((documentXml.match(/<\/w:body>/g) ?? []).length, 1);

    // 段落属性元素顺序（回归：w:ind / w:jc 不得落在 w:rPr 之后）
    assert.equal((documentXml.match(/<\/w:rPr><w:ind\b/g) ?? []).length, 0, "w:ind 落在 w:rPr 之后");
    assert.equal((documentXml.match(/<\/w:rPr><w:jc\b/g) ?? []).length, 0, "w:jc 落在 w:rPr 之后");

    // 五个分节（含文末 body 级 sectPr）
    assert.equal((documentXml.match(/<w:sectPr\b/g) ?? []).length, 5);

    // 按件定位：内容必须落在正确的分节区间
    assert.equal(sectionOfText(documentXml, "本发明公开一种智能保温杯，其特征在于"), 0);
    assert.equal(sectionOfText(documentXml, "1. "), 2);
    assert.equal(sectionOfText(documentXml, "根据权利要求1所述的智能保温杯。"), 2);
    assert.equal(sectionOfText(documentXml, "技术领域本发明涉及日用品领域。"), 3);
    assert.equal(sectionOfText(documentXml, '<wp:docPr id="1"'), 1);
    assert.equal(sectionOfText(documentXml, '<wp:docPr id="2"'), 4);

    // 标题套用母版样式（styleId 由 outlineLvl 派生，见契约层用例）
    assert.match(documentXml, /<w:pStyle w:val="2"\/>/);
    // 标题必须清掉继承来的首行缩进
    const titleProps = /<w:pPr><w:pStyle w:val="2"\/>([\s\S]*?)<\/w:pPr>/.exec(documentXml)?.[1] ?? "";
    assert.match(titleProps, /<w:ind w:firstLine="0"/);

    // 列表序号与缩进
    assert.match(documentXml, /<w:ind w:left="420" w:firstLine="0" w:firstLineChars="0"\/>/);

    // 版面不变：与母版逐条相同
    const templatePath = resolveTemplateDocxPath("claims-spec");
    assert.ok(templatePath !== undefined);
    const templateZip = await readPackage(templatePath);
    assertLayoutPreserved(bodyInner(documentXml), bodyInner(await readPart(templateZip, "word/document.xml")));

    // 图片接线：media 文件 + 内容类型 + 关系 + blip 引用一致
    assert.ok(zip.file("word/media/image1.png") !== null, "缺少 media 文件");
    assert.match(contentTypesXml, /<Default Extension="png" ContentType="image\/png"\/>/);
    const imageRel = /<Relationship Id="(rId\d+)"[^>]*relationships\/image"[^>]*Target="media\/image1\.png"\/>/.exec(
      relsXml,
    );
    assert.ok(imageRel !== null, "缺少图片关系");
    assert.equal(
      (relsXml.match(new RegExp(`Id="${imageRel?.[1]}"`, "g")) ?? []).length,
      1,
      `新增的图片关系 id ${imageRel?.[1]} 与母版已有 rId 撞号`,
    );
    assert.match(documentXml, new RegExp(`<a:blip r:embed="${imageRel?.[1]}"/>`));
    assert.match(documentXml, /<wp:extent cx="19050" cy="19050"\/>/);
  } finally {
    cleanup(dir);
  }
});

test("表格渲染为 w:tbl，表头加粗，列宽铺满版面", async () => {
  const dir = makeTempDir();
  try {
    const { docxPath } = await renderSmoke(dir, {
      specification:
        "<table><thead><tr><th>部件</th><th>材质</th></tr></thead><tbody><tr><td>杯体</td><td>304 钢</td></tr></tbody></table>",
    });
    const zip = await readPackage(docxPath);
    const documentXml = await readPart(zip, "word/document.xml");
    assertWellFormedXml(documentXml, "document.xml");
    assert.match(documentXml, /<w:tbl><w:tblPr>/);
    assert.match(documentXml, /<w:tblBorders>/);
    assert.match(documentXml, /<w:gridCol w:w="4153"\/><w:gridCol w:w="4153"\/>/, "两列应各占版面宽度一半");
    assert.match(documentXml, /<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">部件<\/w:t>/, "表头单元应加粗");
    assert.equal(sectionOfText(documentXml, "304 钢"), 3);
  } finally {
    cleanup(dir);
  }
});

test("文本转义：HTML 实体被还原、非法控制字符被剔除，XML 不被破坏", async () => {
  const dir = makeTempDir();
  try {
    const { docxPath } = await renderSmoke(dir, {
      claims: "<p>A &amp; B &lt;c&gt;\u0007\u001f &quot;d&quot; 结束</p>",
    });
    const zip = await readPackage(docxPath);
    const documentXml = await readPart(zip, "word/document.xml");
    assertWellFormedXml(documentXml, "document.xml");
    assertNoRawMarkupInText(documentXml, "document.xml");
    // 实体还原后按 XML 规则重新转义（引号在文本节点内无需转义）
    assert.match(documentXml, /<w:t xml:space="preserve">A &amp; B &lt;c&gt; "d" 结束<\/w:t>/);
    // XML 1.0 不允许的控制字符必须被剔除，否则 Word 会拒绝打开整份文档
    assert.doesNotMatch(documentXml, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  } finally {
    cleanup(dir);
  }
});

test("图片不可读时告警但不失败，且不产生 media/关系残留", async () => {
  const dir = makeTempDir();
  try {
    const { docxPath, warnings } = await renderSmoke(dir, {
      "abstract-figure": '<p><img src="./nope/missing.png" /><img src="https://example.com/a.png" /></p>',
    });
    const zip = await readPackage(docxPath);
    const relsXml = await readPart(zip, "word/_rels/document.xml.rels");
    const contentTypesXml = await readPart(zip, "[Content_Types].xml");
    assert.equal(Object.keys(zip.files).filter(name => name.startsWith("word/media/")).length, 0);
    assert.doesNotMatch(relsXml, /relationships\/image/);
    assert.doesNotMatch(contentTypesXml, /Extension="png"/);
    assert.equal(warnings.filter(w => /图片未能嵌入/.test(w)).length, 2);
  } finally {
    cleanup(dir);
  }
});

test("整包 media 编号不覆盖母版已有条目，且不产出目录条目", async () => {
  const dir = makeTempDir();
  try {
    const figure = writeTinyPng(dir);
    const { docxPath } = await renderSmoke(dir, { drawings: `<p><img src="${figure}" /></p>` });
    const zip = await readPackage(docxPath);
    assert.ok(zip.file("word/media/image1.png") !== null);
    assert.ok(zip.file("word/media/") === null, "不应产出目录条目");
    // 母版其余部件逐条仍在
    const templatePath = resolveTemplateDocxPath("claims-spec");
    assert.ok(templatePath !== undefined);
    const templateNames = Object.keys((await readPackage(templatePath)).files).filter(n => !n.endsWith("/"));
    for (const name of templateNames) {
      assert.ok(zip.file(name) !== null, `母版部件丢失: ${name}`);
    }
  } finally {
    cleanup(dir);
  }
});

test("format 不含 docx 时不产出 docx（默认 both 行为不变）", async () => {
  const dir = makeTempDir();
  try {
    const result = await renderPatentDocument(
      {
        template: "claims-spec",
        outputName: "no-docx",
        outputDir: dir,
        format: "both",
        sections: { claims: "<p>甲</p>" },
      },
      process.cwd(),
    );
    assert.equal(result.docxPath, undefined);
    assert.equal(result.docxError, undefined);
    assert.equal(existsSync(join(dir, "no-docx.docx")), false);
  } finally {
    cleanup(dir);
  }
});

test("模板无 docx 母版却要求 docx 时 fail-closed（不落任何产物）", async () => {
  const dir = makeTempDir();
  try {
    await assert.rejects(
      renderPatentDocument(
        {
          template: "oa-response",
          outputName: "nope",
          outputDir: dir,
          format: "docx",
          sections: { abstract: "<p>甲</p>" },
        },
        process.cwd(),
      ),
      (err: unknown) => {
        assert.ok(err instanceof SatiDocumentInputError, "应抛 SatiDocumentInputError");
        assert.match((err as Error).message, /未提供 docx 母版/);
        assert.match((err as Error).message, /claims-spec/, "错误信息应给出可用模板");
        return true;
      },
    );
    // 早于任何落盘：连 HTML 都不应产出
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    cleanup(dir);
  }
});

test("format=all 同时产出 PDF（若有 Chrome）与 docx", async () => {
  const dir = makeTempDir();
  try {
    const result = await renderPatentDocument(
      {
        template: "claims-spec",
        outputName: "all-out",
        outputDir: dir,
        format: "all",
        sections: { abstract: "<p>摘要内容</p>", claims: "<p>1. 一种装置。</p>" },
      },
      process.cwd(),
    );
    assert.ok(result.docxPath !== undefined, `docx 未生成: ${result.docxError ?? ""}`);
    assert.ok(existsSync(result.docxPath));
    assert.ok(existsSync(result.htmlPath));
    // PDF 依赖本机 Chrome，缺失时是如实降级而非失败
    if (result.pdfPath === undefined) assert.ok(typeof result.pdfError === "string");
  } finally {
    cleanup(dir);
  }
});
