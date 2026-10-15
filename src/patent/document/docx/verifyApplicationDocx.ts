/**
 * src/patent/document/docx — 申请文件 docx **成品核验**（写完读回来对一遍）。
 *
 * 与渲染器的分工：`renderApplicationDocx` 负责「写出」，本模块负责「读回并自证」——
 * 解开**已落盘**的包，按分节逐件核对内容是否真的落地、版面是否仍与母版一致。
 *
 * 三类断言（对齐 dsh `patent-filing/assets/engine/verify.py` 的分类，判据按 Sati 的渲染事实重写）：
 *
 * - **内容**：期望有内容的件在成品里必须真的有段落或图片（**这是本模块的立身之本**：
 *   渲染器只在「五件全空」时告警，单件为空是静默的——成品会少一整节，
 *   而分节数、页眉、页码全都照样正确）；
 * - **体例**：分节数 / 各节页眉 / 首行缩进是否仍与母版一致（母版换版时的回归防线）；
 * - **痕迹**：内部标记词——**词表由调用方注入**，本模块不自带第二张表
 *   （输出门禁已在拦同一批词，两张表必然漂移）。未注入时报告显式标注「未检查」。
 *
 * ⚠️ 三处与 dsh 判据**不同**的 Sati 事实（改动前请先读，这三条都是踩过的）：
 *
 * 1. **首行缩进不是显式写入的**：`ooxml.ts` 的设计是「样式全部来自模板」，正文段与图片段
 *    直接复用母版派生的 `w:pPr`（`deriveBodyParagraphProps`）。母版的正文段落
 *    `w:pPr` 自带 `<w:ind w:firstLine="0" w:firstLineChars="0"/>`，故成品段落**继承**到零缩进。
 *    → 本模块核**结果**（段落实际的 `w:firstLine`），不核「是否显式写」。
 * 2. **`w:color w:val="auto"` 合规**：母版段落标记的 `rPr` 里带 `w:color w:val="auto"`。
 *    dsh 的判据是 `!= "000000"` 即视为非黑——照搬会把**正常成品全部误报**。
 *    `auto` 是「自动（黑）」，与 `000000` 同等合规。
 * 3. **成品不做自动段落编号**：`htmlToOoxml` 没有 `[NNNN]` 机制，编号只能由调用方写进内容。
 *    → 不默认开「编号连续性」断言（与 dsh「按 spec 声明生效」同构，但 Sati 侧无人声明）。
 *
 * 核验的**能力边界**：期望值来自**调用方传来的件内容**，故本模块证明的是
 * 「写出的东西没丢、版面没漂」，**不证明「内容本身是对的」**——后者要靠规则门 / LLM 判据。
 * 它是同模块内的机械读回，不构成独立第三方验收。
 */

import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { SatiDocumentInputError } from "../errors.js";
import { resolveTemplateDocxPath } from "../templateResolver.js";
import type { DocumentTemplateId } from "../types.js";
import {
  APPLICATION_PARTS,
  deriveBodyParagraphProps,
  extractSectionProperties,
  extractText,
  paragraphPropertiesXml,
  parseTemplateSections,
  planSections,
  splitDocumentBody,
  topLevelElements,
} from "./applicationTemplate.js";
import { htmlToBlocks } from "./htmlToOoxml.js";
import type { ParsedBlock } from "./ooxml.js";

/** 一条核验发现。 */
export type DocxVerifyFinding = {
  /** 稳定断言 id（回归测试与报告引用它，不要改已发布的 id）。 */
  id: string;
  /** `fail` = 成品不得定稿；`warn` = 报告但不阻断。 */
  severity: "fail" | "warn";
  /** 人读一句话（含实测值）。 */
  message: string;
  /** 机械证据（段落文本片段 / 分节标题 / 实测值）。 */
  evidence?: string;
};

/** 单个分节的实测内容分布。 */
export type DocxVerifySectionInfo = {
  /** 对应五件套的件 id；不属于五件套的分节为 `null`（模板额外分节，内容原样保留）。 */
  part: string | null;
  /** 该节的页眉标题（模板未提供可读页眉时为空串）。 */
  headerTitle: string;
  /** 非空文本段落数（含图片的段落计在 `figures`）。 */
  paragraphs: number;
  /** 内联图片数。 */
  figures: number;
  /** 表格数。 */
  tables: number;
};

/** 核验实测摘要（供报告与测试断言）。 */
export type DocxVerifyInfo = {
  sections: DocxVerifySectionInfo[];
  headers: string[];
  /** 与母版对拍的结果；未提供母版时为 `null`。 */
  template: DocxVerifyTemplateInfo | null;
  /** 痕迹词表是否真的被检查过（未注入词表时为 false——降级不静默）。 */
  residueMarkersChecked: boolean;
};

/** 母版对拍结果：分节数与正文段首行缩进。 */
export type DocxVerifyTemplateInfo = {
  sections: number;
  bodyFirstLine: string | null;
};

export type DocxVerifyResult = {
  /** 无 `fail` 级发现即通过。 */
  passed: boolean;
  findings: DocxVerifyFinding[];
  info: DocxVerifyInfo;
};

/** 一个已解析 docx 包的必要组成（成品包与母版包共用此形状）。 */
export type DocxPackageReference = {
  documentXml: string;
  relationshipsXml: string;
  readPart: (packagePath: string) => string | undefined;
};

export type VerifyApplicationDocxPackageInput = {
  documentXml: string;
  relationshipsXml: string;
  readPart: (packagePath: string) => string | undefined;
  /** 期望值；省略即只做体例核验（回读外部产物的场景）。 */
  expected?: {
    parts: Readonly<Record<string, string | undefined>>;
    template?: DocxPackageReference;
  };
  /** 内部标记词表；不传即不检查（报告里会显式标注）。 */
  residueMarkers?: readonly string[];
};

/** 顶层元素的内容统计（与 dsh 的 `section_layout` 同口径：有图计图，否则文本非空计段）。 */
type ElementStat = { paragraphs: number; figures: number; tables: number };

function statElement(elementXml: string): ElementStat {
  if (elementXml.startsWith("<w:tbl")) return { paragraphs: 0, figures: 0, tables: 1 };
  const figures = (elementXml.match(/<w:drawing\b/g) ?? []).length;
  if (figures > 0) return { paragraphs: 0, figures, tables: 0 };
  return { paragraphs: extractText(elementXml) === "" ? 0 : 1, figures: 0, tables: 0 };
}

/** 从 `w:pPr` 内层 XML 取首行缩进值（twip 字符串）；无 `w:ind@w:firstLine` 时 `null`（继承样式）。 */
function firstLineFromPPr(pPrXml: string | undefined): string | null {
  if (pPrXml === undefined) return null;
  return /<w:ind\b[^>]*\bw:firstLine="(-?\d+)"/.exec(pPrXml)?.[1] ?? null;
}

/** 从段落 XML 取首行缩进值。 */
function firstLineIndentOf(paragraphXml: string): string | null {
  return firstLineFromPPr(paragraphPropertiesXml(paragraphXml));
}

/** 段落是否为标题段（带 `w:pStyle`）。 */
function isTitleParagraph(paragraphXml: string): boolean {
  return /<w:pStyle\b/.test(paragraphPropertiesXml(paragraphXml) ?? "");
}

/** 段落是否含内联图片。 */
function hasDrawing(paragraphXml: string): boolean {
  return /<w:drawing\b/.test(paragraphXml);
}

/**
 * 收集 run 级非黑色文字（`auto` 与 `000000` 均视为合规，见文件头 ⚠️ 第 2 条）。
 * 只查 run 自身的 `w:rPr`，不追样式继承——继承色来自母版样式，不是内容注入引入的。
 */
function nonBlackRunColors(bodyXml: string): string[] {
  const found: string[] = [];
  for (const run of bodyXml.match(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g) ?? []) {
    const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1];
    if (rPr === undefined) continue;
    const color = /<w:color\b[^>]*w:val="([^"]+)"/.exec(rPr)?.[1];
    if (color === undefined || color === "auto" || color === "000000") continue;
    found.push(color);
  }
  return found;
}

/** 按顶层元素统计一节的内容分布。 */
function statSection(contentXml: string): ElementStat {
  const stat: ElementStat = { paragraphs: 0, figures: 0, tables: 0 };
  for (const element of topLevelElements(contentXml)) {
    const one = statElement(element);
    stat.paragraphs += one.paragraphs;
    stat.figures += one.figures;
    stat.tables += one.tables;
  }
  return stat;
}

/** 内容是否落地（段 / 图 / 表任一非零）。 */
function hasContent(stat: ElementStat): boolean {
  return stat.paragraphs + stat.figures + stat.tables > 0;
}

/** 件内容（HTML 或纯文本）的机械统计——只关心「是否有文本」与图片张数。 */
type ExpectedContentStat = { hasText: boolean; images: number };

/** 递归统计块结构里的文本与图片（复用渲染器的 HTML 解析器，与渲染同源）。 */
function statBlocks(blocks: readonly ParsedBlock[], into: ExpectedContentStat): void {
  for (const block of blocks) {
    if (block.kind === "table") {
      for (const row of block.rows) {
        for (const cell of row) statBlocks(cell.blocks, into);
      }
      continue;
    }
    for (const run of block.runs) {
      if (run.kind === "text") {
        if (run.text.trim() !== "") into.hasText = true;
      } else {
        into.images += 1;
      }
    }
  }
}

function expectedContentStat(html: string): ExpectedContentStat {
  const stat: ExpectedContentStat = { hasText: false, images: 0 };
  if (html.trim() === "") return stat;
  statBlocks(htmlToBlocks(html), stat);
  return stat;
}

/** 件内容是否提供了实质内容（有文本或图片即算）。 */
function hasProvidedContent(stat: ExpectedContentStat): boolean {
  return stat.hasText || stat.images > 0;
}

/**
 * 核验一个已落盘的申请文件包（纯函数：输入是包内 XML 文本与读取器，不碰文件系统）。
 *
 * 拆成纯函数是为了让判据可单测（不必先造出一份真 docx），也为了让渲染路径
 * 可以直接传**内存里刚写出的** XML——但 `verifyApplicationDocx` 走读盘，
 * 以核验「落盘产物本身」。
 */
export function verifyApplicationDocxPackage(input: VerifyApplicationDocxPackageInput): DocxVerifyResult {
  const findings: DocxVerifyFinding[] = [];
  const { elements } = splitDocumentBody(input.documentXml);
  const bodyXml = elements.join("");

  const sections = parseTemplateSections(input.documentXml, input.relationshipsXml, input.readPart);
  const plan = planSections(sections);
  const sectionInfos: DocxVerifySectionInfo[] = plan.entries.map(entry => ({
    part: entry.part?.id ?? null,
    headerTitle: entry.section.headerTitle,
    ...statSection(entry.section.contentXml),
  }));

  // ---- 内容：期望有内容的件必须真的落地
  //
  // 「文本丢失」与「图片未落地」分开判，因为两者的可归责性不同：
  // 文本是渲染器自己搬的，丢了就是渲染缺陷（fail）；图片要读外部文件，
  // 读不到时渲染器已经在 warnings 里说明原因（warn）——核验层不该把
  // 「输入引用了不存在的图片」升级成「渲染失败」（既有的「图片不可读时告警但不失败」契约）。
  const expectedParts = input.expected?.parts;
  if (expectedParts !== undefined) {
    // 件与期望值一并带上，后面只遍历这一次（不必再按 id 查表）。
    const expectedStats = APPLICATION_PARTS.map(part => ({
      part,
      stat: expectedContentStat(expectedParts[part.id] ?? ""),
    }));
    const providedCount = expectedStats.filter(entry => hasProvidedContent(entry.stat)).length;
    if (providedCount === 0) {
      findings.push({
        id: "parts-none-provided",
        severity: "warn",
        message: `调用方未提供任何件内容（可用键: ${APPLICATION_PARTS.map(p => p.id).join(" / ")}），无可核验的内容侧断言`,
      });
    }
    for (const { part, stat } of expectedStats) {
      const info = sectionInfos.find(section => section.part === part.id);
      if (info === undefined) {
        // 母版缺件时渲染器已经 fail-closed，走到这里说明包结构异常。
        findings.push({
          id: "part-section-missing",
          severity: "fail",
          message: `成品里找不到「${part.label}」分节（母版按页眉标题匹配失败）`,
        });
        continue;
      }
      if (hasProvidedContent(stat)) {
        // 表格里的文字也算落地（件内容可能是表格形态）。
        if (stat.hasText && info.paragraphs + info.tables === 0) {
          findings.push({
            id: "parts-nonempty",
            severity: "fail",
            message: `「${part.label}」的文本未落地（段落 0，表格 0）——内容在渲染中丢失`,
            evidence: `part=${part.id}`,
          });
        }
        if (stat.images > 0 && info.figures === 0) {
          findings.push({
            id: "figures-not-landed",
            severity: "warn",
            message: `「${part.label}」声明 ${stat.images} 张图，成品该节 0 张——通常是图片不可读被跳过（渲染告警里已给出原因）`,
            evidence: `part=${part.id}`,
          });
        }
      } else if (!hasContent(info) && providedCount > 0) {
        findings.push({
          id: "part-content-absent",
          severity: "warn",
          message: `「${part.label}」无内容（调用方未提供）——成品会少这一件`,
          evidence: `part=${part.id}`,
        });
      }
    }
  }

  // ---- 体例：分节数 / 各节页眉 / 首行缩进
  const templateRef = input.expected?.template;
  let templateInfo: DocxVerifyInfo["template"] = null;
  let templateBodyFirstLine: string | null = null;
  if (templateRef !== undefined) {
    const templateSections = parseTemplateSections(
      templateRef.documentXml,
      templateRef.relationshipsXml,
      templateRef.readPart,
    );
    templateBodyFirstLine = firstLineFromPPr(deriveBodyParagraphProps(templateRef.documentXml));
    templateInfo = { sections: templateSections.length, bodyFirstLine: templateBodyFirstLine };

    if (sections.length !== templateSections.length) {
      findings.push({
        id: "section-count",
        severity: "fail",
        message: `分节数 ${sections.length} ≠ 母版 ${templateSections.length}（版面已漂移）`,
      });
    }
    const templateHeaders = templateSections.map(section => section.headerTitle);
    const actualHeaders = sections.map(section => section.headerTitle);
    if (actualHeaders.join("\u0000") !== templateHeaders.join("\u0000")) {
      findings.push({
        id: "headers-unchanged",
        severity: "fail",
        message: `各节页眉与母版不一致：成品 ${JSON.stringify(actualHeaders)} ≠ 母版 ${JSON.stringify(templateHeaders)}`,
      });
    }
  }

  // 首行缩进：图片段与标题段期望显式零（渲染器各自写死），正文段期望母版派生值。
  let indentUnresolved = 0;
  for (const element of elements) {
    if (!element.startsWith("<w:p")) continue;
    if (extractSectionProperties(element) !== undefined) continue; // 分节收尾段（不含内容）
    if (extractText(element) === "" && !hasDrawing(element)) continue; // 空段不载内容，缩进无意义
    const actual = firstLineIndentOf(element);
    if (actual === null) {
      indentUnresolved += 1;
      continue;
    }
    const isImage = hasDrawing(element);
    const isTitle = isTitleParagraph(element);
    if (isImage || isTitle) {
      if (actual !== "0") {
        findings.push({
          id: "first-line-indent",
          severity: "fail",
          message: `${isImage ? "图片段" : "标题段"}首行缩进 ${actual} ≠ 0（居中/标题内容会被整体右移）`,
          evidence: extractText(element).slice(0, 24),
        });
      }
      continue;
    }
    if (templateBodyFirstLine !== null && actual !== templateBodyFirstLine) {
      findings.push({
        id: "first-line-indent",
        severity: "fail",
        message: `正文段首行缩进 ${actual} ≠ 母版派生值 ${templateBodyFirstLine}`,
        evidence: extractText(element).slice(0, 24),
      });
    }
  }
  if (indentUnresolved > 0) {
    findings.push({
      id: "first-line-indent-unresolved",
      severity: "warn",
      message: `${indentUnresolved} 个段落未携带 w:ind@w:firstLine（缩进由样式继承，本次未能核验）`,
    });
  }

  // ---- 体例：run 级非黑色文字（auto 与 000000 合规）
  const colors = nonBlackRunColors(bodyXml);
  if (colors.length > 0) {
    const unique = [...new Set(colors)];
    findings.push({
      id: "no-run-color",
      severity: "warn",
      message: `成品含 ${colors.length} 处非黑色文字（颜色 ${unique.join(" / ")}）——若来自内容注入，公文体例通常不接受`,
    });
  }

  // ---- 痕迹：词表由调用方注入，未注入即显式标注未检查
  const markers = input.residueMarkers ?? [];
  if (markers.length > 0) {
    const bodyText = extractText(bodyXml);
    for (const marker of markers) {
      if (marker !== "" && bodyText.includes(marker)) {
        findings.push({
          id: "residue-marker",
          severity: "fail",
          message: `成品含内部标记「${marker}」——定稿前必须清除`,
        });
      }
    }
  }

  return {
    passed: !findings.some(finding => finding.severity === "fail"),
    findings,
    info: {
      sections: sectionInfos,
      headers: sections.map(section => section.headerTitle),
      template: templateInfo,
      residueMarkersChecked: markers.length > 0,
    },
  };
}

/** 从 zip 里读出全部页眉 XML（`parseTemplateSections` 的读取器要求同步，故先全读进来）。 */
async function readHeaderParts(zip: JSZip): Promise<Map<string, string>> {
  const parts = new Map<string, string>();
  for (const name of Object.keys(zip.files)) {
    if (!/^word\/header[^/]*\.xml$/.test(name)) continue;
    const file = zip.file(name);
    if (file !== null) parts.set(name, await file.async("string"));
  }
  return parts;
}

/** 读一个包的必要组成，返回可直接喂给纯函数的引用。 */
async function loadPackage(zip: JSZip): Promise<DocxPackageReference> {
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (documentXml === undefined) throw new SatiDocumentInputError("docx 缺少 word/document.xml");
  const relationshipsXml = (await zip.file("word/_rels/document.xml.rels")?.async("string")) ?? "";
  const headerParts = await readHeaderParts(zip);
  return {
    documentXml,
    relationshipsXml,
    readPart: (packagePath: string) => headerParts.get(packagePath),
  };
}

/**
 * 核验**已落盘**的申请文件 docx（读盘 → 解包 → 纯函数判据）。
 *
 * 走读盘而非复用内存里的 XML，是为了核验「落盘产物本身」——写盘/压缩/原子写
 * 引入的问题也能被抓住。
 *
 * @param input.docxPath 待核验的 `.docx` 路径。
 * @param input.expected 期望值：渲染路径传调用方的 `parts` 与模板 id（模板 id 用于母版对拍）。
 * @param input.residueMarkers 内部标记词表；不传即不检查（`info.residueMarkersChecked` 会如实报告）。
 */
export async function verifyApplicationDocx(input: {
  docxPath: string;
  expected?: { parts: Readonly<Record<string, string | undefined>>; template: DocumentTemplateId };
  residueMarkers?: readonly string[];
}): Promise<DocxVerifyResult> {
  const zip = await JSZip.loadAsync(await readFile(input.docxPath));
  const actual = await loadPackage(zip);

  let expected: VerifyApplicationDocxPackageInput["expected"];
  if (input.expected !== undefined) {
    // 母版本身读不出来（文件缺失/损坏）不算核验结论，故只在拿得到时才做对拍。
    const templatePath = resolveTemplateDocxPath(input.expected.template);
    const templateRef =
      templatePath === undefined ? undefined : await loadPackage(await JSZip.loadAsync(await readFile(templatePath)));
    expected = {
      parts: input.expected.parts,
      ...(templateRef === undefined ? {} : { template: templateRef }),
    };
  }

  return verifyApplicationDocxPackage({
    documentXml: actual.documentXml,
    relationshipsXml: actual.relationshipsXml,
    readPart: actual.readPart,
    ...(expected === undefined ? {} : { expected }),
    ...(input.residueMarkers === undefined ? {} : { residueMarkers: input.residueMarkers }),
  });
}
