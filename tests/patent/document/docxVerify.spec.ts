/**
 * 申请文件 docx **成品核验**判据（写完读回来对一遍）。
 *
 * 判据分两层：
 * ① 纯函数层（`verifyApplicationDocxPackage`）——喂包内 XML 文本，直接测判据本身；
 * ② 端到端层（`renderPatentDocument(format:"docx")` → 读回落盘产物）——测接线与降级语义。
 *
 * 本文件同时是三条**移植陷阱**的回归防线（见 `verifyApplicationDocx.ts` 文件头）：
 * 正文缩进来自模板派生而非显式写入、`w:color="auto"` 合规、成品不做自动段落编号。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import {
  renderPatentDocument,
  resolveTemplateDocxPath,
  verifyApplicationDocx,
  verifyApplicationDocxPackage,
} from "../../../src/patent/document/index.js";

/** 2×2 真实 PNG（合法图片，可被 Word 打开）。 */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DAwMDAxMDAwMAAAAwBAQDJ/pLvAAAAAElFTkSuQmCC";

const CLAIMS =
  "<h1>权利要求书</h1><p>1. 一种装置，其特征在于，包括壳体。</p><p>2. 根据权利要求 1 所述的装置，其特征在于，所述壳体为金属。</p>";
const SPEC = "<h1>说明书</h1><p>技术领域</p><p>本发明涉及一种装置。</p>";
const ABSTRACT = "<p>本发明公开了一种装置，包括壳体。</p>";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-docxverify-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function writeTinyPng(dir: string, name = "fig.png"): void {
  writeFileSync(join(dir, name), Buffer.from(TINY_PNG_BASE64, "base64"));
}

/** 渲染一份申请文件 docx，返回路径与渲染结果。 */
async function renderFiling(
  dir: string,
  sections: Record<string, string>,
  outputName = "filing",
): Promise<{ docxPath: string; result: Awaited<ReturnType<typeof renderPatentDocument>> }> {
  const result = await renderPatentDocument(
    { template: "claims-spec", outputName, outputDir: dir, format: "docx", sections },
    dir,
  );
  assert.ok(result.docxPath !== undefined, `docx 未生成：${result.docxError ?? "(无原因)"}`);
  return { docxPath: result.docxPath, result };
}

/** 改写 docx 包内某个组成，落回新文件（用于构造「成品被改坏」的反例）。 */
async function rewritePackage(docxPath: string, target: string, transform: (xml: string) => string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(docxPath));
  const xml = await zip.file(target)?.async("string");
  assert.ok(xml !== undefined, `包内缺少 ${target}`);
  zip.file(target, transform(xml));
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const out = `${docxPath}.mutated.docx`;
  writeFileSync(out, buffer);
  return out;
}

/** 造一份最小 document.xml（纯函数层用，避免为了测判据先造真包）。 */
function minimalDocument(bodyInner: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${bodyInner}<w:sectPr/></w:body></w:document>`
  );
}

// ---------------------------------------------------------------- 纯函数层

test("run 级颜色：w:color=auto 与 000000 合规，彩色才报", () => {
  const autod = verifyApplicationDocxPackage({
    documentXml: minimalDocument(
      '<w:p><w:pPr><w:ind w:firstLine="0"/></w:pPr><w:r><w:rPr><w:color w:val="auto"/></w:rPr><w:t>文本</w:t></w:r></w:p>',
    ),
    relationshipsXml: "",
    readPart: () => undefined,
  });
  assert.ok(
    !autod.findings.some(finding => finding.id === "no-run-color"),
    "母版自带 w:color=auto 被误判为「非黑色文字」（照搬 dsh 的 != 000000 判据就会这样）",
  );

  const hexd = verifyApplicationDocxPackage({
    documentXml: minimalDocument(
      '<w:p><w:pPr><w:ind w:firstLine="0"/></w:pPr><w:r><w:rPr><w:color w:val="000000"/></w:rPr><w:t>文本</w:t></w:r></w:p>',
    ),
    relationshipsXml: "",
    readPart: () => undefined,
  });
  assert.ok(!hexd.findings.some(finding => finding.id === "no-run-color"), "000000 是黑色，不得报");

  const colored = verifyApplicationDocxPackage({
    documentXml: minimalDocument(
      '<w:p><w:pPr><w:ind w:firstLine="0"/></w:pPr><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>文本</w:t></w:r></w:p>',
    ),
    relationshipsXml: "",
    readPart: () => undefined,
  });
  assert.ok(colored.findings.some(finding => finding.id === "no-run-color" && finding.severity === "warn"));
});

test("段落标记的 w:rPr（位于 w:pPr 内）不计入 run 级颜色", () => {
  const out = verifyApplicationDocxPackage({
    documentXml: minimalDocument(
      '<w:p><w:pPr><w:ind w:firstLine="0"/><w:rPr><w:color w:val="7F7F7F"/></w:rPr></w:pPr><w:r><w:t>文本</w:t></w:r></w:p>',
    ),
    relationshipsXml: "",
    readPart: () => undefined,
  });
  assert.ok(!out.findings.some(finding => finding.id === "no-run-color"));
});

test("首行缩进：正文段偏离母版派生值即 fail；图片段/标题段要求零", () => {
  const drifted = verifyApplicationDocxPackage({
    documentXml: minimalDocument(
      '<w:p><w:pPr><w:ind w:firstLine="560" w:firstLineChars="200"/></w:pPr><w:r><w:t>正文</w:t></w:r></w:p>',
    ),
    relationshipsXml: "",
    readPart: () => undefined,
    expected: {
      parts: {},
      template: {
        documentXml: minimalDocument(
          '<w:p><w:pPr><w:ind w:firstLine="0" w:firstLineChars="0"/></w:pPr><w:t></w:t></w:p>',
        ),
        relationshipsXml: "",
        readPart: () => undefined,
      },
    },
  });
  assert.ok(drifted.findings.some(finding => finding.id === "first-line-indent" && finding.severity === "fail"));

  const imageIndented = verifyApplicationDocxPackage({
    documentXml: minimalDocument('<w:p><w:pPr><w:ind w:firstLine="560"/></w:pPr><w:r><w:drawing/></w:r></w:p>'),
    relationshipsXml: "",
    readPart: () => undefined,
  });
  assert.ok(imageIndented.findings.some(finding => finding.id === "first-line-indent" && finding.severity === "fail"));

  // 标题段（带 w:pStyle）同样要求显式零缩进：渲染器写死 0，被改动即版面右移。
  const titleIndented = verifyApplicationDocxPackage({
    documentXml: minimalDocument(
      '<w:p><w:pPr><w:pStyle w:val="2"/><w:ind w:firstLine="560"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>',
    ),
    relationshipsXml: "",
    readPart: () => undefined,
  });
  assert.ok(titleIndented.findings.some(finding => finding.id === "first-line-indent" && finding.severity === "fail"));
});

test("痕迹词表未注入时显式标注未检查（降级不静默）", () => {
  const without = verifyApplicationDocxPackage({
    documentXml: minimalDocument('<w:p><w:pPr><w:ind w:firstLine="0"/></w:pPr><w:r><w:t>【待核】</w:t></w:r></w:p>'),
    relationshipsXml: "",
    readPart: () => undefined,
  });
  assert.equal(without.info.residueMarkersChecked, false);
  assert.ok(!without.findings.some(finding => finding.id === "residue-marker"));

  const withMarkers = verifyApplicationDocxPackage({
    documentXml: minimalDocument('<w:p><w:pPr><w:ind w:firstLine="0"/></w:pPr><w:r><w:t>【待核】</w:t></w:r></w:p>'),
    relationshipsXml: "",
    readPart: () => undefined,
    residueMarkers: ["【待核】"],
  });
  assert.equal(withMarkers.info.residueMarkersChecked, true);
  assert.ok(withMarkers.findings.some(finding => finding.id === "residue-marker" && finding.severity === "fail"));
});

// ---------------------------------------------------------------- 端到端层

test("五件齐备：核验通过，分节计数与母版对拍齐备", async () => {
  const dir = makeTempDir();
  try {
    writeTinyPng(dir);
    const { docxPath, result } = await renderFiling(dir, {
      abstract: ABSTRACT,
      "abstract-figure": '<p><img src="fig.png" alt="摘要附图"/></p>',
      claims: CLAIMS,
      specification: SPEC,
      drawings: '<p><img src="fig.png" alt="图1"/></p>',
    });

    assert.equal(result.docxError, undefined);
    const verification = result.docxVerification;
    assert.ok(verification !== undefined, "返回值里必须带核验结论");
    assert.equal(verification.passed, true, JSON.stringify(verification.findings));
    assert.equal(verification.info.template?.sections, verification.info.sections.length);

    const claims = verification.info.sections.find(section => section.part === "claims");
    assert.ok(claims !== undefined);
    assert.ok(claims.paragraphs >= 2, `权利要求书应落地多段，实测 ${claims.paragraphs}`);
    const drawings = verification.info.sections.find(section => section.part === "drawings");
    assert.ok(drawings !== undefined);
    assert.equal(drawings.figures, 1);
    // 母版自带 w:color=auto，不得误报（见文件头陷阱 2）。
    assert.ok(!verification.findings.some(finding => finding.id === "no-run-color"));

    // 读同一份产物再核一次，结论必须一致（确定性：无时间/随机依赖）。
    const again = await verifyApplicationDocx({
      docxPath,
      expected: {
        parts: { abstract: ABSTRACT, claims: CLAIMS, specification: SPEC },
        template: "claims-spec",
      },
    });
    assert.equal(again.passed, true);
  } finally {
    cleanup(dir);
  }
});

test("件内容只有图且图不可读：报 warn 不报 fail（守住「图片不可读不失败」契约）", async () => {
  const dir = makeTempDir();
  try {
    const { result } = await renderFiling(dir, {
      claims: CLAIMS,
      "abstract-figure": '<p><img src="missing.png" alt="摘要附图"/></p>',
    });
    // 渲染器已经用告警说明原因；核验层不得把「输入引用了不存在的图片」升级成「渲染失败」——
    // 那既与既有契约冲突，也把输入侧的问题算到了渲染头上。
    assert.ok(result.warnings?.some(warning => warning.includes("图片未能嵌入")));
    assert.equal(result.docxError, undefined);
    const verification = result.docxVerification;
    assert.ok(verification !== undefined);
    assert.equal(verification.passed, true, JSON.stringify(verification.findings));
    const notLanded = verification.findings.filter(finding => finding.id === "figures-not-landed");
    assert.equal(notLanded.length, 1, JSON.stringify(verification.findings));
    assert.equal(notLanded[0]?.severity, "warn");
    assert.ok(!verification.findings.some(finding => finding.id === "parts-nonempty"));
  } finally {
    cleanup(dir);
  }
});

test("漏给件内容：报告「该件无内容」但不阻断（内容缺失 ≠ 渲染缺陷）", async () => {
  const dir = makeTempDir();
  try {
    const { result } = await renderFiling(dir, { claims: CLAIMS, specification: SPEC });
    const verification = result.docxVerification;
    assert.ok(verification !== undefined);

    const absent = verification.findings.filter(finding => finding.id === "part-content-absent");
    assert.deepEqual(
      absent.map(finding => finding.evidence).sort(),
      ["part=abstract", "part=abstract-figure", "part=drawings"],
      "三个未提供的件都应被点名",
    );
    assert.ok(absent.every(finding => finding.severity === "warn"));
    assert.equal(verification.passed, true, "件缺失是输入侧事实，不应阻断交付");
    // 渲染器只在「五件全空」时告警；此处有内容，故渲染告警里没有这一条——核验是增量。
    assert.equal(result.docxError, undefined);
  } finally {
    cleanup(dir);
  }
});

test("件内容全空：只报一条「未提供任何件内容」，不刷五条", async () => {
  const dir = makeTempDir();
  try {
    const { result } = await renderFiling(dir, {});
    const verification = result.docxVerification;
    assert.ok(verification !== undefined);
    assert.equal(verification.findings.filter(finding => finding.id === "parts-none-provided").length, 1);
    assert.equal(verification.findings.filter(finding => finding.id === "part-content-absent").length, 0);
    assert.equal(verification.passed, true);
  } finally {
    cleanup(dir);
  }
});

test("内容传入但成品该节为空：parts-nonempty 判 fail（渲染丢失的红线）", async () => {
  // 用**空母版**当成品：分节结构与页眉都能匹配五件套，但没有任何内容。
  // 声明「权利要求书有内容」即触发「传了却没落地」——
  // 这是渲染器将来重构时最该被抓住的回归（正常路径下有 fail-closed 保护，故此处纯函数层构造）。
  const templatePath = resolveTemplateDocxPath("claims-spec");
  assert.ok(templatePath !== undefined);
  const zip = await JSZip.loadAsync(readFileSync(templatePath));
  const documentXml = await zip.file("word/document.xml")?.async("string");
  assert.ok(documentXml !== undefined);
  const relationshipsXml = (await zip.file("word/_rels/document.xml.rels")?.async("string")) ?? "";
  const headers = new Map<string, string>();
  for (const name of Object.keys(zip.files)) {
    if (!/^word\/header[^/]*\.xml$/.test(name)) continue;
    headers.set(name, (await zip.file(name)?.async("string")) ?? "");
  }

  const result = verifyApplicationDocxPackage({
    documentXml,
    relationshipsXml,
    readPart: (packagePath: string) => headers.get(packagePath),
    expected: { parts: { claims: CLAIMS } },
  });
  const findings = result.findings.filter(finding => finding.id === "parts-nonempty");
  assert.equal(findings.length, 1, JSON.stringify(result.findings));
  assert.equal(findings[0]?.severity, "fail");
  assert.equal(result.passed, false);
  // 其余未声明的件只是「无内容」提示，不阻断。
  assert.ok(
    result.findings
      .filter(finding => finding.id === "part-content-absent")
      .every(finding => finding.severity === "warn"),
  );
});

test("端到端：成品缩进被改坏 → first-line-indent 判 fail", async () => {
  const dir = makeTempDir();
  try {
    const { docxPath } = await renderFiling(dir, { claims: CLAIMS, specification: SPEC });
    // 全量替换：首次出现的 w:ind 落在分节收尾段（核验器按要求跳过），
    // 必须连内容段一起改才构得成反例。
    const mutated = await rewritePackage(docxPath, "word/document.xml", xml =>
      xml.replace(
        /<w:ind w:firstLine="0" w:firstLineChars="0"\/>/g,
        '<w:ind w:firstLine="560" w:firstLineChars="200"/>',
      ),
    );
    const drifted = await verifyApplicationDocx({
      docxPath: mutated,
      expected: { parts: { claims: CLAIMS, specification: SPEC }, template: "claims-spec" },
    });
    const indent = drifted.findings.filter(finding => finding.id === "first-line-indent");
    assert.ok(indent.length > 0, `缩进被改坏必须被抓住：${JSON.stringify(drifted.findings)}`);
    assert.equal(drifted.passed, false);
  } finally {
    cleanup(dir);
  }
});

test("成品少一节 / 页眉被改：体例断言判 fail", async () => {
  const dir = makeTempDir();
  try {
    const { docxPath } = await renderFiling(dir, { claims: CLAIMS, specification: SPEC });

    // 删掉一个内联 sectPr 的段落 → 成品分节数少于母版。
    const droppedSection = await rewritePackage(docxPath, "word/document.xml", xml =>
      xml.replace(
        /<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*?<w:sectPr\b[\s\S]*?<\/w:sectPr>(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/,
        "",
      ),
    );
    const countResult = await verifyApplicationDocx({
      docxPath: droppedSection,
      expected: { parts: {}, template: "claims-spec" },
    });
    assert.ok(
      countResult.findings.some(finding => finding.id === "section-count" && finding.severity === "fail"),
      JSON.stringify(countResult.findings),
    );

    // 改掉页眉文本 → 各节页眉与母版不一致。
    const zip = await JSZip.loadAsync(readFileSync(docxPath));
    const headerName = Object.keys(zip.files).find(name => /^word\/header[^/]*\.xml$/.test(name));
    assert.ok(headerName !== undefined, "母版应至少有一个页眉部件");
    const mutatedHeader = await rewritePackage(docxPath, headerName, xml => xml.replace("<w:t>", "<w:t>改"));
    const headerResult = await verifyApplicationDocx({
      docxPath: mutatedHeader,
      expected: { parts: {}, template: "claims-spec" },
    });
    assert.ok(
      headerResult.findings.some(finding => finding.id === "headers-unchanged" && finding.severity === "fail"),
      JSON.stringify(headerResult.findings),
    );
  } finally {
    cleanup(dir);
  }
});

test("核验器自身无法执行时抛错（由渲染路径转成「核验未能执行」，不静默当作通过）", async () => {
  await assert.rejects(() => verifyApplicationDocx({ docxPath: "/nonexistent/never.docx" }));
});
