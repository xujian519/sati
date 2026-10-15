/**
 * 申请文件模板契约：把上传的国知局五件套 `.docx` 模板解析成「可用版面 + 五个件」。
 *
 * 模板提供的是**版面与样式**（A4 纸张、页边距、五个分节各自的页眉页脚与页码域、
 * 正文/标题样式），正文是空的。本模块只做纯 XML 解析与重建，不落盘、
 * 不引入 docx 依赖，便于直接单测。
 *
 * 五个件按**模板页眉标题**对齐（说明书摘要 / 摘要附图 / 权利要求书 / 说明书 / 说明书附图），
 * 不按位置硬编码——模板若调换分节顺序，输出仍然正确；模板若缺件，调用方 fail-closed。
 * 模板里不属于五件套的分节**原样保留**（含其原有正文），只替换五件的内容。
 */

import { EMU_PER_TWIP } from "./ooxml.js";

/** 申请文件里「件」的标识：即 `sections` 映射里 docx 侧使用的键。 */
export type ApplicationPartId = "abstract" | "abstract-figure" | "claims" | "specification" | "drawings";

/** 件与模板页眉标题的对应关系。 */
export type ApplicationPart = {
  id: ApplicationPartId;
  /** 模板页眉中的标题（**精确**匹配，避免「说明书摘要」被「说明书」吸收）。 */
  headerTitle: string;
  /** 人类可读说明，用于错误与告警文案。 */
  label: string;
};

/** 五件套顺序即为国知局申请文件的提交顺序。 */
export const APPLICATION_PARTS: readonly ApplicationPart[] = [
  { id: "abstract", headerTitle: "说明书摘要", label: "说明书摘要" },
  { id: "abstract-figure", headerTitle: "摘要附图", label: "摘要附图" },
  { id: "claims", headerTitle: "权利要求书", label: "权利要求书" },
  { id: "specification", headerTitle: "说明书", label: "说明书" },
  { id: "drawings", headerTitle: "说明书附图", label: "说明书附图" },
];

/** 模板中的一个分节。 */
export type TemplateSection = {
  /** 该节「默认」页眉的标题文本；模板未提供可读页眉时为空串。 */
  headerTitle: string;
  /** 该节原有正文（顶层 `w:p` / `w:tbl` 原文拼接），用于保留非五件套分节。 */
  contentXml: string;
  /** 该节收尾原文：内联 `w:sectPr` 的段落（前四节），或文末 body 级 `w:sectPr`（末节）。 */
  boundaryXml: string;
};

/** A4 默认版面（twip），作为模板字段缺失时的兜底。 */
const A4_WIDTH_TWIPS = 11906;
const A4_HEIGHT_TWIPS = 16838;
const DEFAULT_MARGIN_TWIPS = 1440;

/** 顶层块容器标签：用于把 body 切成顶层元素。 */
const TOP_LEVEL_CONTAINERS = new Set(["w:p", "w:tbl"]);

const TAG_PATTERN = /<(\/?)([A-Za-z0-9:]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

const SECT_PR_PATTERN = /<w:sectPr(?:\s[^>]*)?>[\s\S]*?<\/w:sectPr>|<w:sectPr(?:\s[^>]*)?\/>/;

/** 把 `w:body` 切成前缀 / 顶层元素 / 后缀。 */
export function splitDocumentBody(documentXml: string): {
  prefix: string;
  elements: string[];
  suffix: string;
} {
  const open = /<w:body(?:\s[^>]*)?>/.exec(documentXml);
  const closeIndex = documentXml.lastIndexOf("</w:body>");
  if (open === null || closeIndex === -1) {
    throw new Error("docx 模板缺少 <w:body> 结构");
  }
  const openEnd = open.index + open[0].length;
  return {
    prefix: documentXml.slice(0, openEnd),
    elements: topLevelElements(documentXml.slice(openEnd, closeIndex)),
    suffix: documentXml.slice(closeIndex),
  };
}

/** 深度感知地切出顶层 `w:p` / `w:tbl` 元素（表格单元格里的段落不会被误切）。 */
export function topLevelElements(bodyInner: string): string[] {
  const elements: string[] = [];
  let depth = 0;
  let start = -1;
  TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_PATTERN.exec(bodyInner)) !== null) {
    const isClosing = match[1] === "/";
    const name = match[2] ?? "";
    const isSelfClosing = match[4] === "/";
    if (!TOP_LEVEL_CONTAINERS.has(name)) continue;
    if (isClosing) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        elements.push(bodyInner.slice(start, match.index + match[0].length));
        start = -1;
      }
      continue;
    }
    if (isSelfClosing) continue;
    if (depth === 0) start = match.index;
    depth += 1;
  }
  return elements;
}

/** 取出元素内的 `w:sectPr` 原文（含标签）；无分节属性时返回 `undefined`。 */
export function extractSectionProperties(elementXml: string): string | undefined {
  return SECT_PR_PATTERN.exec(elementXml)?.[0];
}

/** 取出段落 `w:pPr` 的内层 XML（不含 `w:pPr` 标签本身）。 */
export function paragraphPropertiesXml(paragraphXml: string): string | undefined {
  return /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(paragraphXml)?.[1];
}

/**
 * 从模板正文派生「正文段落属性」——取第一个不含分节属性的顶层段落。
 * 模板作者对正文行的行距/缩进设定（如 `w:line="360"`、`firstLine=0`）由此进入生成内容；
 * 模板未提供时返回 `undefined`，由调用方决定兜底。
 */
export function deriveBodyParagraphProps(documentXml: string): string | undefined {
  const { elements } = splitDocumentBody(documentXml);
  for (const element of elements) {
    if (!element.startsWith("<w:p")) continue;
    if (extractSectionProperties(element) !== undefined) continue;
    const props = paragraphPropertiesXml(element);
    if (props !== undefined && props.trim() !== "") return props;
  }
  return undefined;
}

/**
 * 从 styles.xml 派生标题段落样式 id：取 `w:type="paragraph"` 且带 `outlineLvl=0` 的样式。
 * 模板用的是 `heading 1`（styleId "2"）；不写死 id，模板换样式 id 也不影响。
 */
export function deriveTitleStyleId(stylesXml: string): string | undefined {
  const pattern = /<w:style\b((?:"[^"]*"|'[^']*'|[^>"'])*?)>([\s\S]*?)<\/w:style>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stylesXml)) !== null) {
    const attributes = match[1] ?? "";
    if (!/w:type="paragraph"/.test(attributes)) continue;
    if (!/<w:outlineLvl\b[^>]*w:val="0"/.test(match[2] ?? "")) continue;
    const styleId = /w:styleId="([^"]+)"/.exec(attributes);
    if (styleId?.[1] !== undefined) return styleId[1];
  }
  return undefined;
}

/** 从 sectPr 读版面可用尺寸（EMU），用于图片与表格宽度。 */
export function readContentArea(sectPrXml: string | undefined): { widthEmu: number; heightEmu: number } {
  const pageSize = sectPrXml === undefined ? null : /<w:pgSz\b([^>]*)\/>/.exec(sectPrXml);
  const margins = sectPrXml === undefined ? null : /<w:pgMar\b([^>]*)\/>/.exec(sectPrXml);
  const width = numberAttribute(pageSize?.[1] ?? "", "w:w") ?? A4_WIDTH_TWIPS;
  const height = numberAttribute(pageSize?.[1] ?? "", "w:h") ?? A4_HEIGHT_TWIPS;
  const left = numberAttribute(margins?.[1] ?? "", "w:left") ?? DEFAULT_MARGIN_TWIPS;
  const right = numberAttribute(margins?.[1] ?? "", "w:right") ?? DEFAULT_MARGIN_TWIPS;
  const top = numberAttribute(margins?.[1] ?? "", "w:top") ?? DEFAULT_MARGIN_TWIPS;
  const bottom = numberAttribute(margins?.[1] ?? "", "w:bottom") ?? DEFAULT_MARGIN_TWIPS;
  return {
    widthEmu: Math.max(1, width - left - right) * EMU_PER_TWIP,
    heightEmu: Math.max(1, height - top - bottom) * EMU_PER_TWIP,
  };
}

function numberAttribute(attributes: string, name: string): number | undefined {
  const match = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}="(\\d+)"`).exec(attributes);
  if (match?.[1] === undefined) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
}

/** 关系表里「页眉」的 rId → 目标文件名。 */
export function headerTargetsByRelId(relationshipsXml: string): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = /<Relationship\b((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(relationshipsXml)) !== null) {
    const attributes = match[1] ?? "";
    if (!/relationships\/header"/.test(attributes)) continue;
    const id = /Id="([^"]+)"/.exec(attributes);
    const target = /Target="([^"]+)"/.exec(attributes);
    if (id?.[1] === undefined || target?.[1] === undefined) continue;
    result.set(id[1], target[1]);
  }
  return result;
}

/** 关系表里出现的最大 rId 数字（新增关系从此之后编号，避免撞号）。 */
export function maxRelationshipId(relationshipsXml: string): number {
  let max = 0;
  const pattern = /\bId="rId(\d+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(relationshipsXml)) !== null) {
    const value = Number.parseInt(match[1] ?? "0", 10);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}

/** 取分节里指定类型（default/first/even）的页眉 rId。 */
export function headerRelId(sectPrXml: string, type: "default" | "first" | "even"): string | undefined {
  const pattern = /<w:headerReference\b((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sectPrXml)) !== null) {
    const attributes = match[1] ?? "";
    if (!new RegExp(`w:type="${type}"`).test(attributes)) continue;
    return /r:id="([^"]+)"/.exec(attributes)?.[1];
  }
  return undefined;
}

/** 从 XML 片段里抽出全部文本（用于读页眉标题）。 */
export function extractText(xml: string): string {
  let out = "";
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) out += match[1] ?? "";
  return out
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** 包内路径规范化：关系表 Target 可能形如 `headers/h1.xml` 或 `/word/headers/h1.xml`。 */
export function toPackagePath(target: string): string {
  return target.startsWith("/") ? target.slice(1) : `word/${target}`;
}

/**
 * 解析模板为分节序列（含每节原文、收尾原文与页眉标题），保持模板中的物理顺序。
 * `readPart` 按包内路径读取页眉 XML（见 `toPackagePath`）。
 */
export function parseTemplateSections(
  documentXml: string,
  relationshipsXml: string,
  readPart: (packagePath: string) => string | undefined,
): TemplateSection[] {
  const { elements } = splitDocumentBody(documentXml);
  const relTargets = headerTargetsByRelId(relationshipsXml);

  const titleOf = (sectPrXml: string): string => {
    const relId = headerRelId(sectPrXml, "default");
    if (relId === undefined) return "";
    const target = relTargets.get(relId);
    if (target === undefined) return "";
    return extractText(readPart(toPackagePath(target)) ?? "");
  };

  const sections: TemplateSection[] = [];
  let pending: string[] = [];
  for (const element of elements) {
    const sectPr = extractSectionProperties(element);
    if (sectPr === undefined) {
      pending.push(element);
      continue;
    }
    sections.push({
      // 内联 sectPr 就挂在该段的 pPr 上，故这一整段即该节的收尾原文。
      boundaryXml: element,
      contentXml: pending.join(""),
      headerTitle: titleOf(sectPr),
    });
    pending = [];
  }

  // 文末 body 级 sectPr 不隶属于任何段落，单独收成一节。
  const tail = tailSectionProperties(documentXml);
  if (tail !== undefined) {
    sections.push({ boundaryXml: tail, contentXml: pending.join(""), headerTitle: titleOf(tail) });
  }

  return sections;
}

/** 取 body 末尾（最后一个顶层段落之后）的 `w:sectPr`——末节的版面设置。 */
function tailSectionProperties(documentXml: string): string | undefined {
  // 顶层元素切分只收 `w:p` / `w:tbl`，文末 sectPr 不在其中，故在 body 尾部文本里单独找。
  const closeIndex = documentXml.lastIndexOf("</w:body>");
  if (closeIndex === -1) return undefined;
  const lastParagraph = documentXml.lastIndexOf("</w:p>", closeIndex);
  if (lastParagraph === -1) return undefined;
  const tail = documentXml.slice(lastParagraph + "</w:p>".length, closeIndex);
  return SECT_PR_PATTERN.exec(tail)?.[0];
}

/** 分节编排结果：模板顺序不变，逐节标出对应哪一件（未对应者保留原文）。 */
export type SectionPlan = {
  entries: { section: TemplateSection; part: ApplicationPart | undefined }[];
  /** 模板中找不到分节的件。 */
  missingParts: ApplicationPart[];
  /** 模板里不属于五件套的分节（内容将原样保留）。 */
  extraSections: TemplateSection[];
};

/** 按页眉标题**精确**匹配五件套；无标题的分节一律视为模板额外分节。 */
export function planSections(sections: readonly TemplateSection[]): SectionPlan {
  const claimed = new Array<ApplicationPart | undefined>(sections.length).fill(undefined);
  const missingParts: ApplicationPart[] = [];

  for (const part of APPLICATION_PARTS) {
    const index = sections.findIndex(
      (section, i) =>
        claimed[i] === undefined && section.headerTitle !== "" && section.headerTitle === part.headerTitle,
    );
    if (index === -1) {
      missingParts.push(part);
      continue;
    }
    claimed[index] = part;
  }

  const entries = sections.map((section, index) => ({ section, part: claimed[index] }));
  return {
    entries,
    missingParts,
    extraSections: entries.filter(entry => entry.part === undefined).map(entry => entry.section),
  };
}

/**
 * 重建 body 内容：按模板分节顺序拼内容，收尾原文原样保留。
 *
 * 返回的是 `w:body` 的**内层** XML（不含 `<w:body>` 标签本身）——
 * 调用方用 `splitDocumentBody()` 的前缀/后缀把它夹回 `w:document`。
 */
export function buildApplicationBodyContent(
  pieces: readonly { section: TemplateSection; contentXml: string }[],
): string {
  return pieces
    .map(({ section, contentXml }) => {
      // `w:tbl` 不能是容器末元素，故表格结尾补一个空段落。
      const content = contentXml === "" || contentXml.endsWith("</w:tbl>") ? `${contentXml}<w:p/>` : contentXml;
      return `${content}${section.boundaryXml}`;
    })
    .join("");
}
