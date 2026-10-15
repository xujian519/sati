/**
 * 申请文件 docx 渲染：以随模板分发的 `.docx` 母版为版面，把五件套内容写进对应分节。
 *
 * 母版负责**版面与样式**（A4、页边距、每节页眉页脚与页码域、正文/标题样式），
 * 本模块只做三件事：① 复用母版的整包（页眉页脚/样式/主题/页面设置一律不动）；
 * ② 按件重建 `w:body` 的正文段落；③ 为内容里的图片补 media / 关系 / 内容类型。
 *
 * 模板缺件时 fail-closed（`SatiDocumentInputError`）——宁可报错，也不产出缺件的申请文件。
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { SatiDocumentInputError } from "../errors.js";
import { resolveTemplateDocxPath } from "../templateResolver.js";
import type { DocumentTemplateId } from "../types.js";
import {
  APPLICATION_PARTS,
  buildApplicationBodyContent,
  deriveBodyParagraphProps,
  deriveTitleStyleId,
  extractSectionProperties,
  maxRelationshipId,
  parseTemplateSections,
  planSections,
  readContentArea,
  splitDocumentBody,
} from "./applicationTemplate.js";
import { htmlToBlocks } from "./htmlToOoxml.js";
import { decodeDataUri, probeImage, type ImageProbe } from "./imageInfo.js";
import {
  fitImage,
  renderBlocks,
  resolveBlocks,
  type OoxmlRenderContext,
  type ParsedBlock,
  type ParsedRun,
  type ReadyBlock,
  type ReadyRun,
} from "./ooxml.js";

/** 模板未给出正文段落属性时的兜底（1.5 倍行距、首行不缩进）。 */
const FALLBACK_BODY_PPR = '<w:spacing w:line="360" w:lineRule="auto"/><w:ind w:firstLine="0" w:firstLineChars="0"/>';

/** 渲染请求。 */
export type RenderApplicationDocxInput = {
  /** 模板 id（需随模板分发了 `assets/template.docx`）。 */
  template: DocumentTemplateId;
  /** 输出 docx 的绝对路径。 */
  outputPath: string;
  /** 件 id → HTML 片段（无标签时按换行拆段）。 */
  parts: Readonly<Record<string, string | undefined>>;
  /** 工作目录：解析内容里图片的相对路径。 */
  cwd: string;
};

/** 渲染结果。 */
export type RenderApplicationDocxResult = {
  /** 非致命告警（图片未嵌入、无件内容等）。 */
  warnings: string[];
};

/** 包内已注册的一张图片。 */
type MediaEntry = {
  packagePath: string;
  mediaName: string;
  relId: string;
  probe: ImageProbe;
};

/** 渲染时累积的包修改。 */
type PackagePatch = {
  media: { path: string; bytes: Uint8Array }[];
  relationships: { id: string; target: string }[];
  contentTypes: Map<string, string>;
};

async function readZipText(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  if (file === null) throw new Error(`docx 母版缺少 ${name}`);
  return file.async("string");
}

/** 从 `file://`、绝对路径、相对路径或 data URI 载入图片字节。 */
async function loadImageBytes(src: string, cwd: string): Promise<Uint8Array | undefined> {
  const trimmed = src.trim();
  const inline = decodeDataUri(trimmed);
  if (inline !== undefined) return inline.bytes;
  if (/^(?:https?|ftp):/i.test(trimmed)) return undefined; // 不联网取图
  let filePath = trimmed;
  if (trimmed.startsWith("file://")) {
    try {
      filePath = fileURLToPath(trimmed);
    } catch {
      // 非法 file:// URI 按「取不到图」处理：调用方统一告警，不阻塞文档生成。
      return undefined;
    }
  } else if (!isAbsolute(trimmed)) {
    filePath = resolve(cwd, trimmed);
  }
  try {
    return await readFile(filePath);
  } catch {
    // 文件不存在/无权限 = 取不到图：向上返回 undefined 交由调用方汇总告警。
    return undefined;
  }
}

/** 递归收集块结构里出现的图片源（去重、保持出现顺序）。 */
export function collectImageSources(blocks: readonly ParsedBlock[], into: Set<string> = new Set()): Set<string> {
  for (const block of blocks) {
    if (block.kind === "paragraph") {
      for (const run of block.runs) {
        if (run.kind === "image" && run.src.trim() !== "") into.add(run.src);
      }
      continue;
    }
    for (const row of block.rows) {
      for (const cell of row) collectImageSources(cell.blocks, into);
    }
  }
  return into;
}

/** 把内容类型条目插到 `</Types>` 之前（已存在同扩展名时不重复）。 */
function patchContentTypes(xml: string, extensions: ReadonlyMap<string, string>): string {
  const additions = [...extensions.entries()]
    .filter(([ext]) => !new RegExp(`Extension="${ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(xml))
    .map(([ext, contentType]) => `<Default Extension="${ext}" ContentType="${contentType}"/>`)
    .join("");
  if (additions === "") return xml;
  const closeIndex = xml.lastIndexOf("</Types>");
  if (closeIndex === -1) throw new Error("docx 母版的 [Content_Types].xml 结构异常");
  return `${xml.slice(0, closeIndex)}${additions}${xml.slice(closeIndex)}`;
}

/** 把图片关系插到 `</Relationships>` 之前。 */
function patchRelationships(xml: string, relationships: readonly { id: string; target: string }[]): string {
  if (relationships.length === 0) return xml;
  const additions = relationships
    .map(
      rel =>
        `<Relationship Id="${rel.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${rel.target}"/>`,
    )
    .join("");
  const closeIndex = xml.lastIndexOf("</Relationships>");
  if (closeIndex === -1) throw new Error("docx 母版的 document.xml.rels 结构异常");
  return `${xml.slice(0, closeIndex)}${additions}${xml.slice(closeIndex)}`;
}

/** 二进制原子写（先写临时文件再 rename；Windows 上 rename 不覆盖已存在文件）。 */
async function atomicWriteBinary(file: string, content: Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, content);
  await rm(file, { force: true });
  await rename(tmp, file);
}

/**
 * 渲染申请文件 docx。
 *
 * `parts` 的键见 `APPLICATION_PARTS`（abstract / abstract-figure / claims / specification / drawings）；
 * 其余键忽略（HTML 路径的 section id 与件 id 不同名，属正常情况，故不告警）。
 */
export async function renderApplicationDocx(input: RenderApplicationDocxInput): Promise<RenderApplicationDocxResult> {
  const warnings: string[] = [];
  const templatePath = resolveTemplateDocxPath(input.template);
  if (templatePath === undefined) {
    throw new SatiDocumentInputError(
      `模板 "${input.template}" 未提供 docx 母版（缺少 assets/template.docx），无法输出 docx 申请文件`,
    );
  }

  const zip = await JSZip.loadAsync(await readFile(templatePath));
  const documentXml = await readZipText(zip, "word/document.xml");
  const relationshipsXml = await readZipText(zip, "word/_rels/document.xml.rels");
  const stylesXml = await readZipText(zip, "word/styles.xml");
  const contentTypesXml = await readZipText(zip, "[Content_Types].xml");

  const headerParts = new Map<string, string>();
  for (const name of Object.keys(zip.files)) {
    if (!/^word\/header[^/]*\.xml$/.test(name)) continue;
    const file = zip.file(name);
    if (file !== null) headerParts.set(name, await file.async("string"));
  }

  const sections = parseTemplateSections(documentXml, relationshipsXml, name => headerParts.get(name));
  const plan = planSections(sections);
  if (plan.missingParts.length > 0) {
    const found = sections.map(section => section.headerTitle).filter(title => title !== "");
    throw new SatiDocumentInputError(
      `docx 母版缺少下列件的分节（按页眉标题匹配）: ${plan.missingParts.map(part => part.label).join("、")}；` +
        `模板检出页眉: ${found.length > 0 ? found.join(" / ") : "(无)"}`,
    );
  }
  if (plan.extraSections.length > 0) {
    warnings.push(`docx 母版含 ${plan.extraSections.length} 个不属于五件套的分节，其内容按模板原样保留（无页眉标题）`);
  }

  const bodyPPrXml = deriveBodyParagraphProps(documentXml) ?? FALLBACK_BODY_PPR;
  const titleStyleId = deriveTitleStyleId(stylesXml) ?? "";
  const firstBoundary = plan.entries[0]?.section.boundaryXml ?? "";
  const contentArea = readContentArea(extractSectionProperties(firstBoundary));

  // 逐件解析内容（图片先统一登记，再在渲染期接线，保持同步的渲染接口）。
  const partBlocks = new Map<string, ParsedBlock[]>();
  for (const part of APPLICATION_PARTS) {
    const html = input.parts[part.id];
    partBlocks.set(part.id, html === undefined ? [] : htmlToBlocks(html));
  }
  const providedParts = APPLICATION_PARTS.filter(part => (input.parts[part.id] ?? "").trim() !== "");
  if (providedParts.length === 0) {
    warnings.push(`sections 未包含任何申请文件件内容（可用键: ${APPLICATION_PARTS.map(part => part.id).join(" / ")}）`);
  }

  const patch: PackagePatch = { media: [], relationships: [], contentTypes: new Map() };
  const allSources = new Set<string>();
  for (const blocks of partBlocks.values()) collectImageSources(blocks, allSources);

  let nextRelId = maxRelationshipId(relationshipsXml) + 1;
  let nextMediaIndex = 1;
  const mediaBySrc = new Map<string, MediaEntry>();
  for (const src of allSources) {
    const bytes = await loadImageBytes(src, input.cwd);
    if (bytes === undefined) {
      warnings.push(`图片未能嵌入（无法读取，已跳过）: ${src}`);
      continue;
    }
    const probe = probeImage(bytes);
    if (probe === undefined) {
      warnings.push(`图片格式不受支持（已跳过，仅支持 PNG/JPEG/GIF/BMP）: ${src}`);
      continue;
    }
    const mediaName = `image${nextMediaIndex}.${probe.ext}`;
    nextMediaIndex += 1;
    const relId = `rId${nextRelId}`;
    nextRelId += 1;
    mediaBySrc.set(src, { packagePath: `word/media/${mediaName}`, mediaName, relId, probe });
    patch.media.push({ path: `word/media/${mediaName}`, bytes });
    patch.relationships.push({ id: relId, target: `media/${mediaName}` });
    patch.contentTypes.set(probe.ext, probe.contentType);
  }

  let nextDocPrId = 1;
  const resolveRun = (run: ParsedRun): ReadyRun => {
    if (run.kind === "text") return run;
    const media = mediaBySrc.get(run.src);
    if (media === undefined) return { kind: "text", text: "" };
    const size = fitImage(media.probe.widthPx, media.probe.heightPx, contentArea.widthEmu, contentArea.heightEmu);
    const ready: ReadyRun = {
      kind: "image",
      mediaName: media.mediaName,
      relId: media.relId,
      docPrId: nextDocPrId,
      widthEmu: size.widthEmu,
      heightEmu: size.heightEmu,
      alt: run.alt,
    };
    nextDocPrId += 1;
    return ready;
  };

  const context: OoxmlRenderContext = {
    bodyPPrXml,
    titleStyleId,
    contentWidthEmu: contentArea.widthEmu,
  };

  const contentByPart = new Map<string, string>();
  for (const part of APPLICATION_PARTS) {
    const blocks: ReadyBlock[] = resolveBlocks(partBlocks.get(part.id) ?? [], resolveRun);
    contentByPart.set(part.id, renderBlocks(blocks, context));
  }

  const { prefix, suffix } = splitDocumentBody(documentXml);
  const bodyContent = buildApplicationBodyContent(
    plan.entries.map(entry => ({
      section: entry.section,
      contentXml: entry.part === undefined ? entry.section.contentXml : (contentByPart.get(entry.part.id) ?? ""),
    })),
  );

  zip.file("word/document.xml", `${prefix}${bodyContent}${suffix}`);
  zip.file("[Content_Types].xml", patchContentTypes(contentTypesXml, patch.contentTypes));
  zip.file("word/_rels/document.xml.rels", patchRelationships(relationshipsXml, patch.relationships));
  // createFolders=false：不产出 `word/media/` 这类目录条目，包内只留真实文件。
  for (const media of patch.media) zip.file(media.path, media.bytes, { createFolders: false });

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await atomicWriteBinary(input.outputPath, buffer);

  return { warnings };
}

/** 供上层复用：件 id 列表（工具描述与告警文案与契约同源）。 */
export const APPLICATION_DOCX_PART_IDS: readonly string[] = APPLICATION_PARTS.map(part => part.id);
