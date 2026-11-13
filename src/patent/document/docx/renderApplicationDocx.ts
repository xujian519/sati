/**
 * 申请文件 docx 渲染：以随模板分发的 `.docx` 母版为版面，把五件套内容写进对应分节。
 *
 * 母版负责**版面与样式**（A4、页边距、每节页眉页脚与页码域、正文/标题样式），
 * 本模块只做三件事：① 复用母版的整包（页眉页脚/样式/主题/页面设置一律不动）；
 * ② 按件重建 `w:body` 的正文段落；③ 为内容里的图片补 media / 关系 / 内容类型。
 *
 * **矢量附图（SVG）**：OOXML 的图片关系只认位图，故 SVG 先经 `figureRaster.ts`
 * 栅格化成 PNG（300 DPI 等效）再嵌入；栅格化失败不阻塞整份文档，但告警写明
 * 「SVG 栅格化失败：<原因>」，与「文件缺失」区分开。
 *
 * **每图一页**：附图节按「每图一页」插段前分页（`<w:pageBreakBefore/>`），
 * 分页点落在**下一幅图所在段落之前**（图与它的图号留在同一页）。
 * 该开关只改段属性里的 `w:pageBreakBefore` 一项，母版段落的其它属性不动。
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
import { rasterizeFigureSvg, rasterizeFigureSvgText } from "./figureRaster.js";
import { decodeDataUri, looksLikeSvg, probeImage, type ImageProbe } from "./imageInfo.js";
import {
  fitImage,
  figureCaptionNumber,
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

/** 已载入的图片源。 */
type LoadedImage = {
  /** 图片字节。 */
  bytes: Uint8Array;
  /** 磁盘路径；data URI 没有路径（矢量图栅格化需要真实文件，故另记）。 */
  path?: string;
};

/** 从 `file://`、绝对路径、相对路径或 data URI 载入图片。 */
async function loadImageSource(src: string, cwd: string): Promise<LoadedImage | undefined> {
  const trimmed = src.trim();
  const inline = decodeDataUri(trimmed);
  if (inline !== undefined) return { bytes: inline.bytes };
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
    return { bytes: await readFile(filePath), path: filePath };
  } catch {
    // 文件不存在/无权限 = 取不到图：向上返回 undefined 交由调用方汇总告警。
    return undefined;
  }
}

/**
 * 把矢量附图栅格化成 PNG（OOXML 的图片关系只认位图，SVG 进不去）。
 *
 * 失败不阻塞整份文档，但**告警必须区分于「文件缺失」**：这里写明
 * 「SVG 栅格化失败：<原因>」，否则消费方会把「图没转成位图」误当成「图不存在」。
 * @param loaded - 已载入的图片源。
 * @param src - 图片来源（仅用于告警文案）。
 * @param warnings - 告警累加器。
 * @returns PNG 字节与探测结果；失败返回 undefined（告警已写入）。
 */
async function rasterizeSvgForEmbedding(
  loaded: LoadedImage,
  src: string,
  warnings: string[],
): Promise<{ bytes: Uint8Array; probe: ImageProbe } | undefined> {
  try {
    const raster =
      loaded.path !== undefined
        ? await rasterizeFigureSvg(loaded.path)
        : await rasterizeFigureSvgText(new TextDecoder("utf-8", { fatal: false }).decode(loaded.bytes));
    const probe = probeImage(raster.bytes);
    if (probe === undefined) {
      warnings.push(`图片未能嵌入（SVG 栅格化失败：产物不是可识别的位图，已跳过）: ${src}`);
      return undefined;
    }
    if (raster.degraded !== undefined) {
      // 降级但不静默：走了回退路径（sharp 失败→Chrome 等）必须让消费方看得见。
      warnings.push(`图片以降级路径栅格化（${raster.degraded.reason}）: ${src}`);
    }
    return { bytes: raster.bytes, probe };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnings.push(`图片未能嵌入（SVG 栅格化失败：${reason}，已跳过）: ${src}`);
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

/** 段落块里的内联图数量（表格块里的图不算——附图节的一页一幅图是段落级事实）。 */
function blockImageCount(block: ReadyBlock): number {
  if (block.kind !== "paragraph") return 0;
  return block.runs.filter(run => run.kind === "image").length;
}

/** 段落块的纯文本（图片 run 不贡献文字）。 */
function blockPlainText(block: ReadyBlock): string {
  if (block.kind !== "paragraph") return "";
  return block.runs
    .filter(run => run.kind === "text")
    .map(run => run.text)
    .join("");
}

/**
 * 附图节的「每图一页」分页点：标出**下一幅图所在段落**需要段前分页。
 *
 * **分页点落在图与图之间，不落在「图」与「它的图号」之间**：图号文字按**序号**归属到
 * 对应的那幅图（`图2` 归属第 2 幅图），于是
 *
 * - 「图在前、图号在后」（`<p><img/></p><p>图1</p>`）与
 * - 「图号在前、图在后」（`<p>图1</p><p><img/></p>`）
 *
 * 两种常见写法都会把图与它的图号留在同一页：分页点取「该图组的**首个**块」，
 * 即图号在前时落在图号段之前，图号在后时落在图段之前。
 *
 * 组内其它正文段落（说明文字等）归入**最近的一幅图**，随该图留在同一页，
 * 不会被分页符切碎。
 *
 * **图的计数单位是「幅」而不是「段」**：一段里塞了两幅图时它们无法被段前分页隔开
 * （拆段会改动版面），故这种情况只在该段之前分页，核验侧会如实报出「同一段落内」。
 *
 * @param blocks 附图节的块序列（顶层）。
 * @returns 标好 `pageBreakBefore` 的块序列（少于两幅图时原样返回）。
 */
export function markFigurePageBreaks(blocks: readonly ReadyBlock[]): ReadyBlock[] {
  const imageCounts = blocks.map(block => blockImageCount(block));
  const totalImages = imageCounts.reduce((sum, count) => sum + count, 0);
  // 少于两幅图时「每图一页」无判据可依（无需分页符），不改动任何段落。
  if (totalImages < 2) return [...blocks];

  // 图组 = 含图的段落；一组可能含多幅图（同一段落里的多张图）。
  // groupOfImage[图序号] = 该图所属的组号；groupStart[组号] = 该组首个块下标。
  const groupOfImage: number[] = [];
  const groupStart: number[] = [];
  let group = 0;
  for (const [index, count] of imageCounts.entries()) {
    if (count === 0) continue;
    group += 1;
    groupStart[group] = index;
    for (let i = 0; i < count; i += 1) groupOfImage.push(group);
  }

  // 图号文字按**图序号**归属：找到含该序号那幅图的组，把图号段并进该组。
  // 图号写在图前时，组的首个块因此前移到图号段 ⇒ 分页点落在图号之前。
  const captionOwner = new Array<number>(blocks.length).fill(0);
  for (const [index, block] of blocks.entries()) {
    if (imageCounts[index] !== 0) continue;
    const caption = figureCaptionNumber(blockPlainText(block));
    if (caption === undefined) continue;
    const owner = groupOfImage[caption - 1];
    if (owner === undefined) continue;
    captionOwner[index] = owner;
    groupStart[owner] = Math.min(groupStart[owner], index);
  }
  // 组内其它正文段落（说明文字等）归入**最近的一幅图**，随该图留在同一页。
  let lastGroup = 0;
  for (const [index, count] of imageCounts.entries()) {
    if (count > 0) {
      lastGroup = groupOfImage[groupOfImage.length - count] ?? lastGroup;
      continue;
    }
    if (captionOwner[index] !== 0) continue; // 图号已按序号归属，不再就近归属
    const owner = lastGroup === 0 ? 1 : lastGroup;
    groupStart[owner] = Math.min(groupStart[owner], index);
  }

  const marked = [...blocks];
  // 第 1 组不加分页符（附图节本身另起一页），其余每组一个分页符。
  for (let index = 2; index < groupStart.length; index += 1) {
    const start = groupStart[index];
    if (start === undefined) continue;
    const block = marked[start];
    if (block === undefined || block.kind !== "paragraph") continue;
    marked[start] = { ...block, pageBreakBefore: true };
  }
  return marked;
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
    const loaded = await loadImageSource(src, input.cwd);
    if (loaded === undefined) {
      warnings.push(`图片未能嵌入（无法读取，已跳过）: ${src}`);
      continue;
    }
    const probe = probeImage(loaded.bytes);
    // SVG 按**内容**判定（不看尺寸）：尺寸不可判定的 SVG（无 width/height 也无 viewBox）
    // 探不出尺寸，但仍要先按矢量图处理——失败原因要报「SVG 栅格化失败」，
    // 不是笼统的「图片格式不受支持」（后者会让人以为文件根本不是图）。
    const isSvg = looksLikeSvg(loaded.bytes);
    let mediaBytes: Uint8Array;
    let mediaProbe: ImageProbe;
    if (isSvg) {
      // 矢量附图必须先栅格化：OOXML 的图片关系只认位图，SVG 会被 Word 拒收。
      const rasterized = await rasterizeSvgForEmbedding(loaded, src, warnings);
      if (rasterized === undefined) continue;
      mediaBytes = rasterized.bytes;
      mediaProbe = rasterized.probe;
    } else {
      if (probe === undefined) {
        warnings.push(`图片格式不受支持（已跳过，仅支持 PNG/JPEG/GIF/BMP/SVG）: ${src}`);
        continue;
      }
      mediaBytes = loaded.bytes;
      mediaProbe = probe;
    }
    const mediaName = `image${nextMediaIndex}.${mediaProbe.ext}`;
    nextMediaIndex += 1;
    const relId = `rId${nextRelId}`;
    nextRelId += 1;
    mediaBySrc.set(src, { packagePath: `word/media/${mediaName}`, mediaName, relId, probe: mediaProbe });
    patch.media.push({ path: `word/media/${mediaName}`, bytes: mediaBytes });
    patch.relationships.push({ id: relId, target: `media/${mediaName}` });
    patch.contentTypes.set(mediaProbe.ext, mediaProbe.contentType);
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
    const resolved: ReadyBlock[] = resolveBlocks(partBlocks.get(part.id) ?? [], resolveRun);
    // 附图节按「每图一页」插分页符：分页点落在下一幅图所在段落之前（图与图号不拆开）。
    const blocks = part.id === "drawings" ? markFigurePageBreaks(resolved) : resolved;
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
